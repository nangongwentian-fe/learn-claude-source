# S03: Permissions (权限系统)

> **核心洞察**：权限不是事后贴上的安全补丁，而是从架构第一天就融入工具调用管线的一等公民。每一次工具执行都必须经过权限裁决。

## 核心问题

AI Agent 拥有执行 Shell 命令、修改文件、访问网络的能力。如果没有权限控制：
- `rm -rf /` 可以删除整个系统
- 模型可能被提示注入攻击，执行恶意命令
- 敏感文件（`.env`、密钥）可能被读取或泄露

**权限系统的目标**：在不过度打扰用户的前提下，阻止危险操作。

## 教学版 vs 真实版

### 教学版 (s02) —— 路径沙箱

```python
def safe_path(requested: str) -> str:
    """防止工作区逃逸"""
    resolved = os.path.abspath(os.path.join(WORKSPACE, requested))
    if not resolved.startswith(WORKSPACE):
        raise ValueError("Path escape blocked")
    return resolved
```

教学版的"权限系统"就一个函数 —— 检查路径是否在工作区内。

### 真实版 (Claude Code) —— 6 阶段权限管线

Claude Code 的权限系统有五个维度：
1. **权限模式** —— 全局策略
2. **权限规则** —— 细粒度允许/拒绝规则
3. **工具级检查** —— 每个工具的自定义权限逻辑
4. **AI 分类器** —— 用 LLM 辅助判断
5. **用户交互** —— 权限对话框

## 源码定位

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/permissions.ts` | 核心权限检查逻辑 (~1486 行) |
| `src/utils/permissions/PermissionResult.ts` | 权限决策类型定义 |
| `src/tools/BashTool/bashPermissions.ts` | Bash 专用 6 阶段权限 |
| `src/components/permissions/` | 权限对话框 UI (16 个子目录) |
| `src/utils/settings/` | 多层设置管理 |

## 权限模式

Claude Code 支持五种全局权限模式：

```typescript
type PermissionMode =
  | 'default'          // 默认: 只读操作自动允许，写操作询问
  | 'acceptEdits'      // 自动接受文件编辑，其他询问
  | 'bypassPermissions'// 全部自动允许 (危险!)
  | 'plan'             // 只读模式，禁止所有写操作
  | 'auto'             // AI 分类器自动判断 (实验性)
```

模式的选择影响所有工具的权限裁决：

```typescript
// 简化的模式逻辑
function applyModeTransform(
  toolDecision: PermissionResult,
  mode: PermissionMode,
): PermissionResult {
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow' }  // 跳过所有检查
  }
  if (mode === 'plan') {
    if (!tool.isReadOnly(input)) {
      return { behavior: 'deny', message: 'Plan mode: writes disabled' }
    }
  }
  if (mode === 'acceptEdits') {
    if (tool.name === 'Edit' || tool.name === 'Write') {
      return { behavior: 'allow' }
    }
  }
  return toolDecision  // 默认: 保留工具自身的决策
}
```

## 权限规则系统

用户可以配置细粒度的允许/拒绝规则：

```json
// ~/.claude/settings.json
{
  "permissions": {
    "allow": [
      "Read",                    // 允许所有文件读取
      "Bash(npm test:*)",        // 允许 npm test 及其子命令
      "Bash(git status)",        // 允许 git status
      "Edit(src/**)"             // 允许编辑 src/ 下的文件
    ],
    "deny": [
      "Bash(rm -rf *)",          // 拒绝 rm -rf
      "Bash(sudo *)",            // 拒绝 sudo
      "Write(.env*)"             // 拒绝写入 .env 文件
    ]
  }
}
```

规则的格式是 `ToolName` 或 `ToolName(pattern)`，其中 pattern 支持通配符。

### 规则匹配逻辑

```typescript
// src/utils/permissions/permissions.ts - 简化
function checkRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  rules: PermissionRules,
): PermissionResult | null {
  // 1. 检查 deny 规则 (优先级最高)
  for (const rule of rules.deny) {
    if (matchesRule(tool, input, rule)) {
      return { behavior: 'deny', message: `Blocked by rule: ${rule}` }
    }
  }

  // 2. 检查 allow 规则
  for (const rule of rules.allow) {
    if (matchesRule(tool, input, rule)) {
      return { behavior: 'allow' }
    }
  }

  // 3. 没有匹配 → 返回 null，由后续阶段决定
  return null
}
```

**Deny 优先** —— 如果同一个操作同时被 allow 和 deny 规则匹配，deny 胜出。

### 规则来源的层级

规则可以来自多个层级，从高到低：

```
Policy (组织策略) → 最高优先级，不可覆盖
  ↓
