# S12: CLI & Architecture (CLI 与架构)

> **核心洞察**：Claude Code 不只是一个 REPL —— 它是一个多模式运行时，支持交互式、后台、远程、守护进程等多种运行方式，全部从同一个入口分发。

## 核心问题

一个工业级 CLI 工具需要处理：
- 多种运行模式（交互式、管道、后台、远程）
- 启动性能（13MB 编译产物的快速启动）
- 命令路由（101 个子命令）
- 配置加载（7 层设置来源）
- 进程管理（守护进程、后台会话）

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/entrypoints/cli.tsx` | CLI 入口点 |
| `src/main.tsx` | 主程序初始化 |
| `src/commands/` | 101 个命令目录 |
| `src/bridge/` | REPL 桥接层 |
| `src/bridge/replBridge.ts` | REPL 桥接核心 (~10K 行) |

## 入口点 —— 快速路径分发

启动的第一步是**快速路径检查**，在加载完整程序之前处理简单请求：

```typescript
// src/entrypoints/cli.tsx - 简化
async function main() {
  const args = process.argv.slice(2)

  // ===== 快速路径 (零导入，毫秒级响应) =====

  // --version: 不需要加载任何模块
  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION)
    process.exit(0)
  }

  // --dump-system-prompt: 输出系统提示词
  if (feature('DUMP_SYSTEM_PROMPT') && args.includes('--dump-system-prompt')) {
    await dumpSystemPrompt()
    process.exit(0)
  }

  // ===== 编译时特性门控的快速路径 =====

  // 远程控制模式
  if (feature('BRIDGE_MODE') && ['remote-control', 'rc', 'remote'].includes(args[0])) {
    const { startBridge } = await import('./bridge/bridgeMain')
    await startBridge()
    return
  }

  // 守护进程模式
  if (feature('DAEMON') && args[0] === 'daemon') {
    const { startDaemon } = await import('./daemon/main')
    await startDaemon()
    return
  }

  // 后台会话管理
  if (feature('BG_SESSIONS') && ['ps', 'logs', 'attach', 'kill'].includes(args[0])) {
    const { handleBgCommand } = await import('./bg/commands')
    await handleBgCommand(args[0], args.slice(1))
    return
  }

  // ===== 主路径 =====
  const { startMain } = await import('./main')
  await startMain(args)
}
```

### 编译时特性标志

```typescript
// feature() 在编译时被替换为 true/false
// Bun 的死代码消除会移除不需要的代码路径
if (feature('BRIDGE_MODE')) {
  // 这段代码只在支持远程控制的构建中存在
}
```

**效果**：不需要的功能在编译时就被剔除，减小了产物体积和启动时间。

## 主程序初始化

```typescript
// src/main.tsx - 简化的初始化流程
async function startMain(args: string[]) {
  // ===== 并行初始化 (性能优化) =====
  const [
    mdmSettings,        // MDM 设备管理设置
    keychainToken,      // Keychain API Key
    bootstrapData,      // API 启动数据
  ] = await Promise.all([
    loadMDMSettings(),
    prefetchKeychainToken(),
    fetchBootstrapData(),
  ])

  // ===== 顺序初始化 =====

  // 1. 系统上下文
  const systemContext = await buildSystemContext({
    platform: process.platform,
    shell: process.env.SHELL,
    cwd: process.cwd(),
  })

  // 2. 用户上下文
  const userContext = await buildUserContext({
    settings: await loadAllSettings(),
    auth: await resolveAuth(),
  })

  // 3. 策略限制
  const policyLimits = await loadPolicyLimits()

  // 4. 工具注册
  const tools = await getTools({
    settings: userContext.settings,
    mcpConfigs: await loadMCPConfig(),
  })

  // 5. 命令注册 (Commander.js)
  const program = createCommanderProgram()
  registerAllCommands(program, tools, userContext)

  // 6. 启动 REPL
  await startRepl(program, tools, systemContext, userContext)
}
```

### 并行初始化

```
启动                  ──┬── MDM 设置加载
                       ├── Keychain 预取
                       └── Bootstrap API
                       │
时间 ─────────────────────────────────────────→
                       │
                       ▼
                    并行完成 → 顺序初始化 → REPL 启动
