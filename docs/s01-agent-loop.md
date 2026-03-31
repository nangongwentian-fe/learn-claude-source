# S01: Agent Loop (代理循环)

> **核心洞察**：最小的 Agent 内核就是一个 `while` 循环 + 一个工具。Claude Code 的全部复杂性都建立在这个基础之上。

## 核心问题

语言模型能推理代码，但无法与真实世界交互 —— 它不能读文件、执行测试、验证错误。没有自动化循环，用户必须手动复制粘贴工具结果给模型。

**Agent Loop 就是解决这个问题的最小闭环。**

## 教学版 vs 真实版

### 教学版 (learn.shareai.run s01) —— 30 行代码

```python
def agent_loop(query):
    messages = [{"role": "user", "content": query}]
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

这 30 行代码包含了 Agent 的全部本质：
1. 维护一个消息列表
2. 不断调用 LLM
3. 如果 LLM 要求使用工具，就执行工具并把结果追加回去
4. 如果 LLM 不再需要工具，就退出

### 真实版 (Claude Code) —— 同样的循环，但多了 10 层

在 Claude Code 中，同样的循环分布在三个关键文件中：

## 源码定位

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/QueryEngine.ts` | ~1295 行 | 查询引擎 - 管理整个对话生命周期 |
| `src/query.ts` | ~1729 行 | Agent Loop - 核心 `while(true)` 循环 |
| `src/services/api/claude.ts` | ~2800 行 | API 客户端 - 流式调用与事件处理 |

## 第一层：QueryEngine —— 对话生命周期

`QueryEngine` 是所有查询的入口。它是一个 **异步生成器**，将用户输入流式转化为响应消息：

```typescript
// src/QueryEngine.ts
export class QueryEngine {
  // 跨轮次持久化的消息列表 —— 这就是教学版的 messages[]
  private mutableMessages: Message[]
  private abortController: AbortController
  private totalUsage: NonNullableUsage

  // 入口：用户输入进来，响应消息流出去
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // 1. 处理用户输入
    const { messages: messagesFromUserInput } = await processUserInput({...})
    this.mutableMessages.push(...messagesFromUserInput)

    // 2. 调用核心查询循环
    for await (const message of query({
      messages: [...this.mutableMessages],
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      ...
    })) {
      // 3. 累积消息并持久化
      if (message.type === 'assistant') {
        this.mutableMessages.push(message)
        yield* normalizeMessage(message)
      }
    }
  }
}
```

关键设计点：
- **`async *`（异步生成器）** —— 不是一次性返回，而是流式 yield 每个消息片段
- **`mutableMessages`** —— 跨轮次持久化，是整个对话历史的"真相源"
- **`yield*`** —— 将内部生成器的结果直接透传给调用方

## 第二层：queryLoop —— 核心 While 循环

这是 Agent 的心脏。和教学版一样，它是一个 `while(true)` 循环：

```typescript
// src/query.ts
async function* queryLoop(
  params: QueryParams,
): AsyncGenerator<StreamEvent | Message, Terminal> {

  // 可变的跨迭代状态
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    turnCount: 1,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensRecoveryCount: 0,
    // ...
  }

  // ========== 这就是 Agent Loop ==========
  // eslint-disable-next-line no-constant-condition
  while (true) {

    // ---- 步骤 1: 调用 LLM (流式) ----
    for await (const message of queryModel(
      state.messages,
      systemPrompt,
      tools,
      signal,
    )) {
      // 处理流式事件: text_delta, tool_use, thinking...
      yield message
    }

    // ---- 步骤 2: 检查是否需要继续 ----
    if (!needsFollowUp) {
      // 没有工具调用 → 退出循环
      return { reason: 'end_turn' }
    }

    // ---- 步骤 3: 执行工具，收集结果 ----
    for (const toolBlock of toolUseBlocks) {
      streamingToolExecutor.addTool(toolBlock, assistantMessage)
    }

    // ---- 步骤 4: 追加工具结果到消息列表 ----
    const toolResultMessage = createToolResultMessage(toolResults)
    state.messages.push(assistantMessage, toolResultMessage)

    // ---- 步骤 5: 回到步骤 1 ----
    state.turnCount++
  }
}
```

对比教学版：

| 教学版 | Claude Code |
|--------|-------------|
| `response.stop_reason != "tool_use"` | `!needsFollowUp` (考虑更多条件) |
| `client.messages.create()` | `queryModel()` (流式 + 重试 + 缓存) |
| `run_bash(command)` | `streamingToolExecutor.addTool()` (并发 + 权限) |
| `messages.append()` | `state.messages.push()` (+ 压缩 + 持久化) |

## 第三层：流式 API 调用

教学版用 `client.messages.create()` 一次获取完整响应。Claude Code 用流式调用逐块接收：

```typescript
// src/services/api/claude.ts
for await (const part of stream) {
  switch (part.type) {
    case 'message_start':
      // 消息开始，记录首 token 延迟
      ttftMs = Date.now() - start
      break

    case 'content_block_start':
      // 新的内容块开始 (text / tool_use / thinking)
      contentBlocks[part.index] = { ...part.content_block }
      break

    case 'content_block_delta':
      // 增量内容: 文本片段或工具输入 JSON
      if (delta.type === 'text_delta') {
        contentBlock.text += delta.text
      } else if (delta.type === 'input_json_delta') {
        contentBlock.input += delta.input_json_delta
      }
      break

    case 'message_delta':
      // 关键：检查 stop_reason
      if (part.delta.stop_reason != null) {
        lastStopReason = part.delta.stop_reason
      }
      break

    case 'message_stop':
      // 消息结束，累积 token 使用量
      this.totalUsage = accumulateUsage(this.totalUsage, currentUsage)
      break
  }
}
```

