# 运行时稳定性、能力协商与资源漂移

## 1. 目标

这篇文档记录三个容易影响兼容性和稳定性的运行时问题：

1. 协议版本与能力协商。
2. 权限授权的生命周期。
3. MCP / skills 的声明可用与实际可用漂移。

这三件事都不应该改变前面的核心设计：`profileSnapshot` 是 session 级稳定档案，`TurnRuntimeSnapshot` 是每轮 loop 的运行冻结点，history 承载语义进展。

## 2. 协议版本

`AgentRunSpec` 必须携带协议版本：

```ts
type AgentRunSpec = {
  version: string
  capabilities?: CapabilitySpec
  // ...
}
```

建议第一版使用语义清晰的字符串，例如：

```ts
version: 'agent-runtime/v1'
```

后端需要支持：

- 拒绝未知 major version。
- 对旧 minor version 做兼容编译。
- 在 audit 中记录实际使用的协议版本。
- 在 debug 面板中展示协议版本和协商结果。

## 3. 能力协商

不同入口具备的能力不同。例如：

- Web 可以展示 agent selector、模型选择、permission ask、debug panel。
- Feishu 可能只能展示纯文本结果，不能承载复杂 permission flow。
- 浏览器插件可以提供 page context 和 selection context。
- API client 可能只支持最小 message/prompt 能力。

因此入口请求需要携带 client capabilities，服务端也需要返回或记录 server capabilities。

```ts
type CapabilitySpec = {
  client?: {
    agentSelection?: boolean
    modelOverride?: boolean
    pageContext?: boolean
    selectionContext?: boolean
    permissionAsk?: boolean
    debugPanel?: boolean
    orchestrationSelection?: boolean
    resourceFailureEvents?: boolean
  }
  server?: {
    protocolVersions: string[]
    contextEvents?: boolean
    resourceHealthEvents?: boolean
    sessionPermissionGrants?: boolean
    profileSnapshots?: boolean
  }
}
```

使用原则：

- client 不支持的能力，controller 不应该要求它展示复杂交互。
- client 不支持 `resourceFailureEvents` 时，服务端仍应把失败写入 audit/history，避免完全丢失。
- client 不支持 `permissionAsk` 时，入口模板应收紧权限或引导用户到 Web 端继续。
- server 不支持的新能力，client 应降级到旧协议。

## 4. 权限授权生命周期

当前 Web 端权限请求可以选择：

- 只允许本次。
- 本 session 都允许。

这个模型可以直接进入新 runtime 设计，不需要额外复杂机制。

### 4.1 一次允许

用户选择“一次允许”时：

- 只放行当前 tool call。
- 不写入 `profileSnapshot`。
- 不影响后续 tool call。
- audit 中记录这次 permission ask 的结果。

### 4.2 本 session 都允许

用户选择“本 session 都允许”时：

- 把授权写入 `profileSnapshot.sessionPermissionGrants`。
- 后续同 session 的权限判断先合并这些 grants。
- 不写回全局配置。
- 不影响其他 session。

建议结构：

```ts
type SessionPermissionGrant = {
  id: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  grantedAt: number
  expiresAt?: number
  source: 'permission-ask'
}
```

### 4.3 与权限合并的关系

权限判断顺序建议是：

1. runtime defaults
2. user config permissions
3. profileSnapshot permissions
4. template restrictions
5. profileSnapshot.sessionPermissionGrants
6. current tool call permission ask result

限制：

- session grant 不能突破全局或模板明确的 hard deny。
- session grant 只用于用户已经确认过的 permission/pattern。
- session grant 应显示在 debug/audit 中。

## 5. MCP / skills 可用性漂移

`profileSnapshot` 固定的是“本 session 声明可用的 MCP / skills 集合”，但实际运行中仍可能发生漂移：

- MCP server 掉线。
- OAuth token 过期。
- 远程 MCP 返回 auth-required。
- 本地 MCP 进程启动失败。
- skill 文件缺失。
- skill 依赖缺失。
- tool schema 变化。

因此需要区分两个层次：

```ts
type ResourceAvailability = {
  declared: boolean
  status: 'unknown' | 'available' | 'degraded' | 'unavailable' | 'auth-required'
  checkedAt?: number
  error?: string
}
```

