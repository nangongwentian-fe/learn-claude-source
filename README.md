# 深入 Claude Code 源码

> 从 Agent Loop 到完整架构 —— 逐层拆解 Claude Code 的设计与实现

基于 **Claude Code v2.1.88** 源码的深度解析教程，12 个渐进式章节带你理解工业级 AI Agent 的内部工作原理。

## 在线阅读

**https://nangongwentian-fe.github.io/learn-claude-source/**

## 内容概览

| 章节 | 主题 | 核心概念 |
|------|------|----------|
| S01 | Agent Loop | `while(true)` + `stop_reason` 检查 —— Agent 的最小内核 |
| S02 | Tools | 统一 Tool 接口 + Builder 模式 + 并发执行 |
| S03 | Permissions | 6 阶段权限检查 + 7 层设置来源 |
| S04 | System Prompt | 动态构建 + CLAUDE.md + 延迟加载 |
| S05 | Context & Compact | 三层上下文压缩 + 响应式恢复 |
| S06 | Subagents | 独立上下文 + 工具集隔离 + 递归防护 |
| S07 | MCP | 标准协议扩展 + 连接管理 + OAuth |
| S08 | Hooks | 20+ 事件类型 + stdin/stdout JSON 协议 |
| S09 | Streaming | AsyncGenerator 全链路 + 边接收边执行 |
| S10 | Skills & CLAUDE.md | 两层按需注入 + ToolSearch 延迟加载 |
| S11 | State & Session | AppState + JSONL 持久化 + 会话恢复 |
| S12 | CLI & Architecture | 多模式运行时 + 编译时特性标志 + 完整架构回顾 |

## 教程特色

- **对比教学版** —— 每章对比 [learn.shareai.run](https://learn.shareai.run/en/) 的简化实现与 Claude Code 真实实现
- **源码定位** —— 标注关键文件路径，方便对照阅读
- **简化实现** —— 每章提供 ~50 行的核心思路还原代码
- **设计决策** —— 分析关键的架构选择和工程权衡

## 本地运行

```bash
git clone https://github.com/nangongwentian-fe/learn-claude-source.git
cd learn-claude-source
npm install
npm run dev
```

## 参考

- [Claude Code](https://github.com/anthropics/claude-code) — Anthropic 官方 CLI
- [Learn Claude Code](https://learn.shareai.run/en/) — 教学版渐进式教程
- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP 协议规范

## License

仅用于学习研究目的。
