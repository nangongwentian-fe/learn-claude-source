# S09: Streaming (流式处理)

> **核心洞察**：`async function*` (异步生成器) 是 Claude Code 的核心编程范式。从 API 响应到工具执行，一切都是流式的 —— 用户看到的是"打字机效果"，背后是一套精心设计的流式管线。

## 核心问题

如果等 LLM 生成完整响应后再显示，用户会看到一个漫长的空白等待。流式处理解决三个问题：
1. **即时反馈** —— 用户能看到 Agent 正在"思考"和"打字"
2. **及时中断** —— 用户可以随时 Ctrl+C，不需要等完整响应
3. **并发执行** —— 工具可以在消息流式接收的同时开始执行

## 异步生成器入门

如果你不熟悉 `async function*`，这里是快速入门：

```typescript
// 普通函数：一次性返回
async function getData(): Promise<string[]> {
  const data = await fetchAll()
  return data  // 一次性返回全部
}

// 异步生成器：逐个产出
async function* streamData(): AsyncGenerator<string> {
  for (const item of items) {
    const data = await fetchOne(item)
    yield data  // 每次产出一个，调用方可以逐个处理
  }
}

// 消费方式
for await (const item of streamData()) {
  console.log(item)  // 收到一个处理一个
}
```

关键特性：
- **惰性** —— 消费者不要，生产者不产
- **可中断** —— `break` 或 `.return()` 随时终止
- **可组合** —— `yield*` 串联多个生成器

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/services/api/claude.ts` | API 流式响应处理 (~2800 行) |
| `src/query.ts` | 流式事件在 Agent Loop 中的传播 |
| `src/QueryEngine.ts` | 流式消息到 UI 的桥接 |
| `src/services/tools/StreamingToolExecutor.ts` | 并发工具执行 |

## 流式管线全景

```
Anthropic API (SSE)
  │ content_block_start
  │ content_block_delta (text_delta)
  │ content_block_delta (input_json_delta)
  │ content_block_stop
  │ message_delta (stop_reason)
  │ message_stop
  │
  ▼
claude.ts: queryModel()         ← Layer 1: API 流解析
  │ yield StreamEvent
  │ yield AssistantMessage
  │
  ▼
query.ts: queryLoop()           ← Layer 2: Agent Loop 调度
  │ yield StreamEvent → 转发给 UI (文本渲染)
  │ 收集 ToolUseBlock → 交给 StreamingToolExecutor
  │ yield Message (完整的 assistant/user 消息)
  │
  ▼
QueryEngine.ts: submitMessage() ← Layer 3: 会话管理
  │ yield SDKMessage → 外部消费者 (UI / SDK)
  │ 累积到 mutableMessages[]
  │ 触发会话持久化
  │
  ▼
UI (React/Ink)                  ← Layer 4: 终端渲染
  │ 文本块 → Markdown 渲染
  │ 工具调用 → 进度指示器
  │ 思考块 → 折叠显示
```

## Layer 1: API 流解析

```typescript
// src/services/api/claude.ts - 简化
async function* queryModel(
  messages: Message[],
  systemPrompt: string,
  tools: ToolDef[],
  signal: AbortSignal,
): AsyncGenerator<StreamEvent | AssistantMessage> {

  // 创建流式请求
  const stream = await client.messages.create({
    model: MODEL,
    system: systemPrompt,
    messages,
    tools,
    max_tokens: 16384,
    stream: true,  // 关键：启用流式
  })

  // 状态累积器
  const contentBlocks: ContentBlock[] = []
  let stopReason: string | null = null
  let usage = { input_tokens: 0, output_tokens: 0 }

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start':
        usage = event.message.usage
        // 记录首 token 延迟 (TTFT)
        const ttft = Date.now() - startTime
        yield { type: 'stream_event', event, ttft }
        break

      case 'content_block_start':
        // 新的内容块：text / tool_use / thinking
        contentBlocks[event.index] = {
          ...event.content_block,
          text: '',
          input: '',
        }
        yield { type: 'stream_event', event }
        break

      case 'content_block_delta':
        const block = contentBlocks[event.index]
        if (event.delta.type === 'text_delta') {
          block.text += event.delta.text
          // 实时向 UI 发送文本片段
          yield { type: 'stream_event', event }
        } else if (event.delta.type === 'input_json_delta') {
          // 工具输入的 JSON 片段 (不适合实时渲染)
          block.input += event.delta.partial_json
        }
        break

      case 'content_block_stop':
        // 内容块完成
        const completed = contentBlocks[event.index]
        if (completed.type === 'tool_use') {
          // 解析完整的工具输入 JSON
          completed.input = JSON.parse(completed.input)
        }
        yield { type: 'stream_event', event }
        break

      case 'message_delta':
        stopReason = event.delta.stop_reason
        usage = { ...usage, ...event.usage }
        yield { type: 'stream_event', event }
        break

      case 'message_stop':
        // 组装完整的 AssistantMessage
        yield {
          type: 'assistant',
          content: contentBlocks,
          stopReason,
          usage,
        }
        break
    }
  }
}
```

### 流式事件类型

```
时间 →

