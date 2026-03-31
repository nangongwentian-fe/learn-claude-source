# 架构全景

本页提供 Claude Code 的完整架构鸟瞰图，帮助你在深入各章节之前建立全局认知。

## 请求生命周期

一次用户输入从键入到响应完成的完整路径：

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  CLI 入口 (entrypoints/cli.tsx)                          │
│  ├── 快速路径: --version, --dump-system-prompt 等        │
│  └── 主路径: main.tsx → Commander.js 命令注册             │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  REPL 层 (hooks/useReplBridge.tsx)                       │
│  ├── 文本输入捕获 (hooks/useTextInput.ts)                │
│  ├── 命令解析 (/ 前缀命令 vs 自然语言)                    │
│  └── 上下文分析 (utils/analyzeContext.ts)                 │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  QueryEngine (QueryEngine.ts)                            │
│  ├── submitMessage() - 消息生命周期管理                   │
│  ├── processUserInput() - 用户输入处理                    │
│  ├── 消息累积 (mutableMessages[])                        │
│  └── 会话持久化 (recordTranscript)                        │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Agent Loop (query.ts → queryLoop)                       │
│  ┌─────────────────────────────────────────────────┐    │
│  │  while (true) {                                  │    │
│  │    // 1. 构建系统提示词                           │    │
│  │    // 2. 调用 LLM API (流式)                     │    │
│  │    // 3. 处理流式事件                             │    │
│  │    // 4. 检查 stop_reason                         │    │
│  │    // 5. 如果有 tool_use → 执行工具               │    │
│  │    // 6. 将工具结果追加到 messages                 │    │
│  │    // 7. 回到步骤 2                               │    │
│  │    // 如果 stop_reason !== "tool_use" → 退出      │    │
│  │  }                                               │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  工具执行层 (services/tools/)                            │
│  ├── toolExecution.ts - 工具分发与执行                    │
│  ├── StreamingToolExecutor.ts - 并发工具执行              │
│  ├── 权限检查 → 输入验证 → Pre-Hook → 执行 → Post-Hook  │
│  └── 结果格式化 → 返回给 Agent Loop                      │
└─────────────────────────────────────────────────────────┘
```

## 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│                        UI 层 (Ink/React)                      │
│  components/ ─ 146 个终端 UI 组件                             │
│  ink/ ─ 50 个底层 Ink 组件 (布局、输入、样式)                  │
│  context/ ─ React Context (通知、模态框、覆盖层)              │
├──────────────────────────────────────────────────────────────┤
│                        Hook 层                                │
│  hooks/ ─ 87 个 React Hooks                                  │
│  ├── useReplBridge ─ REPL 通信桥                              │
│  ├── useTextInput ─ 文本输入处理                              │
│  ├── useCanUseTool ─ 工具可用性检查                           │
│  ├── useIDEIntegration ─ IDE 集成                             │
│  └── useVoiceIntegration ─ 语音集成                           │
├──────────────────────────────────────────────────────────────┤
│                      核心引擎层                               │
│  QueryEngine.ts ─ 查询引擎 (消息生命周期)                     │
│  query.ts ─ Agent Loop (while true 核心循环)                  │
│  Tool.ts ─ 工具接口与 Builder 模式                            │
│  tools.ts ─ 工具注册表                                        │
├──────────────────────────────────────────────────────────────┤
│                       工具层                                  │
│  tools/ ─ 45+ 内置工具                                       │
│  ├── 文件操作: Read, Write, Edit, Glob, Grep                 │
│  ├── 执行: Bash, PowerShell, REPL                             │
│  ├── 代理: Agent, Task*, SendMessage                          │
│  ├── 网络: WebFetch, WebSearch                                │
│  ├── 集成: MCP, Skill, LSP, Notebook                         │
│  └── 规划: EnterPlanMode, EnterWorktree, Cron                │
├──────────────────────────────────────────────────────────────┤
│                       服务层                                  │
│  services/ ─ 38 个服务模块                                    │
│  ├── api/ ─ Anthropic API 客户端 (流式、重试、缓存)           │
│  ├── mcp/ ─ MCP 协议 (连接管理、工具注册、OAuth)              │
│  ├── compact/ ─ 上下文压缩 (三层策略)                         │
│  ├── lsp/ ─ Language Server Protocol                          │
│  └── plugins/ ─ 插件发现与加载                                │
├──────────────────────────────────────────────────────────────┤
│                      基础设施层                               │
│  utils/ ─ 331 个工具模块                                      │
│  ├── permissions/ ─ 多层权限系统                              │
│  ├── settings/ ─ 设置层级 (用户/项目/本地/策略/MDM)           │
│  ├── hooks.ts ─ 用户钩子 (Pre/Post ToolUse)                  │
│  ├── auth.ts ─ 认证 (API Key, OAuth)                          │
│  ├── config.ts ─ 全局配置                                     │
│  └── model/ ─ 模型选择与废弃管理                              │
├──────────────────────────────────────────────────────────────┤
│                      运行时层                                 │
│  bridge/ ─ REPL 桥接 (本地/远程)                              │
│  state/ ─ AppState 状态管理                                   │
│  commands/ ─ 101 个 CLI 命令                                  │
│  vendor/ ─ 原生绑定 (ripgrep, audio, image)                   │
└──────────────────────────────────────────────────────────────┘
```

