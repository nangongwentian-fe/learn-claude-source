# S06: Subagents (子代理)

> **核心洞察**：子代理使用独立的 messages[]，执行完毕只返回摘要，保持主对话上下文的干净。这是"分治法"在 Agent 架构中的应用。

## 核心问题

随着 Agent 执行任务，消息历史不断增长。父代理让子代理去"调查一下测试框架用的是什么"，这个子任务可能需要多次工具调用，但父代理只需要最终答案，不需要中间步骤。

如果所有中间步骤都留在主上下文中：
- Token 快速消耗
- 无关信息干扰后续推理
- 主任务的上下文被稀释

## 教学版 vs 真实版

### 教学版 (s04) —— 干净的上下文隔离

```python
def run_subagent(prompt: str) -> str:
    """子代理：独立 messages[]，只返回摘要"""
    messages = [{"role": "user", "content": prompt}]  # 全新的消息列表

    for _ in range(30):  # 最多 30 轮
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=CHILD_TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            # 只返回最终文本，丢弃所有中间上下文
            return extract_text(response)

        # 执行工具...
        messages.append({"role": "user", "content": results})

    return "Subagent reached iteration limit"
```

关键设计：**子代理的 messages 和父代理完全独立**。

### 真实版 (Claude Code) —— AgentTool

Claude Code 的子代理是通过 `AgentTool` 实现的，它本身就是一个 Tool —— 嵌套的 Agent Loop。

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/tools/AgentTool/` | 子代理工具实现 |
| `src/tools/AgentTool/AgentTool.ts` | AgentTool 定义 |
| `src/QueryEngine.ts` | 子代理的 QueryEngine 实例 |
| `src/query.ts` | 子代理复用同一个 queryLoop |

## AgentTool —— 子代理就是一个 Tool

```typescript
// src/tools/AgentTool/AgentTool.ts - 简化
export const AgentTool = buildTool({
  name: 'Agent',
  maxResultSizeChars: 50_000,

  inputSchema: z.object({
    prompt: z.string(),           // 子代理的任务描述
    description: z.string(),      // 短描述 (3-5 词)
    subagent_type: z.string().optional(),  // 代理类型
    model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
    run_in_background: z.boolean().optional(),
    isolation: z.enum(['worktree']).optional(),
  }),

  // 子代理可以并发执行
  isConcurrencySafe() { return true },

  // 子代理本身是只读的 (它内部的工具调用有自己的权限检查)
  isReadOnly() { return true },

  async call(input, context) {
    // 创建一个新的 QueryEngine 实例 —— 独立的消息列表
    const childEngine = new QueryEngine({
      tools: getChildTools(input.subagent_type),
      systemPrompt: buildSubagentPrompt(input),
      // 关键: messages 从空开始
      messages: [],
    })

    // 运行子代理的 Agent Loop
    let result = ''
    for await (const message of childEngine.submitMessage(input.prompt)) {
      if (message.type === 'text') {
        result += message.text
      }
    }

    // 只返回最终文本给父代理
    return { data: result }
  },
})
```

## 工具集隔离

子代理和父代理的可用工具不同：

```typescript
function getChildTools(subagentType?: string): Tool[] {
  // 子代理的基础工具集 —— 没有 AgentTool！
  const baseTools = [
    BashTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    WebFetchTool,
    // 注意：没有 AgentTool → 防止无限递归
  ]

  // 不同类型的子代理有不同工具
  switch (subagentType) {
    case 'Explore':
      // 探索型：只有搜索和读取工具
      return [FileReadTool, GlobTool, GrepTool, WebFetchTool]
    case 'Plan':
      // 规划型：只有读取工具 + 任务工具
      return [FileReadTool, GlobTool, GrepTool, TaskCreateTool]
    default:
      return baseTools
  }
}
```

**关键设计：子代理没有 AgentTool** —— 防止子代理无限递归地产生更多子代理。

## 子代理类型

Claude Code 预定义了多种子代理类型：

```typescript
// 从系统提示词中提取的子代理类型
const SUBAGENT_TYPES = {
  'general-purpose': {
    description: '通用代理，适合复杂多步骤任务',
    tools: '*',  // 所有工具 (除了 Agent)
  },
  'Explore': {
    description: '快速探索代码库',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch'],
    // 不能编辑文件
  },
  'Plan': {
    description: '设计实现方案',
    tools: ['Read', 'Glob', 'Grep'],
    // 只读 + 任务工具
  },
  'code-reviewer': {
    description: '代码审查',
    tools: '*',
  },
  // ... 更多专用类型
}
```

## 上下文隔离机制

子代理的上下文与父代理完全隔离，但可以共享某些状态：

```
父代理
├── messages: [user, assistant, tool_result, ...]  ← 完整历史
├── tools: [Bash, Read, Write, Edit, Agent, ...]
├── systemPrompt: "You are Claude Code..."
│
└── AgentTool.call()
    │
    └── 子代理 (新 QueryEngine 实例)
        ├── messages: []  ← 空! 独立的消息列表
        ├── tools: [Bash, Read, Write, Edit]  ← 没有 Agent
        ├── systemPrompt: "You are a subagent..."
        │
        └── 执行完毕 → 只返回最终文本给父代理
