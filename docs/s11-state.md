# S11: State & Session (状态与会话)

> **核心洞察**：Agent 的状态分散在多个层面 —— 内存中的 AppState、磁盘上的 Session 文件、git 中的 CLAUDE.md。理解状态管理是理解 Claude Code 持久化和恢复能力的关键。

## 核心问题

一个长时间运行的 Agent 需要管理：
1. **对话状态** —— 当前消息列表、token 使用量
2. **工具状态** —— 哪些文件被读取/修改过
3. **权限状态** —— 当前会话的临时允许
4. **UI 状态** —— 当前对话框、通知
5. **会话持久化** —— 关闭后能恢复

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/state/AppState.tsx` | 中央状态存储 |
| `src/state/AppStateStore.ts` | 状态持久化 |
| `src/state/onChangeAppState.ts` | 状态变更处理 |
| `src/utils/sessionStorage.ts` | 会话文件存储 |
| `src/utils/conversationRecovery.ts` | 对话恢复 |
| `src/context/` | React Context 提供者 |

## AppState —— 中央状态存储

```typescript
// src/state/AppState.tsx - 简化
interface AppState {
  // ====== 对话 ======
  messages: Message[]            // 当前对话消息列表
  conversationId: string         // 对话 ID
  turnCount: number              // 轮次计数

  // ====== Token ======
  totalUsage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }

  // ====== 工具 ======
  toolPermissionContext: ToolPermissionContext  // 权限上下文
  fileStateCache: FileStateCache               // 文件状态缓存

  // ====== 设置 ======
  permissionMode: PermissionMode   // 当前权限模式
  model: string                    // 当前模型
  effortLevel: 'low' | 'medium' | 'high'  // 思考深度

  // ====== UI ======
  isProcessing: boolean            // 是否正在处理
  currentDialog: Dialog | null     // 当前对话框
  notifications: Notification[]    // 通知队列

  // ====== 会话 ======
  sessionId: string                // 会话 ID
  sessionStartTime: number         // 会话开始时间
  isResumed: boolean               // 是否是恢复的会话
}
```

## FileStateCache —— 文件状态跟踪

Agent 需要知道哪些文件被读取和修改过，用于：
- 压缩后恢复关键文件
- 检测文件是否在 Agent 不知情的情况下被外部修改
- 优化重复读取

```typescript
// 简化的文件状态缓存
class FileStateCache {
  private states: Map<string, FileState> = new Map()

  // 记录文件被读取
  markRead(path: string, content: string, timestamp: number) {
    this.states.set(path, {
      path,
      lastReadContent: content,
      lastReadAt: timestamp,
      lastModifiedAt: this.getFileMtime(path),
    })
  }

  // 记录文件被修改
  markModified(path: string, content: string, timestamp: number) {
    const state = this.states.get(path) || {}
    this.states.set(path, {
      ...state,
      path,
      lastWrittenContent: content,
      lastWrittenAt: timestamp,
    })
  }

  // 检测外部修改
  async hasExternalModification(path: string): Promise<boolean> {
    const state = this.states.get(path)
    if (!state) return false
    const currentMtime = await this.getFileMtime(path)
    return currentMtime > state.lastReadAt
  }

  // 获取最近的文件 (压缩后恢复用)
  getRecent(limit: number): FileState[] {
    return Array.from(this.states.values())
      .sort((a, b) => b.lastReadAt - a.lastReadAt)
      .slice(0, limit)
  }
}
```

## 会话持久化

每次消息变更都会持久化到磁盘：

```
~/.claude/sessions/
  └── <session-id>/
      ├── session.json         # 会话元数据
      ├── transcript.jsonl     # 完整消息转录 (JSONL)
      ├── state.json           # 运行时状态快照
      └── .transcripts/        # 压缩前备份
```

### JSONL 转录

```typescript
// 每条消息追加写入 JSONL
async function recordTranscript(messages: Message[]) {
  const newMessages = messages.slice(lastPersistedIndex)
  const lines = newMessages.map(msg => JSON.stringify({
    timestamp: Date.now(),
    type: msg.type,        // 'user' | 'assistant' | 'tool_result'
    content: msg.content,
    usage: msg.usage,
  }))

  // 追加写入，不重写整个文件
  await appendFile(transcriptPath, lines.join('\n') + '\n')
  lastPersistedIndex = messages.length
}
```

**JSONL 的优势**：
- 追加写入（性能好）
- 不需要重写整个文件
- 每行独立解析（crash 后只丢最后一行）
- 适合流式场景

### 会话元数据

```typescript
// session.json
{
  "id": "session_abc123",
  "startTime": 1711900000000,
  "cwd": "/Users/user/project",
  "model": "claude-sonnet-4-20250514",
  "totalTokens": 45000,
  "messageCount": 23,
  "lastActivityTime": 1711903600000,
  "tags": ["feature", "auth-module"],
  "summary": "重构认证模块，添加 OAuth 支持"
}
```

## 对话恢复

关闭终端后重新打开，Claude Code 可以恢复之前的会话：

```typescript
// src/utils/conversationRecovery.ts - 简化
async function recoverSession(sessionId: string): Promise<RecoveredSession> {
  const sessionDir = path.join(SESSIONS_DIR, sessionId)

  // 1. 加载会话元数据
  const metadata = await readJSON(path.join(sessionDir, 'session.json'))

  // 2. 加载转录记录
  const transcript = await readJSONL(path.join(sessionDir, 'transcript.jsonl'))

  // 3. 重建消息列表
  const messages = transcript.map(line => ({
    role: line.type === 'assistant' ? 'assistant' : 'user',
    content: line.content,
  }))

  // 4. 恢复文件状态缓存
  const fileState = await loadFileStateCache(sessionDir)

  return {
    messages,
    metadata,
    fileState,
    isResumed: true,
  }
}
```

### 恢复策略

```
claude --resume              # 恢复最近的会话
claude --resume <session-id> # 恢复指定会话
```

恢复时会显示会话摘要，让用户确认上下文：

```
┌─────────────────────────────────────────────┐
│ Resuming session from 2 hours ago           │
│                                             │
│ Summary: 重构认证模块，添加 OAuth 支持       │
│ Messages: 23                                │
│ Tokens: 45,000                              │
│                                             │
│ Continue? [y/n]                             │
└─────────────────────────────────────────────┘
```

## 后台会话

Claude Code 支持将会话放到后台运行：

```bash
claude --bg "运行所有测试并报告结果"
```

后台会话有独立的生命周期：

```
前台: 用户交互 → 输入 → Agent 处理 → 输出 → 等待输入

