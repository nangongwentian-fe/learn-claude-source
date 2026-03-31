# S05: Context & Compact (上下文压缩)

> **核心洞察**：Context Window 是有限的稀缺资源。三层渐进式压缩策略让 Agent 能在有限窗口内"无限"工作。

## 核心问题

读一个 1000 行文件消耗 ~4000 token。处理 30 个文件 + 20 条命令后，token 使用量超过 100,000。大型项目的代码库工作在没有压缩策略的情况下是不可能的。

**上下文窗口是 Agent 的"工作记忆" —— 它决定了 Agent 能同时记住多少东西。**

## 教学版 vs 真实版

### 教学版 (s06) —— 三层压缩

learn.shareai.run 的 s06 也实现了三层压缩，是对 Claude Code 的精确简化：

| 层级 | 教学版 | Claude Code |
|------|--------|-------------|
| Micro | 替换旧工具结果为占位符 | 同样策略 + 更智能的选择 |
| Auto | 超 50K token 触发 LLM 摘要 | 多种触发条件 + 分析标签 |
| Manual | compact 工具手动触发 | 同 + 恢复策略 |

### 真实版的额外复杂性

Claude Code 的压缩系统还处理：
- 压缩后的上下文恢复（重新注入关键文件和技能）
- 响应式压缩（Prompt Too Long 错误的自动恢复）
- 转录持久化（压缩前保存完整历史到磁盘）
- token 精确估算（不只是字符数 / 4）

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/services/compact/` | 压缩服务核心目录 |
| `src/services/compact/compact.ts` | 压缩逻辑 |
| `src/services/compact/compactPrompt.ts` | 压缩用的提示词模板 |
| `src/services/tokenEstimation.ts` | Token 估算 |
| `src/query.ts` | 响应式压缩触发 |

## Layer 1: Micro-Compact (每轮自动)

在每次 LLM 调用之前，自动替换旧的工具结果为占位符：

```typescript
// 简化的 Micro-Compact 逻辑
function microCompact(messages: Message[]): Message[] {
  // 只保留最近 3 轮的完整工具结果
  const KEEP_RECENT = 3
  let toolResultCount = 0

  // 从后往前遍历
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (isToolResult(msg)) {
      toolResultCount++
      if (toolResultCount > KEEP_RECENT) {
        // 替换为占位符
        messages[i] = {
          role: 'user',
          content: `[Previous: used ${msg.toolName}]`,
        }
      }
    }
  }

  return messages
}
```

**为什么保留最近 3 轮？**
- 太少：模型忘记刚刚做了什么
- 太多：token 浪费在已经处理完的信息上
- 3 是经验值，平衡了"记忆"和"容量"

## Layer 2: Auto-Compact (Token 阈值触发)

当总 token 使用量超过阈值时，触发完整的对话摘要：

```typescript
// 简化的 Auto-Compact 流程
async function autoCompact(
  messages: Message[],
  tokenCount: number,
  threshold: number,
): Promise<Message[]> {
  if (tokenCount < threshold) return messages  // 未达阈值

  // 1. 保存完整转录到磁盘 (不丢失任何信息)
  await saveTranscript(messages, '.transcripts/')

  // 2. 按 API 轮次分组消息
  const rounds = groupByApiRound(messages)

  // 3. 去除图片等大型内容 (节省压缩 token)
  const stripped = stripImages(rounds)

  // 4. 构建压缩提示词
  const compactPrompt = buildCompactPrompt(stripped)

  // 5. 调用 LLM 生成摘要
  const summary = await client.messages.create({
    model: MODEL,
    system: compactPrompt,
    messages: stripped,
    max_tokens: 8000,
  })

  // 6. 解析 <analysis> 和 <summary> 标签
  const { analysis, summaryText } = parseCompactResponse(summary)

  // 7. 用摘要替换所有消息
  return [{
    role: 'user',
    content: `[Previous conversation summary]\n${summaryText}`,
  }]
}
```

### 压缩提示词

Claude Code 给压缩 LLM 的提示词非常详细，要求输出包含 9 个必需部分：

```
你的任务是分析一段对话并生成结构化摘要。

