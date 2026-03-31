# S07: MCP (模型上下文协议)

> **核心洞察**：MCP 让 Claude Code 从一个封闭系统变成了**开放平台** —— 任何人都可以通过标准协议为 Agent 添加新能力，而不需要修改 Agent 本身的代码。

## 核心问题

Claude Code 内置了 45+ 工具，但无法覆盖所有场景：
- 访问 Figma 设计稿
- 操作 Jira 工单
- 查询 Grafana 监控
- 操作飞书多维表格

为每个外部服务写内置工具不现实 —— MCP 提供了标准化的扩展协议。

## 什么是 MCP

**Model Context Protocol (MCP)** 是 Anthropic 提出的标准协议，定义了 AI 模型与外部工具/资源的交互方式：

```
┌─────────────┐     MCP 协议      ┌─────────────────┐
│ Claude Code  │ ←──────────────→ │ MCP Server       │
│ (MCP Client) │   stdio/HTTP/SSE │ (Figma/Jira/...) │
└─────────────┘                   └─────────────────┘
```

MCP Server 暴露：
- **Tools** —— 可以被模型调用的函数
- **Resources** —— 可以被读取的数据源
- **Prompts** —— 预定义的提示词模板

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/services/mcp/` | MCP 核心服务 (25 个文件) |
| `src/services/mcp/MCPConnectionManager.tsx` | 连接管理器 |
| `src/services/mcp/client.ts` | MCP 客户端实现 (~12KB) |
| `src/services/mcp/config.ts` | 配置解析 (~5KB) |
| `src/services/mcp/auth.ts` | OAuth 认证 (~9KB) |
| `src/tools/MCPTool/` | MCP 工具包装器 |
| `src/tools/ListMcpResourcesTool/` | MCP 资源列表工具 |
| `src/tools/ReadMcpResourceTool/` | MCP 资源读取工具 |
| `src/tools/McpAuthTool/` | MCP 认证工具 |

## MCP 配置

用户通过配置文件声明 MCP 服务器：

```json
// ~/.claude/settings.json 或 .claude/settings.json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/figma-mcp"],
      "env": { "FIGMA_TOKEN": "..." }
    },
    "jira": {
      "command": "node",
      "args": ["./mcp-servers/jira/index.js"],
      "env": { "JIRA_URL": "https://..." }
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "transport": "sse"
    }
  }
}
```

### 配置解析

```typescript
// src/services/mcp/config.ts - 简化
interface MCPServerConfig {
  // stdio 传输 (本地进程)
  command?: string
  args?: string[]
  env?: Record<string, string>

  // HTTP/SSE 传输 (远程服务)
  url?: string
  transport?: 'stdio' | 'sse' | 'http'

  // 可选
  timeout?: number
  autoApprove?: string[]  // 自动允许的工具名
}

// 配置来源层级
function loadMCPConfig(): Record<string, MCPServerConfig> {
  return mergeConfigs([
    enterpriseConfig,   // 企业配置 (最高优先级)
    userConfig,         // ~/.claude/settings.json
    projectConfig,      // .claude/settings.json
    localConfig,        // .claude.local.json
    pluginConfig,       // 插件发现的服务器
  ])
}
```

## 连接管理

`MCPConnectionManager` 管理所有 MCP 服务器的生命周期：

```typescript
// src/services/mcp/MCPConnectionManager.tsx - 简化
class MCPConnectionManager {
  private connections: Map<string, MCPConnection> = new Map()

  // 连接到配置的所有服务器
  async connectAll(configs: Record<string, MCPServerConfig>) {
    for (const [name, config] of Object.entries(configs)) {
      try {
        const connection = await this.connect(name, config)
        this.connections.set(name, connection)
      } catch (error) {
        // 连接失败不影响其他服务器
        console.warn(`Failed to connect to MCP server ${name}: ${error}`)
      }
    }
  }

  // 连接单个服务器
  private async connect(name: string, config: MCPServerConfig): Promise<MCPConnection> {
    // 选择传输方式
    const transport = config.url
      ? new SSETransport(config.url)       // 远程: HTTP/SSE
      : new StdioTransport(config.command, config.args, config.env)  // 本地: stdio

    // 创建 MCP 客户端
    const client = new MCPClient(transport)
    await client.initialize()

    // 发现可用工具
    const tools = await client.listTools()

    return { name, client, tools, config }
  }
}
```

### 传输方式

```
stdio:  父进程 ←──stdin/stdout──→ MCP Server 子进程
SSE:    HTTP Client ←──SSE Stream──→ MCP Server
HTTP:   HTTP Client ←──REST API──→ MCP Server
SDK:    直接函数调用 (进程内)
```

## MCP 工具注册

连接后，MCP Server 暴露的工具被包装成标准的 Claude Code Tool：

```typescript
// MCP 工具的命名规范: mcp__{serverName}__{toolName}
// 例如: mcp__figma__get_design_context

function wrapMCPTool(
  serverName: string,
  mcpTool: MCPToolDefinition,
  client: MCPClient,
): Tool {
  return buildTool({
    // 名称带服务器前缀，避免冲突
    name: `mcp__${serverName}__${mcpTool.name}`,

    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),

    async description() {
      return mcpTool.description
    },

    async checkPermissions(input) {
      // 检查是否在 autoApprove 列表中
      if (isAutoApproved(serverName, mcpTool.name)) {
        return { behavior: 'allow' }
      }
      return { behavior: 'ask', message: `MCP tool: ${mcpTool.name}` }
    },

    async call(input, context) {
      // 通过 MCP 协议调用工具
      const result = await client.callTool(mcpTool.name, input)
      return { data: result }
    },
  })
}
```

注册后，MCP 工具和内置工具在 Agent Loop 中是完全一样的 —— 统一的 Tool 接口让这成为可能。

## MCP 工具调用流程

```
LLM 返回 tool_use: { name: "mcp__figma__get_design_context", input: {...} }
  │
  ▼