message_start ─── content_block_start ─── delta ─── delta ─── content_block_stop ─── message_delta ─── message_stop
                  │← 文本块流式输出 →│
                  │                                                                │
                  │     content_block_start ─── delta ─── content_block_stop        │
                  │     │← 工具调用 JSON 累积 →│                                     │
```

**文本和工具调用可以交错出现** —— 模型可能先输出一些文本解释，然后发起工具调用，再输出更多文本。

## Layer 2: 流式工具执行

传统方式是等消息完全接收后再执行工具。Claude Code 做得更激进 —— **边接收边执行**：

```typescript
// src/query.ts - 简化的流式工具执行
async function* queryLoop(params) {
  while (true) {
    const streamingToolExecutor = new StreamingToolExecutor(toolUseContext)
    const toolUseBlocks: ToolUseBlock[] = []

    // 流式接收 LLM 响应
    for await (const event of queryModel(messages, systemPrompt, tools)) {
      if (event.type === 'stream_event') {
        yield event  // 转发给 UI

        // 当一个工具调用的 content_block 完成时...
        if (event.event.type === 'content_block_stop') {
          const block = contentBlocks[event.event.index]
          if (block.type === 'tool_use') {
            // 立即开始执行！不等整条消息结束
            streamingToolExecutor.addTool(block, currentMessage)
          }
        }
      }
    }

    // 等待所有工具执行完毕
    const results = await streamingToolExecutor.waitForAll()

    // ... 追加结果，继续循环
  }
}
```

**好处**：如果 LLM 同时调用了 `Read` 和 `Grep`，这两个只读工具可以并发执行，不需要等另一个工具调用接收完。

## StreamingToolExecutor

```typescript
// src/services/tools/StreamingToolExecutor.ts - 简化
export class StreamingToolExecutor {
  private queue: TrackedTool[] = []
  private running: TrackedTool[] = []
  private completed: TrackedTool[] = []

  addTool(block: ToolUseBlock, message: AssistantMessage) {
    const isSafe = tool.isConcurrencySafe(block.input)
    this.queue.push({
      block,
      message,
      isSafe,
      status: 'queued',
    })
    void this.processQueue()
  }

  private async processQueue() {
    while (this.queue.length > 0) {
      const next = this.queue[0]

      if (!this.canExecute(next.isSafe)) {
        // 等待: 有不安全的工具在运行，或自己不安全
        await this.waitForSlot()
        continue
      }

      this.queue.shift()
      next.status = 'running'
      this.running.push(next)

      // 异步执行，不阻塞队列处理
      this.executeAsync(next).then(() => {
        next.status = 'completed'
        this.running = this.running.filter(t => t !== next)
        this.completed.push(next)
      })
    }
  }

  private canExecute(isSafe: boolean): boolean {
    // 规则:
    // 1. 安全工具可以并发执行 (Read + Grep + Glob 同时执行)
    // 2. 不安全工具必须独占 (Write 等所有完成后执行)
    // 3. 有不安全工具在运行时，所有新工具等待
    if (this.running.some(t => !t.isSafe)) return false
    if (!isSafe && this.running.length > 0) return false
    return true
  }

  async waitForAll(): Promise<CompletedTool[]> {
    while (this.running.length > 0 || this.queue.length > 0) {
      await sleep(10)
    }
    return this.completed
  }
}
```

### 并发场景示例

```
LLM 返回: [Read(a.ts), Read(b.ts), Grep("TODO"), Write(c.ts)]

