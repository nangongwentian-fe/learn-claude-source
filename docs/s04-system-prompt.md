# S04: System Prompt (系统提示词)

> **核心洞察**：系统提示词不是一段静态文本，而是一个**动态构建的程序**，它从多个来源汇聚上下文，组装成模型在每轮对话中看到的"操作手册"。

## 核心问题

LLM 需要知道：
1. 自己是什么 —— "你是 Claude Code，Anthropic 的 CLI 工具"
2. 能做什么 —— 有哪些工具、什么时候用
3. 怎么做 —— 代码风格、安全规范、输出格式
4. 项目上下文 —— CLAUDE.md、目录结构、技术栈

如果把所有信息都塞进一个大字符串，Token 会被浪费、信息会过时、维护会很难。

## 系统提示词的构成

Claude Code 的系统提示词由多个片段动态拼接而成：

```
系统提示词 =
  基础人设 (identity)
  + 工具使用规范 (tool instructions)
  + 环境信息 (environment)
  + 权限模式说明 (permission mode)
  + CLAUDE.md 指令 (user/project instructions)
  + 当前日期 (date)
  + 技能描述 (skills catalog)
  + MCP 服务器指令 (MCP instructions)
  + system-reminder 注入 (dynamic context)
```

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/utils/systemPrompt.ts` | 系统提示词拼装逻辑 |
| `src/utils/claudemd.ts` | CLAUDE.md 加载与解析 (~46KB) |
| `src/utils/analyzeContext.ts` | 上下文分析 (~42KB) |
| `src/utils/messages.ts` | 消息构建工具 |

## 基础人设

系统提示词的开头是固定的身份声明：

```
You are Claude Code, Anthropic's official CLI for Claude.
You are an interactive agent that helps users with software engineering tasks.
Use the instructions below and the tools available to you to assist the user.
```

接下来是安全约束、通用行为规范等。你在本教程开头看到的那一大段系统提示词，就来自这里。

## 工具注入

每个已注册工具的 schema 会被注入到系统提示词（或 API 的 tools 参数）中：

```typescript
// 工具定义被转换为 API 格式
const toolDefinitions = tools.map(tool => ({
  name: tool.name,
  description: await tool.description(),
  input_schema: zodToJsonSchema(tool.inputSchema),
}))

// 工具使用说明被追加到系统提示词
const toolInstructions = tools.map(tool => ({
  name: tool.name,
  prompt: await tool.prompt(),
}))
```

**description vs prompt**：
- `description` —— 简短一句话，用于 API 的工具列表
- `prompt` —— 详细的使用说明，注入到系统提示词中

例如 BashTool 的 prompt 包含了何时使用 Bash、何时使用专用工具的详细指导。

## CLAUDE.md —— 用户自定义指令

这是 Claude Code 最有辨识度的特性之一。用户可以在项目中放置 `CLAUDE.md` 文件来定制 Agent 行为：

```
CLAUDE.md 加载顺序 (从高到低):
├── ~/.claude/CLAUDE.md           # 全局指令 (所有项目)
├── <project>/.claude/CLAUDE.md   # 项目指令 (团队共享)
├── <project>/CLAUDE.md           # 项目根指令
├── <subdir>/CLAUDE.md            # 子目录指令
└── 动态发现的 CLAUDE.md           # 通过 context 分析发现
```

### 加载逻辑

```typescript
// src/utils/claudemd.ts - 简化
async function loadClaudeMdFiles(cwd: string): Promise<ClaudeMdContent[]> {
  const results: ClaudeMdContent[] = []

  // 1. 全局 CLAUDE.md
  const globalPath = path.join(homedir(), '.claude', 'CLAUDE.md')
  if (await exists(globalPath)) {
    results.push({
      source: 'user',
      content: await readFile(globalPath),
      path: globalPath,
    })
  }

  // 2. 项目 CLAUDE.md (向上搜索到 git 根)
  const gitRoot = await findGitRoot(cwd)
  for (const dir of walkUpTo(cwd, gitRoot)) {
    for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
      const filePath = path.join(dir, name)
      if (await exists(filePath)) {
        results.push({
          source: 'project',
          content: await readFile(filePath),
          path: filePath,
        })
      }
    }
  }

  return results
}
```

### 注入到系统提示词

```typescript
// CLAUDE.md 的内容以特定格式注入
function formatClaudeMdForSystemPrompt(contents: ClaudeMdContent[]): string {
  return contents.map(c => {
    const label = c.source === 'user'
      ? "user's private global instructions"
      : `project instructions from ${c.path}`
    return `Contents of ${c.path} (${label}):\n\n${c.content}`
  }).join('\n\n')
}
```

## 环境信息

系统提示词包含运行时环境的快照：

```typescript
const environmentSection = `
# Environment
- Primary working directory: ${cwd}
  - Is a git repository: ${isGitRepo}
- Platform: ${process.platform}
- Shell: ${shell}
- OS Version: ${osRelease}
- Model: ${modelName}
- Knowledge cutoff: ${cutoffDate}
- Current date: ${today}
`
```

这让模型能够：
- 知道当前在哪个目录工作
- 根据平台选择合适的命令（macOS vs Linux）
- 知道自己的模型版本和知识截止日期

## system-reminder 注入

Claude Code 使用 `<system-reminder>` 标签在对话过程中动态注入上下文：

```typescript
// 常见的 system-reminder 场景

