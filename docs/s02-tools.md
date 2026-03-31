# S02: Tools (工具系统)

> **核心洞察**：循环不变，新工具只是注册到分发表中。统一的 `Tool` 接口让 Bash、文件操作、子代理、MCP 服务器都变成了同一种东西。

## 核心问题

只靠 Bash 有两个致命问题：
1. **安全** —— Shell 命令是无约束的攻击面
2. **可靠性** —— `cat` 大文件会截断，`sed` 遇到特殊字符会出错

**专用工具在工具层面强制约束**，而不是靠提示词祈祷模型不犯错。

## 教学版 vs 真实版

### 教学版 (s02) —— 字典分发

```python
TOOL_HANDLERS = {
    "bash":      lambda **kw: run_bash(kw["command"]),
    "read_file": lambda **kw: run_read(kw["path"], kw.get("limit")),
    "write_file":lambda **kw: run_write(kw["path"], kw["content"]),
    "edit_file": lambda **kw: run_edit(kw["path"], kw["old_text"], kw["new_text"]),
}

# Agent Loop 中的分发：
handler = TOOL_HANDLERS.get(block.name)
output = handler(**block.input)
```

简单直接：名字查表 → 调用函数 → 返回结果。

### 真实版 (Claude Code) —— 完整的 Tool 接口