findToolByName() → 找到 MCP 包装工具
  │
  ▼
checkPermissions() → 检查 autoApprove / 询问用户
  │
  ▼
tool.call()
  │
  ├── 序列化参数为 MCP 格式
  ├── 通过传输层发送到 MCP Server
  ├── 等待 MCP Server 执行
  ├── 接收结果
  └── 反序列化为 ToolResult
  │
  ▼
返回给 Agent Loop → 追加到 messages
```

## OAuth 认证

某些 MCP 服务器需要 OAuth 认证（如 Figma、GitHub）：

```typescript
// src/services/mcp/auth.ts - 简化
async function authenticateMCPServer(
  serverName: string,
  config: MCPServerConfig,
): Promise<string> {
  // 1. 检查是否已有有效 token
  const cached = await getStoredToken(serverName)
  if (cached && !isExpired(cached)) {
    return cached.accessToken
  }

  // 2. 发起 OAuth 流程
  const { authUrl, codeVerifier } = buildOAuthRequest(config)

  // 3. 打开浏览器让用户授权
  await openBrowser(authUrl)

  // 4. 等待回调获取 code
  const code = await waitForOAuthCallback()

  // 5. 交换 code 获取 token
  const token = await exchangeCodeForToken(code, codeVerifier)

  // 6. 安全存储 token
  await storeToken(serverName, token)

  return token.accessToken
}
```

对应的 UI 组件是 `src/components/ConsoleOAuthFlow.tsx`，在终端中引导用户完成 OAuth 授权。

## MCP 资源

除了工具，MCP 还支持资源（可读取的数据源）：

```typescript
// 列出 MCP 服务器的资源
const ListMcpResourcesTool = buildTool({
  name: 'ListMcpResources',
  async call(input) {
    const resources = await client.listResources()
    return { data: resources }
  },
})

// 读取特定资源
const ReadMcpResourceTool = buildTool({
  name: 'ReadMcpResource',
  async call(input) {
    const content = await client.readResource(input.uri)
    return { data: content }
  },
})
```

## 服务器审批

首次连接 MCP 服务器时，用户需要审批：

```typescript
// MCP 服务器审批逻辑
async function approveMCPServer(
  serverName: string,
  config: MCPServerConfig,
): Promise<boolean> {
  // 检查是否在允许列表中
  if (isInAllowList(serverName)) return true

  // 显示审批对话框
  const approved = await showApprovalDialog({
    title: `Allow MCP server "${serverName}"?`,
    details: [
      `Command: ${config.command} ${config.args?.join(' ')}`,
      `Tools: ${tools.map(t => t.name).join(', ')}`,
    ],
    options: ['Allow once', 'Always allow', 'Deny'],
  })

  return approved
}
```

## server-reminder 注入

MCP 服务器可以提供使用说明，这些说明通过 `system-reminder` 注入到对话中：

```typescript
// 连接后获取服务器的使用指令
const instructions = await client.getInstructions()

// 注入到消息中
if (instructions) {
  messages.push({
    role: 'user',
    content: `<system-reminder>
# MCP Server Instructions
## ${serverName}
${instructions}
</system-reminder>`,
  })
}
```

## 简化实现

```typescript
// MCP 客户端的简化实现
class SimpleMCPClient {
  private transport: Transport

  constructor(config: MCPServerConfig) {
    this.transport = config.url
      ? new SSETransport(config.url)
      : new StdioTransport(config.command!, config.args, config.env)
  }

  async initialize() {
    await this.transport.connect()
    // MCP 握手
    await this.transport.send({ method: 'initialize', params: { ... } })
  }

  async listTools(): Promise<MCPToolDef[]> {
    const response = await this.transport.send({ method: 'tools/list' })
    return response.tools
  }

  async callTool(name: string, args: object): Promise<any> {
    const response = await this.transport.send({
      method: 'tools/call',
      params: { name, arguments: args },
    })
    return response.content
  }

  async listResources(): Promise<MCPResource[]> {
    const response = await this.transport.send({ method: 'resources/list' })
    return response.resources
  }
}
```

## 关键设计决策

### 为什么 MCP 而不是直接 REST API？

1. **标准化** —— 所有 MCP 服务器用同一个协议，Claude Code 不需要为每个服务写适配器
2. **双向通信** —— 服务器可以推送更新，不只是响应请求
3. **发现能力** —— 自动发现服务器提供的工具和资源
4. **安全模型** —— 内置审批和权限机制

### 为什么工具名带服务器前缀？

避免不同 MCP 服务器的工具名冲突。例如两个服务器都可能有 `search` 工具，前缀区分了来源。

### 为什么 stdio 是默认传输？

1. **简单** —— 不需要网络配置
2. **安全** —— 不暴露端口
3. **跨平台** —— stdin/stdout 是通用的

## 本章小结

| 维度 | 内置工具 | MCP 工具 |
|------|---------|----------|
| 注册方式 | 编译时 `tools.ts` | 运行时 MCP 协议发现 |
| 命名 | `Bash`, `Read` | `mcp__server__tool` |
| 传输 | 进程内函数调用 | stdio / SSE / HTTP |
| 认证 | 无需 | OAuth / API Key |
| 审批 | 权限规则 | 首次连接审批 |
| 扩展性 | 需修改源码 | 配置文件声明 |

MCP 把 Claude Code 从"封闭工具集"变成了"开放平台"。接下来看看如何在工具执行前后注入自定义逻辑 —— [S08: Hooks](/s08-hooks)。