// 1. 技能描述注入
<system-reminder>
The following skills are available:
- commit: Create a git commit
- review-pr: Review a pull request
...
</system-reminder>

// 2. MCP 服务器指令
<system-reminder>
# MCP Server Instructions
## figma
The official Figma MCP server...
</system-reminder>

// 3. 延迟工具通知
<system-reminder>
The following deferred tools are available via ToolSearch:
WebFetch, WebSearch, TaskCreate, ...
</system-reminder>

// 4. 诊断信息
<system-reminder>
<new-diagnostics>
config.ts: Line 1: Cannot find module 'vitepress'
</new-diagnostics>
</system-reminder>
```

**为什么用 system-reminder 而不是系统提示词？**

系统提示词在对话开始时设定，不可变。`system-reminder` 可以在任何消息中注入，用于：
- 按需提供信息（避免浪费 token）
- 响应运行时变化（新的诊断、任务状态）
- 注入对话内发现的上下文

## 延迟工具加载

Claude Code 有 45+ 工具，但不是所有工具的详细 schema 都需要一开始就发送给 LLM。**延迟加载**策略：

```
Layer 1 (始终加载): 核心工具 schema
  - Bash, Read, Edit, Write, Glob, Grep, Agent

Layer 2 (名称+描述): 延迟工具
  - 只发送工具名称列表到 system-reminder
  - 模型需要时通过 ToolSearch 获取完整 schema

Layer 3 (运行时发现): MCP 工具
  - 连接 MCP 服务器后动态注册
```

这与 learn.shareai.run s05 (Skills) 的两层注入模式完全对应。

## 简化实现

```typescript
// 简化的系统提示词构建
function buildSystemPrompt(context: {
  cwd: string
  platform: string
  tools: Tool[]
  claudeMd: string[]
  skills: SkillMeta[]
}): string {
  const sections: string[] = []

  // 1. 身份
  sections.push(`You are Claude Code, an AI coding assistant.`)

  // 2. 工具说明
  for (const tool of context.tools) {
    sections.push(`## ${tool.name}\n${tool.prompt()}`)
  }

  // 3. 环境
  sections.push(`# Environment
- Working directory: ${context.cwd}
- Platform: ${context.platform}`)

  // 4. CLAUDE.md
  for (const md of context.claudeMd) {
    sections.push(`# User Instructions\n${md}`)
  }

  // 5. 技能目录 (仅名称+描述)
  if (context.skills.length > 0) {
    sections.push(`# Available Skills\n${
      context.skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
    }`)
  }

  return sections.join('\n\n')
}
```

## 关键设计决策

### 为什么 CLAUDE.md 而不是 JSON 配置？

1. **人类可读** —— Markdown 比 JSON 更适合写自然语言指令
2. **版本控制** —— 可以和代码一起提交到 git
3. **层级覆盖** —— 子目录的 CLAUDE.md 可以覆盖父目录的规则
4. **灵活性** —— 没有固定 schema，用户可以写任何指令

### 为什么不把所有工具提示都放系统提示词？

Token 是稀缺资源。45 个工具的完整提示可能消耗 50,000+ token，而用户的实际请求可能只需要 3-4 个工具。延迟加载让 token 用在刀刃上。

### 为什么环境信息很重要？

```bash
# 不知道平台:
$ sed -i '' 's/foo/bar/' file.txt  # macOS 语法
$ sed -i 's/foo/bar/' file.txt     # Linux 语法

# 不知道 shell:
$ source ~/.bashrc  # bash
$ source ~/.zshrc   # zsh
```

模型需要环境信息来生成正确的命令。

## 与 --dump-system-prompt 对比

Claude Code 提供了一个快速路径来查看完整的系统提示词：

```bash
claude --dump-system-prompt
```

这会输出完整的系统提示词（通常 20,000+ token），包括所有动态注入的部分。这是理解系统提示词构成的最佳方式。

## 本章小结

| 维度 | 简单实现 | Claude Code |
|------|---------|-------------|
| 系统提示词 | 硬编码字符串 | 动态拼装 (8+ 来源) |
| 工具说明 | 全部内联 | 核心内联 + 延迟加载 |
| 用户指令 | 无 | CLAUDE.md 多层级 |
| 环境感知 | 无 | 平台、Shell、git 状态 |
| 运行时注入 | 无 | system-reminder 标签 |
| Token 优化 | 不考虑 | 延迟加载 + 按需注入 |

系统提示词决定了 Agent "知道什么"。接下来看看当它知道的太多（上下文用完）时怎么办：[S05: 上下文压缩](/s05-compact)。