```

三个独立的 I/O 操作并行执行，减少了启动时间。

## 命令系统

101 个命令通过 Commander.js 注册：

```
src/commands/
├── init/           # 初始化项目
├── config/         # 管理配置
├── doctor/         # 诊断问题
├── export/         # 导出对话
├── help/           # 帮助
├── insights/       # 使用分析
├── permissions/    # 权限管理
├── ps/             # 后台会话列表
├── update/         # 自我更新
├── install-github-app/  # GitHub App 安装
├── install-slack-app/   # Slack App 安装
└── ... (101 个目录)
```

每个命令是一个目录，包含 `index.ts` 导出命令定义：

```typescript
// src/commands/doctor/index.ts - 命令定义模式
export const doctorCommand = {
  name: 'doctor',
  description: 'Check for common issues',
  action: async (options) => {
    // 检查 API Key
    const apiKeyOk = await checkApiKey()
    // 检查网络连接
    const networkOk = await checkNetwork()
    // 检查 MCP 服务器
    const mcpOk = await checkMCPServers()
    // ...
    displayResults({ apiKeyOk, networkOk, mcpOk })
  },
}
```

## REPL 层

交互式 REPL 是 Claude Code 最主要的使用方式：

```typescript
// REPL 循环 (简化)
async function startRepl(tools, context) {
  const queryEngine = new QueryEngine({ tools, context })

  while (true) {
    // 1. 等待用户输入
    const input = await getUserInput()

    // 2. 检查是否是命令
    if (input.startsWith('/')) {
      await handleSlashCommand(input)
      continue
    }
    if (input.startsWith('!')) {
      await executeShellCommand(input.slice(1))
      continue
    }

    // 3. 提交给 Agent
    for await (const message of queryEngine.submitMessage(input)) {
      renderMessage(message)  // 流式渲染到终端
    }
  }
}
```

### REPL 快捷键

```
Enter          # 提交输入
Shift+Enter    # 多行输入
Ctrl+C         # 中断当前操作
Ctrl+D         # 退出
Escape          # 取消当前输入
↑/↓            # 历史导航
/              # 斜杠命令
!              # Shell 命令
```

## 多模式运行

### 管道模式

```bash
echo "fix the bug in auth.ts" | claude
cat error.log | claude "explain this error"
```

### 非交互模式

```bash
claude -p "create a hello world app" --output-format json
```

### 后台模式

```bash
claude --bg "run all tests and fix failures"
# 返回 session ID，不阻塞终端
```

### 远程控制模式

```bash
claude remote-control
# 本地机器作为 bridge，接收远程指令
```

## 编译与产物

```
源码 (TypeScript + JSX)
  │
  ▼ Bun 编译
  │
  ├── cli.js (13MB) ─── 单文件可执行
  │   ├── 所有 TypeScript 编译为 JavaScript
  │   ├── 所有依赖打包 (node_modules)
  │   ├── React/Ink 运行时
  │   └── 编译时特性标志内联
  │
  ├── cli.js.map (59MB) ─── Source Map (调试用)
  │
  └── sdk-tools.d.ts ─── SDK 类型定义
```

**为什么单文件？**
- npm 安装后不需要 `node_modules`
- 启动时不需要模块解析
- 分发简单（一个文件）

## vendor 原生绑定

```
vendor/
├── audio-capture/    # 语音输入 (Node.js native addon)
├── ripgrep/          # 搜索引擎 (Rust 编译的二进制)
├── image-processor/  # 图片处理 (Sharp)
└── url-handler/      # URL 处理
```

这些是平台相关的原生二进制，不能打包到 `cli.js` 中。

## 完整架构回顾

```
                    ┌─────────────────────┐
                    │    用户输入          │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼───────────────────┐
          │                    │                    │
    ┌─────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐
    │ 交互式 REPL│      │ 管道/非交互  │     │ 后台/远程    │
    └─────┬─────┘      └──────┬──────┘     └──────┬──────┘
          │                    │                    │
          └────────────────────┼───────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │    QueryEngine      │  ← 消息生命周期
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Agent Loop        │  ← while(true)
                    │   (query.ts)        │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
          ┌──────▼──────┐     │      ┌──────▼──────┐
          │ System      │     │      │ Compact     │
          │ Prompt      │     │      │ (压缩)      │
          └─────────────┘     │      └─────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   API Client      │  ← 流式调用
                    │   (claude.ts)     │
                    └─────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
       ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
       │   Hooks     │ │ Permissions│ │  Tools      │
       │  (Pre/Post) │ │ (6 stages) │ │ (45+ 内置)  │
       └─────────────┘ └────────────┘ └──────┬──────┘
                                             │
                              ┌──────────────┼──────────────┐
                              │              │              │
                       ┌──────▼──┐    ┌──────▼──┐    ┌─────▼──────┐
                       │ Bash    │    │ File    │    │ Agent      │
                       │ Tool    │    │ Tools   │    │ (子代理)    │
                       └─────────┘    └─────────┘    └────────────┘
                                                          │
                                                     ┌────▼────┐
                                                     │ MCP     │
                                                     │ Servers │
                                                     └─────────┘