## 循环退出与恢复

教学版的退出条件很简单：`stop_reason != "tool_use"`。Claude Code 的退出逻辑要复杂得多：

```typescript
// src/query.ts - 简化后的退出/恢复逻辑
if (!needsFollowUp) {
  const lastMessage = assistantMessages.at(-1)

  // 恢复路径 1: Prompt 太长 → 尝试上下文折叠
  if (isPromptTooLongMessage(lastMessage)) {
    const drained = contextCollapse.recoverFromOverflow(messages)
    if (drained.committed > 0) {
      state.messages = drained.messages
      continue  // 用压缩后的上下文重试
    }

    // 恢复路径 2: 响应式压缩
    if (!state.hasAttemptedReactiveCompact) {
      const compacted = reactiveCompact(messages)
      state.messages = compacted
      state.hasAttemptedReactiveCompact = true
      continue  // 用摘要重试
    }
  }

  // 恢复路径 3: max_tokens 截断 → 增加 token 预算
  if (lastStopReason === 'max_tokens') {
    state.maxOutputTokensOverride = currentLimit * 2
    state.maxOutputTokensRecoveryCount++
    continue
  }

  // 真正退出
  return { reason: 'end_turn' }
}
```

这体现了工业级系统的健壮性 —— 教学版遇到问题就崩溃，真实系统会尝试多种恢复策略。

## 消息类型

教学版只有简单的 `role: "user" | "assistant"` 和 `type: "tool_result"`。Claude Code 的消息体系更丰富：

```typescript
// 核心消息类型
type Message =
  | UserMessage          // 用户输入
  | AssistantMessage     // LLM 响应 (可包含 text + tool_use + thinking)
  | ToolResultMessage    // 工具执行结果
  | CompactBoundary      // 压缩边界标记
  | TombstoneMessage     // 被压缩的消息占位符

// AssistantMessage 的内容块
type ContentBlock =
  | TextBlock            // 文本输出
  | ToolUseBlock         // 工具调用请求
  | ThinkingBlock        // 思考过程 (extended thinking)
```

## 简化实现

用 TypeScript 还原 Claude Code Agent Loop 的核心思想（约 50 行）：

```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

// 简化的 Agent Loop —— Claude Code 核心循环的本质
async function agentLoop(query: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: query }
  ]

  while (true) {
    // 1. 调用 LLM (Claude Code 用 streaming，这里简化)
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      system: 'You are a coding assistant with access to tools.',
      messages,
      tools: TOOLS,
      max_tokens: 8192,
    })

    // 2. 追加 assistant 消息
    messages.push({ role: 'assistant', content: response.content })

    // 3. 检查退出条件
    if (response.stop_reason !== 'tool_use') {
      // 打印最终文本
      for (const block of response.content) {
        if (block.type === 'text') console.log(block.text)
      }
      return
    }

    // 4. 执行工具，收集结果
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const output = await dispatchTool(block.name, block.input)
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        })
      }
    }

    // 5. 追加工具结果，回到步骤 1
    messages.push({ role: 'user', content: results })
  }
}
```

## 关键设计决策

### 为什么用异步生成器而不是回调/Promise？

Claude Code 全程使用 `async function*`，原因是：

1. **流式输出** —— 用户能看到 LLM 正在"思考"和"打字"，而不是等待完整响应
2. **惰性求值** —— 调用方可以随时中断（用户按 Ctrl+C），不需要等整个循环结束
3. **组合性** —— `yield*` 可以无缝串联多层生成器
4. **背压控制** —— 消费者消费到哪里，生产者就执行到哪里

### 为什么消息列表是"可变的"？

在函数式编程中，我们倾向于不可变数据。但 Claude Code 选择了可变的 `mutableMessages`，原因是：

1. **性能** —— 对话可能有上千条消息，每次复制成本太高
2. **持久化** —— 消息需要实时写入磁盘，可变引用更容易管理
3. **压缩** —— 上下文压缩需要原地修改消息列表

### 为什么不是简单的递归？

教学版可以用递归实现 Agent Loop。Claude Code 选择 `while(true)` 是因为：

1. **避免栈溢出** —— 一次对话可能执行数百轮工具调用
2. **状态管理** —— `state` 对象需要跨迭代修改
3. **恢复逻辑** —— `continue` 语句可以重试当前迭代

## 本章小结

| 维度 | 教学版 (s01) | Claude Code |
|------|-------------|-------------|
| 循环 | `while True` | `while (true)` + 恢复逻辑 |
| API 调用 | 同步完整响应 | 异步流式生成器 |
| 消息累积 | 简单 list.append | 可变引用 + 转录持久化 |
| 退出条件 | `stop_reason` 检查 | 多层退出 + 自动恢复 |
| 错误处理 | 无 | 上下文折叠 / 响应式压缩 / token 预算调整 |
| 代码量 | 30 行 | ~5800 行 (三个核心文件) |

**核心循环没有变 —— 变的是循环之上的每一层。** 接下来，让我们看看循环中最关键的部分：[S02: 工具系统](/s02-tools)。
