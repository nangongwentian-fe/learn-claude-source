# S08: Hooks (钩子系统)

> **核心洞察**：Hooks 让用户在不修改 Claude Code 源码的情况下，在关键事件节点注入自定义逻辑 —— 审计日志、自动格式化、安全过滤、通知推送等。

## 核心问题

用户需要在 Agent 执行过程中自定义行为，但不想：
- Fork Claude Code 源码
- 写 MCP 服务器
- 每次都手动检查

例如：
- 每次文件写入后自动运行 `prettier`
- 每次 Bash 命令执行前记录审计日志
- 阻止某些特定操作（比如 `git push --force`）
- 命令失败后发送 Slack 通知

## Hooks 是什么

Hooks 是用户配置的 **Shell 命令**，在特定事件发生时自动执行：

```json
// ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": ["python3 /path/to/audit.py"]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": ["npx prettier --write $FILE_PATH"]
      }
    ]
  }
}
```

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/utils/hooks.ts` | 钩子核心逻辑 |
| `src/utils/hooks/` | 钩子相关工具函数 |
| `src/services/tools/toolExecution.ts` | 钩子在工具管线中的集成点 |

## 事件类型

Claude Code 支持丰富的事件类型：

```typescript
type HookEvent =
  // 工具生命周期
  | 'PreToolUse'            // 工具执行前 (可修改输入、阻止执行)
  | 'PostToolUse'           // 工具执行后 (可修改输出)
  | 'PostToolUseFailure'    // 工具执行失败后
  | 'PermissionDenied'      // 权限被拒绝时

  // 会话生命周期
  | 'SessionStart'          // 会话开始
  | 'SessionEnd'            // 会话结束
  | 'Stop'                  // Agent 停止

  // 用户交互
  | 'UserPromptSubmit'      // 用户提交输入
  | 'Notification'          // 通知事件

  // 文件与配置
  | 'FileChanged'           // 文件变更
  | 'ConfigChange'          // 配置变更
  | 'CwdChanged'            // 工作目录变更
  | 'InstructionsLoaded'    // CLAUDE.md 加载

  // 多代理
  | 'SubagentStart'         // 子代理启动
  | 'SubagentEnd'           // 子代理结束
  | 'TeammateStart'         // 队友启动
  | 'TeammateEnd'           // 队友结束

  // 任务
  | 'TaskCreate'            // 任务创建
  | 'TaskUpdate'            // 任务更新
```

## Hook 执行流程

### PreToolUse Hook

```typescript
// src/utils/hooks.ts - 简化
async function* runPreToolUseHooks(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): AsyncGenerator<HookResult> {
  const hooks = getMatchingHooks('PreToolUse', tool.name)

  for (const hook of hooks) {
    // 1. 准备 hook 的输入 (JSON via stdin)
    const hookInput = {
      event: 'PreToolUse',
      tool_name: tool.name,
      tool_input: input,
      session_id: context.sessionId,
      cwd: context.cwd,
    }

    // 2. 执行 hook 命令
    const result = await execHook(hook.command, hookInput, {
      timeout: 30_000,  // 30 秒超时
    })

    // 3. 解析 hook 的输出 (JSON via stdout)
    if (result.stdout) {
      const output = JSON.parse(result.stdout)

      // Hook 可以修改输入
      if (output.updatedInput) {
        input = { ...input, ...output.updatedInput }
      }

      // Hook 可以阻止执行
      if (output.block) {
        yield { blocked: true, message: output.message }
        return
      }

      // Hook 可以发送通知
      if (output.notification) {
        yield { notification: output.notification }
      }
    }
  }

  yield { updatedInput: input }
}
```

### PostToolUse Hook

```typescript
async function* runPostToolUseHooks(
  tool: Tool,
  result: ToolResult,
  context: ToolUseContext,
): AsyncGenerator<HookResult> {
  const hooks = getMatchingHooks('PostToolUse', tool.name)

  for (const hook of hooks) {
    const hookInput = {
      event: 'PostToolUse',
      tool_name: tool.name,
      tool_result: result,
      session_id: context.sessionId,
    }

    const hookResult = await execHook(hook.command, hookInput, {
      timeout: 30_000,
    })

    if (hookResult.stdout) {
      const output = JSON.parse(hookResult.stdout)
      // Hook 可以修改输出
      if (output.updatedResult) {
        result = { ...result, ...output.updatedResult }
      }
    }
  }
}
```

## Hook 匹配

通过 `matcher` 字段指定 hook 在哪些工具上生效：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",           // 精确匹配工具名
        "hooks": ["./audit.sh"]
      },
      {
        "matcher": "Write|Edit",     // 正则匹配
        "hooks": ["./format.sh"]
      },
      {
        "matcher": ".*",             // 匹配所有工具
        "hooks": ["./log-all.sh"]
      }
    ]
  }
}
```

匹配支持条件过滤：

```json
{
  "matcher": "Bash",
  "if": "rm -rf",               // 只在命令包含 "rm -rf" 时触发
  "hooks": ["./block-rm.sh"]
}
```