时间线:
t0: Read(a.ts) 开始 ──┐
t0: Read(b.ts) 开始 ──┤ 三个只读操作并发
t0: Grep("TODO") 开始─┘
t1: Read(a.ts) 完成
t2: Read(b.ts) 完成
t2: Grep("TODO") 完成
t3: Write(c.ts) 开始 ── 等所有只读完成后独占执行
t4: Write(c.ts) 完成
```

## Layer 3: UI 渲染

流式事件最终到达 UI 层，Ink (React for Terminal) 负责渲染：

```typescript
// 简化的 UI 渲染流程
function MessageStream({ engine }: { engine: QueryEngine }) {
  const [text, setText] = useState('')
  const [tools, setTools] = useState<ToolUse[]>([])

  useEffect(() => {
    (async () => {
      for await (const message of engine.submitMessage(userInput)) {
        switch (message.type) {
          case 'text':
            // 追加文本，触发 Markdown 渲染
            setText(prev => prev + message.text)
            break
          case 'tool_use':
            // 显示工具调用进度
            setTools(prev => [...prev, message.toolUse])
            break
          case 'tool_result':
            // 更新工具执行结果
            updateToolResult(message)
            break
        }
      }
    })()
  }, [userInput])

  return (
    <Box flexDirection="column">
      <Markdown text={text} />
      {tools.map(t => <ToolProgress key={t.id} tool={t} />)}
    </Box>
  )
}
```

## 首 Token 延迟 (TTFT)

Claude Code 追踪首 token 延迟作为性能指标：

```typescript
// message_start 事件标记 TTFT
case 'message_start':
  const ttft = Date.now() - requestStartTime
  // 记录到分析系统
  analytics.trackTTFT(ttft)
  break
```

TTFT 是用户感知的"响应速度"最重要的指标。

## 空闲超时

流式接收中如果长时间没有新事件，触发超时：

```typescript
// 流式空闲超时检测
let lastEventTime = Date.now()

function resetStreamIdleTimer() {
  lastEventTime = Date.now()
}

// 每个事件重置计时器
for await (const event of stream) {
  resetStreamIdleTimer()
  // ...
}

// 后台定时器检查
const idleChecker = setInterval(() => {
  if (Date.now() - lastEventTime > STREAM_IDLE_TIMEOUT) {
    // 流式连接可能断了
    abortController.abort()
  }
}, 5000)
```

## 简化实现

```typescript
// 最小流式 Agent Loop
async function* streamingAgentLoop(
  query: string,
): AsyncGenerator<{ type: string; data: any }> {
  const messages: Message[] = [{ role: 'user', content: query }]

  while (true) {
    // 流式调用 LLM
    const stream = await client.messages.create({
      model: MODEL, messages, tools: TOOLS,
      max_tokens: 8192, stream: true,
    })

    const contentBlocks: any[] = []
    let stopReason = null

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', data: event.delta.text }  // 实时输出
        }
      }
      // ... 累积 contentBlocks 和 stopReason
    }

    messages.push({ role: 'assistant', content: contentBlocks })

    if (stopReason !== 'tool_use') return

    // 执行工具
    const results = await executeTools(contentBlocks)
    messages.push({ role: 'user', content: results })
  }
}

// 消费
for await (const chunk of streamingAgentLoop("Fix the bug")) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.data)  // 打字机效果
  }
}
```

## 关键设计决策

### 为什么全链路用异步生成器？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 回调 | 简单 | 回调地狱、难以组合 |
| Promise | 熟悉 | 无法流式、必须等完整结果 |
| EventEmitter | 灵活 | 无类型安全、难以管理生命周期 |
| **AsyncGenerator** | **流式 + 可组合 + 可中断 + 类型安全** | 学习曲线 |

### 为什么边接收边执行工具？

如果 LLM 返回 3 个工具调用，传统方式需要等所有 JSON 解析完才开始执行。流式执行在第一个工具的 JSON 接收完就立即开始，节省了等待时间。

### 为什么用 `yield*` 而不是手动转发？

```typescript
// 手动转发 (繁琐、容易漏)
for await (const msg of innerGenerator()) {
  yield msg
}

// yield* 自动转发 (简洁、正确)
yield* innerGenerator()
```

`yield*` 还能正确传播 `.return()` 和 `.throw()`，实现优雅终止。

## 本章小结

| 维度 | 非流式 | Claude Code 流式 |
|------|--------|------------------|
| 用户体验 | 长时间空白等待 | 打字机实时输出 |
| 中断 | 等完整响应 | 随时 Ctrl+C |
| 工具执行 | 全部接收后顺序执行 | 边接收边并发执行 |
| 编程范式 | Promise/callback | AsyncGenerator 全链路 |
| 性能指标 | 总响应时间 | TTFT + 流式速率 |

流式处理让 Agent "活"了起来。接下来看看 Agent 如何获取领域知识 —— [S10: Skills](/s10-skills)。