MDM (设备管理) → IT 管理员设置
  ↓
User Settings (~/.claude/settings.json) → 用户全局设置
  ↓
Project Settings (.claude/settings.json) → 项目级设置
  ↓
Local Settings (.claude.local.json) → 本地未提交的设置
  ↓
CLI Flags → 命令行参数
  ↓
Session → 当前会话中用户的临时允许
```

## BashTool 的 6 阶段权限

Bash 是最危险的工具，它的权限检查最为复杂：

```typescript
// src/tools/BashTool/bashPermissions.ts - 简化
export async function bashToolHasPermission(input): Promise<PermissionResult> {

  // ===== Stage 1: AST 安全解析 (tree-sitter WASM) =====
  // 用真正的 Shell 解析器分析命令结构，而不是正则匹配
  const astResult = await parseCommandRaw(input.command)
  if (astResult.kind === 'too-complex') {
    // 无法静态分析 → 必须询问用户
    return { behavior: 'ask' }
  }

  // ===== Stage 2: 语义检查 =====
  // 检测 eval、exec 等动态执行命令
  const semantics = checkSemantics(astResult.commands)
  if (!semantics.ok) {
    return { behavior: 'ask', message: semantics.reason }
  }

  // ===== Stage 3: 沙箱自动允许 =====
  // 在沙箱环境中，已知安全的命令自动放行
  if (shouldUseSandbox(input) && SandboxManager.isAutoAllowEnabled()) {
    const sandboxResult = checkSandboxAutoAllow(input)
    if (sandboxResult.behavior !== 'passthrough') {
      return sandboxResult
    }
  }

  // ===== Stage 4: 精确匹配 =====
  // 检查用户配置的 allow/deny 规则
  const exactMatch = checkExactMatchPermission(input)
  if (exactMatch.behavior === 'deny') {
    return exactMatch  // deny 优先
  }

  // ===== Stage 5: AI 分类器 =====
  // 用 LLM 判断命令是否匹配规则描述
  if (isClassifierEnabled()) {
    // 先检查 deny 规则
    const denyResult = await classifyBashCommand(
      input.command, getCwd(), denyRuleDescriptions, 'deny'
    )
    if (denyResult?.matches && denyResult.confidence === 'high') {
      return { behavior: 'deny' }
    }

    // 再检查 ask 规则
    const askResult = await classifyBashCommand(
      input.command, getCwd(), askRuleDescriptions, 'ask'
    )
    if (askResult?.matches) {
      return { behavior: 'ask' }
    }
  }

  // ===== Stage 6: 回退 =====
  return { behavior: 'ask' }
}
```

### 为什么用 tree-sitter 解析 Shell？

正则匹配 shell 命令是不可靠的。例如：

```bash
# 这些都包含 rm，但含义完全不同
rm -rf /                    # 极度危险
echo "rm -rf /" > log.txt   # 安全（只是字符串）
grep "rm" history.txt       # 安全（只是搜索）
```

tree-sitter 能正确理解 shell 语法，区分命令名和字符串参数。

## 权限决策类型

```typescript
// src/utils/permissions/PermissionResult.ts
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: object }    // 放行 (可修改输入)
  | { behavior: 'deny'; message?: string }           // 拒绝
  | { behavior: 'ask'; message: string;              // 询问用户
      suggestions: PermissionUpdate[] }               // 提供规则建议

