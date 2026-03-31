# 概览

## 这是什么

本教程是对 **Claude Code v2.1.88** 源码的深度拆解。Claude Code 是 Anthropic 官方的 CLI 工具，它将大语言模型变成了一个能够读写文件、执行命令、搜索代码的**自主编程代理 (Autonomous Coding Agent)**。

与 [learn.shareai.run](https://learn.shareai.run/en/) 的教学式教程不同，本教程直接面对真实的工业级代码，带你理解一个成熟 AI Agent 产品的内部架构。

## 为什么要读源码

1. **理解 Agent 本质** —— Agent 的核心就是一个循环 + 工具调用，但工业级实现远比教科书复杂
2. **学习工程实践** —— 权限系统、上下文压缩、流式处理等都是教程不会讲的工程细节
3. **掌握设计模式** —— Builder 模式、异步生成器、分层权限等设计模式在真实系统中的应用
4. **构建自己的 Agent** —— 理解原理后，你可以构建自己的编程代理

## 项目概况

| 维度 | 数据 |
|------|------|
| 版本 | v2.1.88 |
| 语言 | TypeScript + React (Ink) |
| 构建工具 | Bun |
| UI 框架 | Ink (终端 React) |
| 源码目录 | `src/` 下 56 个子目录 |
| 工具数量 | 45+ 内置工具 |
| 命令数量 | 101 个命令 |
| 编译产物 | 单个 13MB 的 `cli.js` |

## 源码目录结构

```
claude-code/
├── cli.js                    # 编译后的主入口 (13MB)
├── cli.js.map                # Source Map (59MB)
├── package.json              # NPM 包定义
├── sdk-tools.d.ts            # Agent SDK 类型定义
├── src/
│   ├── entrypoints/          # 入口点 (CLI, 守护进程, MCP 服务器等)
│   ├── main.tsx              # 主程序初始化
│   ├── QueryEngine.ts        # 查询引擎 - 管理对话生命周期
│   ├── query.ts              # 核心代理循环 (while true)
│   ├── Tool.ts               # Tool 接口定义与 Builder
│   ├── tools.ts              # 工具注册表
│   ├── tools/                # 45+ 工具实现
│   │   ├── BashTool/         # Shell 命令执行
│   │   ├── FileReadTool/     # 文件读取
│   │   ├── FileEditTool/     # 文件编辑
│   │   ├── FileWriteTool/    # 文件写入
│   │   ├── GlobTool/         # 文件搜索
│   │   ├── GrepTool/         # 内容搜索
│   │   ├── AgentTool/        # 子代理
│   │   ├── MCPTool/          # MCP 工具
│   │   ├── SkillTool/        # 技能加载
│   │   └── ...
│   ├── services/             # 服务层
│   │   ├── api/              # Anthropic API 客户端
│   │   ├── mcp/              # MCP 协议实现
│   │   ├── compact/          # 上下文压缩
│   │   ├── lsp/              # LSP 集成
│   │   ├── plugins/          # 插件系统
│   │   └── ...
│   ├── hooks/                # React Hooks (87 个)
│   ├── components/           # UI 组件 (146 个)
│   ├── utils/                # 工具函数 (331 个子目录)
│   │   ├── permissions/      # 权限核心逻辑
│   │   ├── settings/         # 多层设置管理
│   │   ├── hooks.ts          # 用户钩子系统
│   │   └── ...
│   ├── state/                # 状态管理
│   ├── context/              # React Context
│   ├── bridge/               # REPL 桥接层
│   ├── commands/             # 101 个命令
│   └── types/                # 类型定义
└── vendor/                   # 原生绑定 (ripgrep, 图像处理等)
```

## 学习路径

本教程分为 **12 个渐进式章节**，每个章节聚焦一个核心概念：

```
核心循环                  提示词与上下文          扩展能力              工程实现
┌─────────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ S01 Agent Loop  │───>│ S04 System   │───>│ S06 Subagents│───>│ S09 Streaming│
│ S02 Tools       │    │     Prompt   │    │ S07 MCP      │    │ S10 Skills   │
│ S03 Permissions │    │ S05 Compact  │    │ S08 Hooks    │    │ S11 State    │
└─────────────────┘    └──────────────┘    └──────────────┘    │ S12 CLI      │
                                                                └──────────────┘
```

每个章节包含：
- **核心问题** —— 这个模块要解决什么问题
- **源码定位** —— 关键文件和代码路径
- **设计剖析** —— 架构决策和设计模式
- **简化实现** —— 用最少的代码还原核心思路
- **与教学版对比** —— 对比 learn.shareai.run 的简化实现

## 核心洞察

在深入源码之前，先建立几个关键认知：

### 1. Agent = While Loop + Tools

这是最核心的抽象。无论多复杂的 Agent，本质上都是：

```
while (stop_reason === "tool_use") {
    response = await callLLM(messages)
    toolResults = await executeTools(response.tool_calls)
    messages.push(response, toolResults)
}
```

Claude Code 的全部复杂性，都是在这个循环之上的层层叠加。

### 2. 一切皆 Tool

文件读写、Shell 执行、网页抓取、子代理、MCP 服务器 —— 在 Claude Code 中都是 Tool。统一的 Tool 接口让系统具备了极强的可扩展性。

### 3. 权限是第一等公民

每次工具调用都必须经过权限检查。这不是事后加的安全层，而是从设计之初就融入架构的核心机制。

### 4. 上下文是稀缺资源

Context Window 有限，Claude Code 用三层压缩策略精心管理每一个 token 的使用。

### 5. 异步生成器贯穿始终

从 API 流式响应到工具执行，`async function*` 是 Claude Code 的核心编程范式，实现了流式处理和惰性求值。

---

准备好了吗？让我们从 [S01: Agent Loop](/s01-agent-loop) 开始。