- `declared: true` 表示它属于 session profile 的声明能力。
- `status` 表示当前运行时健康状态。

## 6. resource failure 事件

当 MCP / skill 实际失败时，服务端应该通知客户端，让用户知道发生了什么。

建议事件：

```ts
type ResourceFailureEvent = {
  type: 'runtime.resource.failed'
  properties: {
    sessionID: string
    turnSnapshotId?: string
    resourceType: 'mcp' | 'skill'
    resourceID: string
    status: 'degraded' | 'unavailable' | 'auth-required'
    stage: 'resolve' | 'connect' | 'auth' | 'load' | 'execute'
    message: string
    recoverable: boolean
    action?: {
      type: 'open-settings' | 'start-auth' | 'retry' | 'continue-in-web'
      label: string
    }
  }
}
```

传递方式：

- Web 端通过 SSE / bus event 接收并展示。
- Feishu 这类弱交互入口可以转成简短文本提示，或提示用户到 Web 端处理。
- 如果客户端不支持资源失败事件，服务端仍写入 audit，并可作为 synthetic runtime message 进入 history。

## 7. 客户端展示原则

客户端展示时要区分严重程度：

- `auth-required`：提示用户授权或到 Web 端处理。
- `unavailable`：说明资源不可用，agent 会降级继续。
- `degraded`：说明部分能力不可用。

展示内容要让用户知道：

- 哪个 MCP / skill 出问题。
- 出问题发生在连接、认证、加载还是执行阶段。
- agent 是否已经降级继续。
- 是否有恢复动作。

## 8. 与 agent loop 的关系

资源漂移不应该让同一个 turn 的 runtime 输入悄悄变化。

建议：

- `TurnRuntimeSnapshot` 记录本轮声明资源集合。
- tool call 执行时如果资源失败，写入 resource failure event。
- agent 可以看到失败结果并选择降级方案。
- resource health 可以更新 availability，但不在同一 loop 中自动引入新的替代资源。

这样可以保持 loop 稳定，同时让用户知道实际失败。

## 9. 验收标准

1. 旧客户端不带新 capabilities 时，仍能按旧能力发送消息。
2. 不支持 page context 的客户端不会被要求提供 page context。
3. 不支持 resource failure event 的客户端仍能在 audit/history 看到失败。
4. “一次允许”的权限不会写入 `profileSnapshot`。
5. “本 session 都允许”的权限会写入 `profileSnapshot.sessionPermissionGrants`。
6. session grant 不影响其他 session。
7. MCP 声明在 profile 中但连接失败时，客户端能看到失败提示。
8. skill 声明在 profile 中但加载失败时，客户端能看到失败提示。
9. resource failure 不会导致 agent loop 中途自动重编译 resources。
10. audit 能展示协议版本、能力协商、session grants 和 resource failures。

## 10. 命令执行与解析方言

- `bash` 工具使用 Bash 或 POSIX sh 执行命令。兼容的 `SHELL` 设置会被保留；若用户的交互 shell 是 zsh 等其他方言，执行工具会选择已安装的 Bash，或使用 POSIX sh。Windows 需要 Bash/Git Bash，不会退回 cmd.exe 执行未经匹配解析的输入。
- `terminal_create` 新建的 agent 终端同样使用 Bash/sh。普通用户 PTY 的 shell 偏好不受此规则修改。
- `terminal_write` 保留交互回复和控制键的识别，但被识别为命令的输入必须通过 Bash 语法解析。已有的其他 shell 终端、主动切换过 shell 的终端，以及尚未输入完整的命令，都可能因不支持或不完整的语法被拒绝。应改写成完整的 Bash 兼容命令，不会通过跳过权限检查来兼容。
- 解析器加载失败、返回空结果或语法树含错误时，命令不会执行。普通命令、重定向和变量赋值分别进入权限评估；同一批操作中任何模式被拒绝，整批操作都不能执行。
- 这些检查不构成完整的 shell 沙箱。路径分析仅覆盖部分命令和字面路径，无法保证解析所有动态展开目标；需要强隔离的部署仍应使用操作系统或容器的文件系统与进程边界。