// 当 behavior 是 'ask' 时，用户可以选择:
// 1. 允许一次
// 2. 允许并保存规则 (下次自动允许)
// 3. 拒绝
```

**`suggestions`** 是一个巧妙的设计 —— 当用户允许一个操作时，系统会建议保存为规则，避免下次再问。

## 权限对话框

当 `behavior === 'ask'` 时，终端会显示权限对话框：

```
┌─────────────────────────────────────────────────┐
│ Claude wants to run:                             │
│                                                  │
│   npm install express                            │
│                                                  │
│ [y] Allow once                                   │
│ [n] Deny                                         │
│ [a] Always allow "npm install *" for this project│
│ [d] Always deny                                  │
│ [?] Explain why this needs permission            │
└─────────────────────────────────────────────────┘
```

对应的 UI 组件在 `src/components/permissions/` 下，每种工具都有专用的对话框。

## 设置层级

Claude Code 支持 7 层设置来源，权限规则只是其中一部分：

```typescript
// src/utils/settings/ - 设置加载顺序
const settings = mergeSettings([
  policySettings,      // 组织策略 (最高优先级)
  mdmSettings,         // 设备管理
  userSettings,        // ~/.claude/settings.json
  projectSettings,     // .claude/settings.json
  localSettings,       // .claude.local.json (git 忽略)
  flagSettings,        // CLI 参数
  sessionSettings,     // 当前会话
])
```

**为什么这么多层？**

- **Policy** —— 公司 IT 可以强制禁止某些命令
- **User** —— 个人偏好，所有项目共享
- **Project** —— 团队共享的项目规则，提交到 git
- **Local** —— 不想提交的本地覆盖

## 简化实现

用最少的代码还原权限系统的核心思想：

```typescript
// 简化的权限系统
type Decision = 'allow' | 'deny' | 'ask'

interface PermissionRule {
  tool: string
  pattern?: string
  decision: Decision
}

function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  rules: PermissionRule[],
): Decision {
  // 1. deny 规则优先
  for (const rule of rules.filter(r => r.decision === 'deny')) {
    if (matches(toolName, input, rule)) return 'deny'
  }

  // 2. allow 规则
  for (const rule of rules.filter(r => r.decision === 'allow')) {
    if (matches(toolName, input, rule)) return 'allow'
  }

  // 3. 只读工具默认允许
  if (tool.isReadOnly(input)) return 'allow'

  // 4. 其他询问用户
  return 'ask'
}
```

## 关键设计决策

### 为什么 deny 优先于 allow？

安全原则：宁可误拒，不可误放。如果用户写了：
```json
{ "allow": ["Bash(*)"], "deny": ["Bash(rm *)"] }
```
那么 `rm` 命令应该被拒绝，即使 `Bash(*)` 匹配了它。

### 为什么权限检查在 validateInput 之后？

```
validateInput → checkPermissions → call
```

因为：
1. 先验证输入格式，避免对无效输入进行权限检查
2. 权限检查可能很昂贵（AI 分类器需要调用 LLM）
3. 无效输入的权限结果没有意义

### 为什么需要 AI 分类器？

精确匹配无法覆盖所有场景。例如，规则 "不允许删除生产数据库" 无法用通配符表达，但 AI 分类器可以理解这种语义规则。

## 本章小结

| 维度 | 教学版 | Claude Code |
|------|--------|-------------|
| 范围 | 路径沙箱 | 全工具权限管线 |
| 粒度 | 全部或无 | 工具 × 模式 × 规则 × 用户选择 |
| 检查方式 | 字符串前缀 | AST + 语义 + 精确匹配 + AI |
| 规则来源 | 硬编码 | 7 层设置层级 |
| 用户体验 | 报错 | 对话框 + 规则建议 |
| 默认行为 | 阻止一切 | fail-closed + 只读放行 |

权限系统确保了 Agent 的"能力"受到"约束"。接下来看看 Agent 如何"知道"自己是谁：[S04: 系统提示词](/s04-system-prompt)。