Claude Code 的每个工具不只是一个函数，而是一个**完整的对象**，包含 schema、权限、验证、渲染等全部能力。

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/Tool.ts` | Tool 接口定义 + `buildTool()` Builder |
| `src/tools.ts` | 工具注册表 `getAllBaseTools()` |
| `src/tools/` | 45+ 工具实现目录 |
| `src/services/tools/toolExecution.ts` | 工具分发与执行管线 |
| `src/services/tools/StreamingToolExecutor.ts` | 并发工具执行器 |

## Tool 接口 —— 工具的"全量合同"

```typescript
// src/Tool.ts - 简化后的核心接口
export type Tool<Input, Output> = {
  // ====== 身份 ======
  name: string
  aliases?: string[]              // 向后兼容的别名
  searchHint?: string             // ToolSearch 关键词 (3-10 词)

  // ====== Schema ======
  inputSchema: ZodSchema<Input>   // Zod 输入验证
  outputSchema?: ZodSchema<Output>// 输出验证
  inputJSONSchema?: JSONSchema    // 发送给 LLM 的 JSON Schema

  // ====== 描述 (发送给 LLM) ======
  description(): Promise<string>  // 工具简述
  prompt(): Promise<string>       // 完整使用说明

  // ====== 生命周期 ======
  validateInput?(): Promise<ValidationResult>  // 自定义验证
  checkPermissions(): Promise<PermissionResult>// 权限检查
  call(): Promise<ToolResult<Output>>          // 执行

  // ====== 安全标注 ======
  isConcurrencySafe(input): boolean  // 是否可并发执行
  isReadOnly(input): boolean         // 是否只读
  isDestructive?(input): boolean     // 是否有破坏性

  // ====== 结果处理 ======
  maxResultSizeChars: number         // 超过则持久化到磁盘
  mapToolResultToToolResultBlockParam(): ToolResultBlockParam

  // ====== UI 渲染 ======
  userFacingName(): string
  renderToolUseMessage(): ReactNode
  renderToolResultMessage?(): ReactNode
}
```

每个字段都有明确的设计目的：

- **`inputSchema`** —— 用 Zod 进行运行时类型检查，不信任 LLM 的输出格式
- **`checkPermissions`** —— 在执行前拦截，而不是执行后补救
- **`isConcurrencySafe`** —— 让 `Read` 和 `Grep` 并发执行，但 `Write` 必须独占
- **`maxResultSizeChars`** —— 大结果自动持久化到磁盘，避免撑爆上下文

## buildTool —— Builder 模式

Claude Code 不要求每个工具实现全部接口，而是用 Builder 模式提供合理默认值：

```typescript
// src/Tool.ts
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,  // 用户定义覆盖默认值
  }
}

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,  // 默认不可并发 (安全第一)
  isReadOnly: () => false,         // 默认假设有写操作
  isDestructive: () => false,
  checkPermissions: (input) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
}
```

**Fail-closed 默认值** —— 新工具如果忘了声明安全属性，默认是"不安全"的。这比 fail-open 安全得多。

## 工具注册表

所有工具在一个中心位置注册：

```typescript
// src/tools.ts
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    BashTool,
    // 条件加载：如果有嵌入式搜索工具，则不加载 Glob/Grep
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    // 功能门控
    ...(SleepTool ? [SleepTool] : []),
    // 环境门控
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    // MCP 工具在运行时动态加载
  ]
}
```

注意 MCP 工具不在这里注册 —— 它们是运行时通过 MCP 协议发现并动态注册的（详见 [S07: MCP](/s07-mcp)）。

## 工具执行管线

当 LLM 返回 `tool_use` 块时，执行流程如下：

```typescript
// src/services/tools/toolExecution.ts - 简化后的核心流程
export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
) {
  // 1. 查找工具 (支持别名)
  const tool = findToolByName(tools, toolUse.name)
  if (!tool) {
    yield { error: 'No such tool available' }
    return
  }

  // 2. 输入验证 (Zod schema)
  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    yield { error: formatZodValidationError(parsed.error) }
    return
  }

  // 3. 自定义验证 (如 BashTool 的 sleep 循环检测)
  const validation = await tool.validateInput?.(parsed.data)
  if (validation?.result === false) {
    yield { error: validation.message }
    return
  }

  // 4. Pre-Hook (用户钩子，可修改输入)
  const { updatedInput } = await runPreToolUseHooks(tool, parsed.data)

  // 5. 权限检查
  const permission = await tool.checkPermissions(updatedInput)
  switch (permission.behavior) {
    case 'allow': break
    case 'deny':
      yield { error: permission.message }
      return
    case 'ask':
      const approved = await canUseTool(tool, updatedInput)
      if (!approved) {
        yield { error: 'Permission denied by user' }
        return
      }
  }

  // 6. 执行工具
  const result = await tool.call(updatedInput, toolUseContext)

  // 7. Post-Hook
  await runPostToolUseHooks(tool, result)

  // 8. 格式化结果
  yield tool.mapToolResultToToolResultBlockParam(result.data, toolUse.id)
}
```

这个管线就是教学版 `handler = TOOL_HANDLERS.get(name)` 的工业级版本。

## 具体工具实现

### BashTool —— 最复杂的工具

```typescript
// src/tools/BashTool/BashTool.tsx - 简化
export const BashTool = buildTool({
  name: 'Bash',
  maxResultSizeChars: 30_000,

  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
    description: z.string().optional(),
  }),

  // 读命令可以并发，写命令不行
  isConcurrencySafe(input) {
    return this.isReadOnly?.(input) ?? false
  },

  // 用 AST 分析判断是否只读
  isReadOnly(input) {
    return checkReadOnlyConstraints(input).behavior === 'allow'
  },

  // 6 阶段权限检查 (详见 S03)
  async checkPermissions(input) {
    return bashToolHasPermission(input)
  },

  // 执行 shell 命令
  async call(input, context) {
    const result = await exec(input.command, {
      timeout: input.timeout ?? 120_000,
      cwd: context.cwd,
    })
    return {
      data: { stdout: result.stdout, stderr: result.stderr }
    }
  },
})
```

### FileReadTool —— 典型的只读工具

```typescript
// src/tools/FileReadTool/FileReadTool.ts - 简化
export const FileReadTool = buildTool({
  name: 'Read',
  maxResultSizeChars: Infinity,  // 永不持久化 (避免循环: Read→file→Read)

  isConcurrencySafe: () => true,  // 只读，可并发
  isReadOnly: () => true,

  inputSchema: z.object({
    file_path: z.string(),
    offset: z.number().optional(),   // 起始行
    limit: z.number().optional(),    // 读取行数
    pages: z.string().optional(),    // PDF 页码范围
  }),

  async call(input) {
    // 自动检测格式：PDF、图片、Notebook、纯文本
    const content = await readFile(input.file_path)
    if (isPDF(input.file_path)) {
      return { data: extractPDF(content, input.pages) }
    }
    return { data: content }
  },
})
```

### FileEditTool —— 精确替换

```typescript
// src/tools/FileEditTool/FileEditTool.ts - 简化
export const FileEditTool = buildTool({
  name: 'Edit',
  maxResultSizeChars: 100_000,

  isReadOnly: () => false,
  isDestructive: () => true,

  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string(),    // 要替换的文本
    new_string: z.string(),    // 替换为的文本
    replace_all: z.boolean().optional(),
  }),

  // 关键验证：确保 old_string 确实存在于文件中
  async validateInput(input) {
    const content = await readFile(input.file_path)
    if (!content.includes(input.old_string)) {
      return { result: false, message: 'old_string not found in file' }
    }
    return { result: true }
  },

  async call(input) {
    const content = await readFile(input.file_path)
    const newContent = input.replace_all
      ? content.replaceAll(input.old_string, input.new_string)
      : content.replace(input.old_string, input.new_string)

    await writeFile(input.file_path, newContent)
    return { data: { filePath: input.file_path, diff: computeDiff(...) } }
  },
})
```

### GrepTool —— 搜索工具

```typescript
// src/tools/GrepTool/GrepTool.ts - 简化
export const GrepTool = buildTool({
  name: 'Grep',
  maxResultSizeChars: 100_000,

  isConcurrencySafe: () => true,
  isReadOnly: () => true,

  inputSchema: z.object({
    pattern: z.string(),          // 正则表达式
    path: z.string().optional(),
    glob: z.string().optional(),  // 文件过滤
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    head_limit: z.number().optional(),  // 默认 250
    // 更多 ripgrep 参数...
  }),

  async call(input) {
    // 底层调用 vendor/ripgrep
    const results = await ripGrep(input.pattern, input.path || getCwd(), {
      glob: input.glob,
      caseInsensitive: input['-i'],
    })
    return { data: applyHeadLimit(results, input.head_limit ?? 250) }
  },
})
```

## 并发工具执行

教学版顺序执行工具。Claude Code 用 `StreamingToolExecutor` 实现并发：

```typescript
// src/services/tools/StreamingToolExecutor.ts - 简化
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []

  addTool(block: ToolUseBlock, message: AssistantMessage) {
    const isSafe = tool.isConcurrencySafe(block.input)
    this.tools.push({ status: 'queued', isSafe, block, message })
    void this.processQueue()
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const running = this.tools.filter(t => t.status === 'running')
    // 如果有非并发安全的工具在运行，所有其他工具等待
    if (running.some(t => !t.isSafe)) return false
    // 如果当前工具不是并发安全的，等所有工具结束
    if (!isConcurrencySafe && running.length > 0) return false
    return true
  }
}
```

**并发规则**：
- `Read` + `Grep` + `Glob` 可以同时执行（都是 `isConcurrencySafe: true`）
- `Write` / `Edit` / `Bash` 必须独占执行
- 非安全工具等所有工具结束后才能开始

## Zod Schema —— 工具的"合同"

每个工具用 Zod 定义输入 schema，这个 schema 有双重用途：

```typescript
// 1. 发送给 LLM：转换为 JSON Schema，告诉模型参数格式
const jsonSchema = zodToJsonSchema(tool.inputSchema)
// → 发送到 API 的 tools[] 参数中