输出格式:
<analysis>
对当前状态的深入分析...
</analysis>
<summary>
1. 初始用户请求和高层目标
2. 已完成的关键步骤
3. 当前工作状态
4. 待完成的任务
5. 重要的技术决策和原因
6. 相关文件路径
7. 遇到的错误和解决方案
8. 环境配置细节
9. 下一步行动建议
</summary>
```

### 压缩后恢复

压缩后，上下文几乎为空。Claude Code 会自动恢复关键信息：

```typescript
// 压缩后恢复逻辑
async function postCompactRestore(
  summaryMessages: Message[],
  context: CompactContext,
): Promise<Message[]> {
  const restored = [...summaryMessages]
  let tokenBudget = 50_000  // 恢复的总 token 预算

  // 1. 恢复最近编辑/读取的文件 (最多 5 个，每个 5K token)
  const recentFiles = context.fileStateCache.getRecent(5)
  for (const file of recentFiles) {
    const content = await readFile(file.path)
    const truncated = truncateToTokens(content, 5_000)
    restored.push({
      role: 'user',
      content: `<system-reminder>File restored after compact: ${file.path}\n${truncated}</system-reminder>`,
    })
    tokenBudget -= estimateTokens(truncated)
  }

  // 2. 恢复已加载的技能 (25K token 预算)
  const loadedSkills = context.loadedSkills
  const skillBudget = Math.min(25_000, tokenBudget)
  for (const skill of loadedSkills) {
    const content = skill.content
    if (estimateTokens(content) <= skillBudget) {
      restored.push({
        role: 'user',
        content: `<system-reminder>Skill restored: ${skill.name}\n${content}</system-reminder>`,
      })
    }
  }

  return restored
}
```

## Layer 3: 响应式压缩 (错误恢复)

当 API 返回 "Prompt Too Long" 错误时，Agent Loop 触发自动恢复：

```typescript
// src/query.ts - 响应式压缩
if (isPromptTooLongMessage(lastMessage)) {

  // 策略 1: 上下文折叠 (低成本)
  // 丢弃最旧的消息，保留最近的
  const drained = contextCollapse.recoverFromOverflow(messages)
  if (drained.committed > 0) {
    state.messages = drained.messages
    continue  // 用折叠后的上下文重试
  }

  // 策略 2: 响应式压缩 (调用 LLM 生成摘要)
  if (!state.hasAttemptedReactiveCompact) {
    const compacted = await reactiveCompact(messages)
    state.messages = compacted
    state.hasAttemptedReactiveCompact = true
    continue  // 用摘要重试
  }

  // 策略 3: 放弃 → 返回错误给用户
  return { reason: 'prompt_too_long' }
}
```

**三种策略递进**：折叠（便宜）→ 摘要（较贵）→ 放弃（最后手段）

## Token 估算

Claude Code 用多种方式估算 token 使用量：

```typescript
// src/services/tokenEstimation.ts

// 粗略估算: ~4 字符 = 1 token
function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4)
}

// 精确估算: 使用 tiktoken 或 API 返回的 usage
function preciseTokenCount(usage: APIUsage): number {
  return usage.input_tokens + usage.output_tokens
}
```

**为什么不总用精确估算？**
- 精确估算需要实际调用 API
- 粗略估算用于决定"是否该压缩了"，不需要很精确
- 在压缩决策中，误差 20% 是可接受的

## 转录持久化

压缩前，完整对话被保存到磁盘：

```
~/.claude/sessions/
  └── <session-id>/
      ├── session.json       # 会话元数据
      ├── transcript.jsonl   # 完整消息记录 (JSONL)
      └── .transcripts/      # 压缩前的快照
```

**JSONL 格式** —— 每行一条消息，追加写入，不需要重写整个文件。

## 简化实现

```typescript
// 三层压缩的简化实现
const TOKEN_THRESHOLD = 50_000
const KEEP_RECENT_RESULTS = 3

async function manageContext(
  messages: Message[],
  tokenCount: number,
): Promise<Message[]> {
  // Layer 1: Micro-compact (每轮)
  let result = microCompact(messages, KEEP_RECENT_RESULTS)

  // Layer 2: Auto-compact (超过阈值)
  if (tokenCount > TOKEN_THRESHOLD) {
    await saveTranscript(result)
    const summary = await summarize(result)
    result = [{ role: 'user', content: summary }]
    result = await restoreContext(result)  // 恢复关键文件和技能
  }

  return result
}

// Layer 3: Manual compact (用户触发)
const CompactTool = buildTool({
  name: 'compact',
  async call(input, context) {
    const summary = await summarize(context.messages)
    context.messages.splice(0, context.messages.length, {
      role: 'user', content: summary,
    })
    return { data: 'Conversation compacted.' }
  },
})
```

## 关键设计决策

### 为什么不直接截断而要摘要？

截断丢失信息是不可逆的 —— Agent 可能忘记用户的目标或已完成的步骤。摘要保留了语义信息，Agent 能继续之前的工作。

### 为什么保存转录到磁盘？

1. **不可逆操作需要备份** —— 压缩是有损的
2. **调试** —— 用户可以回看完整对话历史
3. **恢复** —— 如果摘要不够好，可以重新加载原始转录

### 为什么恢复后要重新注入文件？

压缩后模型会"忘记"文件内容。重新注入最近的文件让模型能继续编辑而不需要重新读取。

### 为什么 Micro-Compact 只替换工具结果？

Assistant 消息包含模型的推理过程和决策，这些信息比工具结果更有价值。工具结果通常很大（文件内容、命令输出）但价值递减很快。

## 本章小结

| 维度 | 教学版 (s06) | Claude Code |
|------|-------------|-------------|
| Micro | 替换旧工具结果 | 同 + 智能选择保留数量 |
| Auto | 50K 阈值 + LLM 摘要 | 同 + 9 部分结构化摘要 |
| Manual | compact 工具 | 同 |
| 恢复 | 无 | 文件恢复 + 技能恢复 (50K 预算) |
| 响应式 | 无 | 折叠 → 摘要 → 放弃 三级递进 |
| 持久化 | .transcripts/ | JSONL 追加写入 |
| Token 估算 | 字符数 / 4 | 粗略 + 精确双模式 |

上下文管理确保了 Agent 的"记忆"不会溢出。接下来看看 Agent 如何"分身" —— [S06: 子代理](/s06-subagents)。
