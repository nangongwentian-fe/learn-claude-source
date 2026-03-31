import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '深入 Claude Code 源码',
  description: '从 Agent Loop 到完整架构 —— 逐层拆解 Claude Code 的设计与实现',
  lang: 'zh-CN',
  base: '/learn-claude-source/',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '教程', link: '/overview' },
      { text: '架构图', link: '/architecture' },
    ],

    sidebar: [
      {
        text: '开始',
        items: [
          { text: '概览', link: '/overview' },
          { text: '架构全景', link: '/architecture' },
        ],
      },
      {
        text: '核心循环',
        items: [
          { text: 'S01: Agent Loop (代理循环)', link: '/s01-agent-loop' },
          { text: 'S02: Tools (工具系统)', link: '/s02-tools' },
          { text: 'S03: Permissions (权限系统)', link: '/s03-permissions' },
        ],
      },
      {
        text: '提示词与上下文',
        items: [
          { text: 'S04: System Prompt (系统提示词)', link: '/s04-system-prompt' },
          { text: 'S05: Context & Compact (上下文压缩)', link: '/s05-compact' },
        ],
      },
      {
        text: '扩展能力',
        items: [
          { text: 'S06: Subagents (子代理)', link: '/s06-subagents' },
          { text: 'S07: MCP (模型上下文协议)', link: '/s07-mcp' },
          { text: 'S08: Hooks (钩子系统)', link: '/s08-hooks' },
        ],
      },
      {
        text: '工程实现',
        items: [
          { text: 'S09: Streaming (流式处理)', link: '/s09-streaming' },
          { text: 'S10: Skills & CLAUDE.md', link: '/s10-skills' },
          { text: 'S11: State & Session (状态与会话)', link: '/s11-state' },
          { text: 'S12: CLI & Architecture (CLI 与架构)', link: '/s12-cli' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/anthropics/claude-code' },
    ],

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: '基于 Claude Code v2.1.88 源码分析',
      copyright: '仅用于学习研究目的',
    },
  },
})