// 2. 运行时验证：LLM 返回的 input 未必合法
const parsed = tool.inputSchema.safeParse(toolUse.input)
if (!parsed.success) {
  // 返回格式化的错误给 LLM，让它重试
  return formatZodValidationError(parsed.error)
}
```

**为什么不信任 LLM 的输出？** 因为 LLM 可能：
- 返回错误的类型（字符串代替数字）
- 遗漏必需字段
- 添加不存在的字段
- 返回空对象

Zod 在这里充当了防御层。

## 关键设计决策

### 为什么用 Builder 而不是 Class 继承？

```typescript
// 不是这样:
class MyTool extends BaseTool {
  name = 'MyTool'
  async call() { ... }
}

// 而是这样:
const MyTool = buildTool({
  name: 'MyTool',
  async call() { ... },
})
```

原因：
1. **组合 > 继承** —— 不同工具的特性是正交的，用继承会产生菱形继承
2. **默认值透明** —— Builder 的默认值在一个地方定义，一目了然
3. **类型推断** —— TypeScript 对对象字面量的类型推断比 class 更强

### 为什么 `maxResultSizeChars` 差异如此之大？

| 工具 | 限制 | 原因 |
|------|------|------|
| BashTool | 30,000 | 命令输出可能很大，需要截断 |
| FileEditTool | 100,000 | diff 可能很长 |
| FileReadTool | Infinity | 读取结果不应持久化，避免循环引用 |
| GrepTool | 100,000 | 搜索结果有 head_limit 控制 |

## 本章小结

| 维度 | 教学版 (s02) | Claude Code |
|------|-------------|-------------|
| 分发 | 字典查表 | `findToolByName()` + 别名 |
| 定义 | lambda 函数 | 完整 `Tool` 接口 + Builder |
| 验证 | 无 | Zod schema + 自定义 validate |
| 权限 | `safe_path()` | 多阶段权限检查管线 |
| 并发 | 顺序执行 | `StreamingToolExecutor` 智能并发 |
| 工具数量 | 4 | 45+ |
| 安全默认值 | 无 | fail-closed (`isConcurrencySafe: false`) |

工具系统的核心设计是 **"统一接口 + 安全默认 + 分层验证"**。接下来看看验证中最关键的环节：[S03: 权限系统](/s03-permissions)。