```

**共享的状态**：
- 文件系统 —— 子代理可以读写同样的文件
- 工作目录 —— 子代理在同一个 cwd 中工作
- 权限规则 —— 子代理继承父代理的权限设置

**不共享的状态**：
- 消息历史 —— 完全独立
- Token 追踪 —— 独立计费
- 压缩状态 —— 子代理有自己的压缩周期

## 后台执行

子代理可以在后台运行，不阻塞父代理：

```typescript
// 前台执行 (默认)
const result = await AgentTool.call({
  prompt: "分析项目的测试覆盖率",
  description: "分析测试覆盖率",
})
// 父代理等待子代理完成

// 后台执行
const result = await AgentTool.call({
  prompt: "运行所有测试并报告结果",
  description: "运行测试",
  run_in_background: true,
})
// 父代理立即继续，子代理完成后通知
```

这对应 learn.shareai.run 的 s08 (Background Tasks)。

## Worktree 隔离

更高级的隔离 —— 子代理在独立的 git worktree 中工作：

```typescript
const result = await AgentTool.call({
  prompt: "在独立分支上重构认证模块",
  description: "重构认证",
  isolation: 'worktree',  // 创建独立的工作目录
})
```

这对应 learn.shareai.run 的 s12 (Worktree + Task Isolation)。

## 简化实现

```typescript
// 子代理的简化实现
async function runSubagent(prompt: string, tools: Tool[]): Promise<string> {
  // 独立的消息列表
  const messages: Message[] = [{ role: 'user', content: prompt }]

  for (let i = 0; i < 50; i++) {  // 最多 50 轮
    const response = await client.messages.create({
      model: MODEL,
      system: 'You are a subagent. Complete the task and return results.',
      messages,
      tools: tools.map(t => t.toAPISchema()),
      max_tokens: 8192,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      // 只返回最终文本
      return response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
    }

    // 执行工具
    const results = await executeTools(response.content, tools)
    messages.push({ role: 'user', content: results })
  }

  return 'Subagent reached iteration limit'
}

// 作为 Tool 注册
const SubagentTool = buildTool({
  name: 'Agent',
  isConcurrencySafe: () => true,
  async call(input) {
    const result = await runSubagent(input.prompt, CHILD_TOOLS)
    return { data: result }
  },
})
```

## 关键设计决策

### 为什么子代理是 Tool 而不是独立进程？

1. **统一接口** —— 权限检查、Hook、结果格式化都复用 Tool 管线
2. **简单** —— 不需要 IPC、序列化、进程管理
3. **共享文件系统** —— 子代理可以直接读写文件

### 为什么要限制迭代次数？

防止子代理陷入死循环。如果子代理 50 轮还没完成，说明任务描述可能有问题。

### 为什么 Explore 类型没有 Write/Edit？

**最小权限原则** —— 探索型子代理的任务是"找信息"，不需要修改能力。减少工具集也减少了潜在的错误。

### 为什么子代理可以并发？

子代理有独立的消息列表，不修改父代理状态，所以多个子代理可以同时执行。这对应 `isConcurrencySafe: true`。

## 与 learn.shareai.run 的完整映射

| learn.shareai.run | Claude Code |
|-------------------|-------------|
| s04: Subagents | AgentTool (基础子代理) |
| s07: Tasks | TaskCreate/Update/List/Get Tools |
| s08: Background Tasks | `run_in_background: true` |
| s09: Agent Teams | Swarm mode + TeammateManager |
| s10: Team Protocols | SendMessage + 协议工具 |
| s11: Autonomous Agents | Coordinator mode |
| s12: Worktree Isolation | `isolation: 'worktree'` |

Claude Code 把教程中 s04-s12 的概念都统一在了 AgentTool 和相关基础设施中。

## 本章小结

| 维度 | 教学版 (s04) | Claude Code |
|------|-------------|-------------|
| 隔离 | 独立 messages[] | 独立 QueryEngine 实例 |
| 工具集 | 移除 task 工具 | 按类型定制工具集 |
| 返回值 | 最终文本 | 文本 (可配置大小限制) |
| 递归防护 | 不给子代理 task 工具 | 不给子代理 Agent 工具 |
| 后台执行 | 无 | run_in_background |
| 目录隔离 | 无 | worktree |
| 代理类型 | 单一 | 多种预定义类型 |

子代理让 Agent 能"分身术"。接下来看看如何与外部世界连接 —— [S07: MCP](/s07-mcp)。
