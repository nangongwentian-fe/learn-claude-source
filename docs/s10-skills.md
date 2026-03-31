# S10: Skills & CLAUDE.md

> **核心洞察**：按需加载知识，而不是预先灌入。两层注入 —— 系统提示词中放目录，tool_result 中放全文 —— 用最少的 token 提供最多的知识。

## 核心问题

Claude Code 有几十种技能（commit、review-pr、pdf 处理等），每个技能的完整提示词可能有 2000+ token。如果全部预加载：

```
10 个技能 × 2000 token = 20,000 token —— 大部分在任何给定任务中都是浪费
```

**解法**：目录放在系统提示词（廉价），全文在需要时加载（按需）。

## 教学版 vs 真实版

### 教学版 (s05) —— 两层注入

```python
# Layer 1: 系统提示词中放名称+描述 (~100 token/skill)
SYSTEM = f"""Available skills:
{skill_loader.get_descriptions()}
Call load_skill(name) to get full instructions."""

# Layer 2: tool_result 中放完整内容
def load_skill(name: str) -> str:
    return skill_loader.get_content(name)
```

### 真实版 (Claude Code) —— 相同模式，更多层级

Claude Code 的技能系统在教学版基础上增加了：
- 用户自定义技能
- 技能市场
- 自动触发
- 技能参数

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/tools/SkillTool/` | 技能加载工具 |
| `src/services/plugins/` | 插件/技能发现与管理 |
| `src/utils/claudemd.ts` | CLAUDE.md 解析 |

## Skills 架构

```
技能来源
├── 内置技能 (Claude Code 自带)
│   ├── commit          # Git 提交
│   ├── review-pr       # PR 审查
│   ├── pdf             # PDF 处理
│   └── ...
├── 用户技能 (~/.claude/skills/)
│   ├── my-deploy/SKILL.md
│   └── my-lint/SKILL.md
└── 项目技能 (.claude/skills/)
    └── team-conventions/SKILL.md
```

### 技能文件格式

```markdown
---
name: code-review
description: Review code changes for quality, security, and best practices
trigger: when user says "review", "check my code", "/review"
---

# Code Review Skill

When reviewing code, follow these steps:

1. Read the changed files
2. Check for security issues (OWASP top 10)
3. Verify error handling
4. Check naming conventions
...
```

## 两层注入的实现

### Layer 1: 技能目录 (系统提示词)

```typescript
// 在系统提示词中注入技能列表
function injectSkillCatalog(systemPrompt: string, skills: Skill[]): string {
  if (skills.length === 0) return systemPrompt

  const catalog = skills.map(skill =>
    `- ${skill.name}: ${skill.description}`
  ).join('\n')

  return systemPrompt + `\n\n<system-reminder>
The following skills are available for use with the Skill tool:
${catalog}
</system-reminder>`
}
```

这只消耗每个技能约 20-50 token（名称 + 一行描述）。

### Layer 2: 技能全文 (tool_result)

```typescript
// src/tools/SkillTool/ - 简化
const SkillTool = buildTool({
  name: 'Skill',

  inputSchema: z.object({
    skill: z.string(),       // 技能名称
    args: z.string().optional(), // 可选参数
  }),

  async call(input, context) {
    // 1. 查找技能
    const skill = findSkill(input.skill)
    if (!skill) {
      return { data: `Skill "${input.skill}" not found` }
    }

    // 2. 加载完整内容
    const content = await loadSkillContent(skill)

    // 3. 返回完整提示词（通过 tool_result 注入到对话中）
    return {
      data: `<skill name="${skill.name}">\n${content}\n</skill>`,
    }
  },
})
```

**关键**：技能内容通过 `tool_result` 返回，而不是修改系统提示词。这意味着：
- 内容出现在对话历史中，不会在压缩时丢失（除非被 compact）
- 模型可以在后续轮次引用技能内容
- 多个技能可以按需依次加载

## 用户触发 vs 自动触发

```typescript
// 用户显式触发
// 用户输入: /commit
// → 匹配技能名 → 调用 SkillTool