```

## 从 30 行到 30,000+ 行

回顾整个教程的演进：

```
S01: Agent Loop      ── while(true) + stop_reason
  │
  ├── S02: Tools     ── 统一 Tool 接口 + 分发表
  │     │
  │     └── S03: Permissions ── 多层权限检查管线
  │
  ├── S04: System Prompt ── 动态构建 + CLAUDE.md
  │     │
  │     └── S05: Compact ── 三层上下文压缩
  │
  ├── S06: Subagents ── 独立上下文 + 工具集隔离
  │     │
  │     ├── S07: MCP  ── 标准协议扩展
  │     │
  │     └── S08: Hooks ── 事件驱动中间件
  │
  └── S09: Streaming ── 全链路异步生成器
        │
        ├── S10: Skills ── 两层按需注入
        │
        ├── S11: State  ── 会话持久化与恢复
        │
        └── S12: CLI    ── 多模式运行时
```

每一层都是在 Agent Loop 的基础上叠加的。去掉所有层之后，最核心的依然是那 30 行代码：

```
while (stop_reason === "tool_use") {
    response = callLLM(messages)
    results = executeTools(response)
    messages.push(response, results)
}
```

## 关键设计决策

### 为什么用 Bun 而不是 Node.js？

1. **编译速度** —— Bun 的打包速度远快于 webpack/esbuild
2. **单文件输出** —— 内置的打包能力，不需要额外工具
3. **TypeScript 原生** —— 不需要 tsc 编译步骤
4. **启动速度** —— Bun 运行时启动更快

### 为什么用 Ink (React for Terminal)？

1. **组件化** —— 复杂的终端 UI 用组件拆分更清晰
2. **状态管理** —— React 的 hooks 和 context 在终端也好用
3. **声明式** —— 描述"UI 应该是什么样"，而不是"如何更新 UI"

### 为什么 101 个命令各自独立目录？

1. **按需加载** —— 每个命令单独导入，不执行的命令不加载
2. **关注分离** —— 每个命令独立开发和测试
3. **可发现** —— 目录结构即命令清单

## 本章小结

本教程从 30 行的 Agent Loop 出发，逐层拆解了 Claude Code 的完整架构：

| 章节 | 核心概念 | 源码位置 |
|------|---------|----------|
| S01 | Agent Loop | `query.ts`, `QueryEngine.ts` |
| S02 | Tool 系统 | `Tool.ts`, `tools/` |
| S03 | 权限系统 | `utils/permissions/` |
| S04 | 系统提示词 | `utils/systemPrompt.ts`, `utils/claudemd.ts` |
| S05 | 上下文压缩 | `services/compact/` |
| S06 | 子代理 | `tools/AgentTool/` |
| S07 | MCP 协议 | `services/mcp/` |
| S08 | 钩子系统 | `utils/hooks.ts` |
| S09 | 流式处理 | `services/api/claude.ts` |
| S10 | 技能系统 | `tools/SkillTool/`, `services/plugins/` |
| S11 | 状态管理 | `state/`, `utils/sessionStorage.ts` |
| S12 | CLI 架构 | `entrypoints/cli.tsx`, `main.tsx` |

**最终理解**：Claude Code 是一个以 Agent Loop 为核心，以统一 Tool 接口为扩展点，以权限系统为安全保障，以流式处理为用户体验基础的工业级 AI 编程代理。它的每一层设计都服务于一个目标 —— 让 AI 安全、高效、可靠地帮助人类编写代码。