## 关键数据流

### 工具调用流

```
LLM 返回 tool_use block
  │
  ▼
findToolByName(tools, name)          ─── 查找工具
  │
  ▼
inputSchema.safeParse(input)         ─── Zod 输入验证
  │
  ▼
tool.validateInput()                 ─── 自定义验证
  │
  ▼
runPreToolUseHooks()                 ─── Pre-Hook (可修改输入)
  │
  ▼
tool.checkPermissions()              ─── 权限检查
  │                                       ├── allow → 继续
  │                                       ├── deny → 返回错误
  │                                       └── ask → 显示对话框
  ▼
tool.call(input, context)            ─── 执行工具
  │
  ▼
runPostToolUseHooks()                ─── Post-Hook
  │
  ▼
mapToolResultToToolResultBlockParam  ─── 格式化结果
  │
  ▼
追加到 messages[] → 回到 Agent Loop
```

### 权限检查流 (以 BashTool 为例)

```
bashToolHasPermission(input)
  │
  ├─ Stage 1: AST 解析 (tree-sitter)
  │   └─ 解析 shell 命令为 AST，识别子命令
  │
  ├─ Stage 2: 语义检查
  │   └─ 检测 eval、危险内建命令等
  │
  ├─ Stage 3: 沙箱自动允许
  │   └─ 沙箱模式下的安全命令自动通过
  │
  ├─ Stage 4: 精确匹配
  │   └─ 检查用户配置的精确规则
  │
  ├─ Stage 5: AI 分类器
  │   └─ 用 LLM 判断命令是否匹配规则
  │
  └─ Stage 6: 回退到 "ask"
      └─ 让用户手动决定
```

### 上下文压缩流

```
每轮对话后检查 token 使用量
  │
  ├─ Layer 1: Micro-Compact (每轮自动)
  │   └─ 替换旧工具结果为占位符 "[Previous: used {tool}]"
  │
  ├─ Layer 2: Auto-Compact (超过阈值)
  │   ├─ 保存完整转录到 .transcripts/
  │   ├─ 请求 LLM 生成摘要
  │   └─ 替换所有消息为压缩摘要
  │
  └─ Layer 3: Manual Compact (手动触发)
      └─ compact 工具触发立即压缩

压缩后恢复:
  ├─ 重新注入最近 5 个文件内容 (每个 5K tokens)
  ├─ 重新加载相关技能 (25K token 预算)
  └─ 控制总量不超过 50K tokens
```

## 进程类型

Claude Code 不只是一个 CLI，它支持多种运行模式：

| 进程类型 | 入口 | 用途 |
|---------|------|------|
| 交互式 REPL | `claude` | 标准 CLI 使用 |
| 远程控制 | `claude remote-control` | 从云端控制本地机器 |
| 守护进程 | `claude daemon` | 后台任务监督 |
| 后台会话 | `claude --bg` | 后台执行任务 |
| MCP 服务器 | `--claude-in-chrome-mcp` | Chrome 扩展集成 |
| 环境运行器 | `environment-runner` | BYOC 无头执行 |

## 编译时特性标志

Claude Code 使用 Bun 的 `feature()` 实现编译时死代码消除：

```typescript
// 只有在构建时启用 BRIDGE_MODE 标志才会包含此代码
if (feature("BRIDGE_MODE")) {
  // 远程控制相关代码
}
```

主要标志包括：`BRIDGE_MODE`, `DAEMON`, `BG_SESSIONS`, `TEMPLATES`, `COORDINATOR_MODE`, `CHICAGO_MCP` 等。

---

建立了全局认知后，让我们从最核心的部分开始：[S01: Agent Loop](/s01-agent-loop)。