后台: 启动 → 守护进程管理 → Agent 自主执行 → 完成/超时
      │
      ├── claude ps       # 查看后台会话列表
      ├── claude logs <id> # 查看日志
      ├── claude attach <id> # 重新连接
      └── claude kill <id> # 终止
```

## React Context 层

UI 状态通过 React Context 管理：

```typescript
// src/context/ 中的各种 Context
const contexts = {
  // 通知系统
  NotificationContext: {
    notifications: Notification[],
    addNotification: (n: Notification) => void,
    dismissNotification: (id: string) => void,
  },

  // 模态框
  ModalContext: {
    currentModal: Modal | null,
    showModal: (m: Modal) => void,
    hideModal: () => void,
  },

  // 覆盖层 (全屏)
  OverlayContext: {
    currentOverlay: Overlay | null,
    showOverlay: (o: Overlay) => void,
    hideOverlay: () => void,
  },

  // 统计数据
  StatsContext: {
    tokensUsed: number,
    apiCallCount: number,
    sessionDuration: number,
  },

  // 语音
  VoiceContext: {
    isListening: boolean,
    isSpeaking: boolean,
    startListening: () => void,
    stopListening: () => void,
  },
}
```

## 简化实现

```typescript
// 最小会话持久化系统
class SessionManager {
  private sessionDir: string
  private metadata: SessionMetadata

  constructor(sessionId: string) {
    this.sessionDir = `~/.claude/sessions/${sessionId}`
    this.metadata = {
      id: sessionId,
      startTime: Date.now(),
      messageCount: 0,
    }
  }

  // 追加消息到转录
  async appendMessage(message: Message) {
    const line = JSON.stringify({
      timestamp: Date.now(),
      ...message,
    })
    await appendFile(
      path.join(this.sessionDir, 'transcript.jsonl'),
      line + '\n'
    )
    this.metadata.messageCount++
  }

  // 保存会话元数据
  async saveMetadata() {
    await writeFile(
      path.join(this.sessionDir, 'session.json'),
      JSON.stringify(this.metadata, null, 2)
    )
  }

  // 恢复会话
  static async restore(sessionId: string): Promise<Message[]> {
    const lines = await readLines(`~/.claude/sessions/${sessionId}/transcript.jsonl`)
    return lines.map(line => JSON.parse(line))
  }

  // 列出所有会话
  static async list(): Promise<SessionMetadata[]> {
    const dirs = await readdir('~/.claude/sessions/')
    return Promise.all(
      dirs.map(d => readJSON(`~/.claude/sessions/${d}/session.json`))
    )
  }
}
```

## 关键设计决策

### 为什么用 JSONL 而不是 SQLite？

1. **追加友好** —— JSONL 天然支持追加写入
2. **人类可读** —— 可以直接用 `cat` 查看
3. **crash 安全** —— 最多丢失最后一行
4. **简单** —— 不需要数据库依赖

### 为什么 FileStateCache 在内存中？

文件状态变化频繁（每次 Read/Edit/Write 都更新），磁盘 I/O 太慢。只在以下时机写入磁盘：
- 会话暂停/退出时
- 定期快照

### 为什么要追踪"外部修改"？

如果用户在 Claude Code 之外修改了文件（比如用 VS Code），FileEditTool 的 `old_string` 匹配可能失败。外部修改检测让 Agent 能提前发现并处理冲突。

## 本章小结

| 维度 | 说明 |
|------|------|
| 中央状态 | AppState (消息、token、权限、UI) |
| 文件跟踪 | FileStateCache (读/写/外部修改) |
| 持久化 | JSONL 追加写入 + JSON 元数据 |
| 会话恢复 | `--resume` 加载转录 + 文件状态 |
| 后台会话 | 守护进程 + `ps/logs/attach/kill` |
| UI 状态 | React Context (通知/模态/覆盖/语音) |

状态管理是 Agent 从"一次性脚本"变成"持久化应用"的关键。最后一章，让我们看看整个 CLI 是如何组装起来的 —— [S12: CLI & Architecture](/s12-cli)。