// 自动触发 (通过 trigger 描述)
// 技能 frontmatter: trigger: "when user says review"
// 模型看到系统提示词中的描述，自行决定是否调用 load_skill
```

## CLAUDE.md 与 Skills 的关系

| 维度 | CLAUDE.md | Skills |
|------|-----------|--------|
| 加载时机 | 会话开始时自动加载 | 按需加载 |
| 放置位置 | 系统提示词 | tool_result |
| 用途 | 持久的行为规范 | 特定任务的操作指南 |
| Token 成本 | 每轮都消耗 | 仅加载后消耗 |
| 例子 | "使用中文回复" | "如何做 Code Review" |

CLAUDE.md 是"你应该一直知道的"，Skills 是"你需要时再查的"。

## 延迟工具加载 (ToolSearch)

Skills 的思想也应用到了工具本身 —— 不常用的工具通过 ToolSearch 延迟加载：

```typescript
// 系统提示词中列出延迟工具的名称
<system-reminder>
The following deferred tools are available via ToolSearch:
WebFetch, WebSearch, TaskCreate, TaskUpdate, NotebookEdit, ...
</system-reminder>

// 模型需要时调用 ToolSearch 获取完整 schema
const ToolSearchTool = buildTool({
  name: 'ToolSearch',
  async call(input) {
    const { query, max_results } = input
    // 匹配延迟工具，返回完整 JSON Schema
    const matches = searchDeferredTools(query, max_results)
    return { data: formatToolSchemas(matches) }
  },
})
```

**效果**：
- 核心工具（Bash, Read, Edit, Write, Glob, Grep, Agent）始终可用
- 45+ 其他工具只在需要时加载 schema
- 节省了大量 token

## 简化实现

```typescript
// 两层技能系统的简化实现
interface Skill {
  name: string
  description: string
  content: string  // 完整提示词
}

class SkillLoader {
  private skills: Map<string, Skill> = new Map()

  constructor(skillDirs: string[]) {
    for (const dir of skillDirs) {
      // 扫描 SKILL.md 文件
      const files = glob(`${dir}/*/SKILL.md`)
      for (const file of files) {
        const { frontmatter, body } = parseFrontmatter(readFile(file))
        this.skills.set(frontmatter.name, {
          name: frontmatter.name,
          description: frontmatter.description,
          content: body,
        })
      }
    }
  }

  // Layer 1: 返回目录 (放入系统提示词)
  getCatalog(): string {
    return Array.from(this.skills.values())
      .map(s => `- ${s.name}: ${s.description}`)
      .join('\n')
  }

  // Layer 2: 返回全文 (通过 tool_result)
  getContent(name: string): string | null {
    return this.skills.get(name)?.content ?? null
  }
}
```

## 关键设计决策

### 为什么不把所有技能放入 CLAUDE.md？

1. **Token 效率** —— 大部分技能在任何给定任务中都不需要
2. **可维护性** —— 技能可以独立更新，不影响基础配置
3. **可发现性** —— 目录让模型知道有什么可用

### 为什么技能是 Markdown 而不是 JSON？

1. **可读性** —— 人类可以直接阅读和编辑
2. **表达力** —— Markdown 支持代码块、列表、标题等富格式
3. **灵活性** —— 没有 schema 约束，可以包含任何指令

### 为什么 `/commit` 是技能而不是命令？

技能的执行方式是"注入提示词，让模型自行完成"，而不是"执行预定义的代码"。这意味着：
- 模型可以根据上下文灵活调整行为
- 不需要为每种变体写代码
- 用户可以自定义技能行为

## 本章小结

| 维度 | 全量加载 | 两层注入 |
|------|---------|----------|
| 初始 token | 20,000+ | ~500 (仅目录) |
| 按需 token | 0 | ~2000 (每个加载的技能) |
| 模型知道可用技能 | 是 | 是 (通过目录) |
| 模型有完整指令 | 始终 | 仅加载后 |
| 可扩展性 | 差 (token 线性增长) | 好 (目录增长极慢) |

知识按需加载是 Agent 高效利用 token 的关键策略。接下来看看 Agent 如何管理自身状态 —— [S11: State & Session](/s11-state)。