## Hook 的输入/输出协议

Hook 通过 stdin 接收 JSON，通过 stdout 返回 JSON：

```
Claude Code                           Hook 进程
    │                                     │
    ├── stdin: {                          │
    │     "event": "PreToolUse",          │
    │     "tool_name": "Bash",            │
    │     "tool_input": {                 │
    │       "command": "npm test"         │
    │     }                               │
    │   }                                 │
    │                                     │
    │                     stdout: {  ←────┤
    │                       "block": false,│
    │                       "updatedInput":│
    │                       null          │
    │                     }               │
    │                                     │
```

### Hook 输出格式

```typescript
interface HookOutput {
  // 阻止执行
  block?: boolean
  message?: string        // 阻止原因

  // 修改输入 (PreToolUse)
  updatedInput?: Record<string, unknown>

  // 修改结果 (PostToolUse)
  updatedResult?: unknown

  // 发送通知
  notification?: string

  // 静默 (不显示给用户)
  silent?: boolean
}
```

## 在工具管线中的位置

```
LLM 返回 tool_use
  │
  ▼
inputSchema.safeParse()         ── 输入验证
  │
  ▼
tool.validateInput()            ── 自定义验证
  │
  ▼
┌─ runPreToolUseHooks() ────┐   ← Hook 注入点 1
│  ├── 审计日志              │
│  ├── 输入修改              │
│  └── 可能阻止执行          │
└───────────────────────────┘
  │
  ▼
tool.checkPermissions()         ── 权限检查
  │
  ▼
tool.call()                     ── 执行工具
  │
  ▼
┌─ runPostToolUseHooks() ───┐   ← Hook 注入点 2
│  ├── 结果修改              │
│  ├── 自动格式化            │
│  └── 通知推送              │
└───────────────────────────┘
  │
  ▼
返回给 Agent Loop
```

## 实用 Hook 示例

### 1. 审计日志

```bash
#!/bin/bash
# audit-hook.sh - 记录所有工具调用
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
echo "$(date) | $TOOL | $COMMAND" >> ~/.claude/audit.log
echo '{}' # 空输出 = 不修改
```

### 2. 自动格式化

```bash
#!/bin/bash
# format-hook.sh - 文件写入后自动格式化
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_result.data.filePath // empty')
if [[ "$FILE" == *.ts ]] || [[ "$FILE" == *.tsx ]]; then
  npx prettier --write "$FILE" 2>/dev/null
fi
echo '{}'
```

### 3. 阻止危险命令

```bash
#!/bin/bash
# block-dangerous.sh - 阻止危险的 git 命令
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if echo "$COMMAND" | grep -q "git push.*--force"; then
  echo '{"block": true, "message": "Force push is not allowed by hook policy"}'
else
  echo '{}'
fi
```

### 4. Slack 通知

```bash
#!/bin/bash
# notify-failure.sh - 工具失败时通知 Slack
INPUT=$(cat)
ERROR=$(echo "$INPUT" | jq -r '.tool_result.error // empty')
if [ -n "$ERROR" ]; then
  curl -X POST "$SLACK_WEBHOOK" -d "{\"text\": \"Claude Code error: $ERROR\"}"
fi
echo '{}'
```

## UserPromptSubmit Hook

特殊的 hook，在用户提交输入时触发：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": ["python3 ./translate-input.py"]
      }
    ]
  }
}
```

这可以用于：
- 输入预处理
- 添加上下文
- 输入过滤

## 关键设计决策

### 为什么是 Shell 命令而不是 JavaScript 插件？

1. **语言无关** —— 用任何语言写 hook
2. **安全隔离** —— 独立进程，crash 不影响主程序
3. **简单** —— 不需要学习插件 API

### 为什么用 JSON stdin/stdout 而不是环境变量？

1. **结构化数据** —— 环境变量只能传字符串
2. **大数据量** —— 工具结果可能很大，环境变量有长度限制
3. **双向通信** —— stdin 传入数据，stdout 返回结果

### 为什么 PreToolUse Hook 在权限检查之前？

实际上是在 `validateInput` 之后，`checkPermissions` 之前。这个顺序允许 hook：
- 先修改输入（可能改变权限判断结果）
- 先阻止执行（比权限检查更快）

### 为什么有 30 秒超时？

防止 hook 死锁导致整个 Agent 卡住。30 秒足够做日志、格式化等操作，但不够做复杂的网络请求 —— 如果 hook 需要更长时间，应该异步执行。

## 本章小结

| 维度 | 说明 |
|------|------|
| 事件类型 | 20+ 种 (工具、会话、文件、多代理) |
| 执行方式 | Shell 命令 (stdin JSON → stdout JSON) |
| 能力 | 阻止执行、修改输入/输出、发送通知 |
| 超时 | 30s (工具 hook) / 60s (会话 hook) |
| 匹配 | 工具名 + 可选条件过滤 |
| 配置 | settings.json 的 hooks 字段 |

Hooks 是 Claude Code 的"中间件系统"。接下来看看数据如何在整个管线中流式传输 —— [S09: Streaming](/s09-streaming)。
