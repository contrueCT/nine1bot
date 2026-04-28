# Webhook Entry Point Design Draft

本文记录 Nine1Bot Webhook 功能的当前设计共识。它是后续讨论和实现前的草稿，未确认的细节会明确标注为待讨论。

## 1. 定位

Webhook 应作为一种通用的 bot 接入点，与 Projects、MCP、Skills 等主导航入口同级展示，主导航入口命名为 `Webhooks`。

它不是 Projects 页面下的一个附属配置块。产品上更接近“外部服务如何触发 Nine1Bot”，架构上则是新的 Controller Entry / Bot Entry Point。

设计目标：

- 外部服务可以通过 HTTP webhook 自动触发 Nine1Bot agent 行动。
- Webhook source 归属到某个项目，触发后的 session 在该项目上下文中运行。
- 用户可以为每个 source 配置请求解析方式、prompt 模板、项目绑定、模型和资源选择。
- 运行过程复用现有 session/message/runtime event 能力，用户可以像查看普通对话一样查看 webhook 运行记录。

## 2. 架构原则

Webhook 入口应遵循新的 Agent Runtime / Controller 架构：

- 通过 Controller API 创建 session 和发送消息。
- 不直接绕过 runtime，也不在入口层拼出一套独立执行系统。
- 入口只描述来源、请求结构和触发意图。
- session 创建时冻结 profileSnapshot。
- Webhook source 可以显式传入 sessionChoice，用来选择模型和追加 MCP。
- 默认继承普通对话配置，即 default-user-template 仍是基础。
- MCP 第一阶段保持 add-only，只允许在默认配置基础上增加。Skills 暂不在 Webhooks UI 中展示，等 skills 有更明确的启用/关闭语义后再设计。
- 暂不提供 agent 选择，使用普通对话配置中的默认 agent。
- 模型能力保持现有 runtime / controller 设计：source 可以在 session 创建时选择模型，后续仍允许通过既有模型切换能力进行 override。
- Webhooks 页面需要展示当前服务可访问地址和隧道状态，帮助用户把正确的 webhook URL 配置到外部服务中。

建议的 entry 语义：

```ts
entry: {
  source: 'webhook',
  platform: 'generic-webhook',
  mode: 'event-trigger',
  templateIds: ['default-user-template', 'webhook-entry'],
  traceId: run.id,
}
```

具体 source 可以通过用户配置补充 `platform`、`mode` 或额外 template id，但这些字段不应隐式覆盖模型或 agent。

## 3. 通用来源与 Presets

Webhook 的目标是支持任意来源，不限定在 Uptime Kuma 或 GitLab。

当前确认的产品结构：

```text
Webhook Entry Point
  - Generic source
  - User-defined request schema
  - User-defined prompt template
  - User-defined project binding
  - User-defined model / MCP selection

Webhook Presets
  - Uptime Kuma preset
  - GitLab Webhook preset
  - Other custom presets later
```

Presets 只是配置模板，用来预填常见字段映射、认证方式和 prompt 示例。它们不代表系统只支持这些来源。

GitLab Webhook preset 与 `packages/platform-gitlab` 是两个独立概念：

- GitLab Webhook preset 处理 GitLab 服务端推送到 Nine1Bot 的 HTTP webhook event。
- `packages/platform-gitlab` 处理浏览器页面上下文中的 GitLab repo / MR / file / issue 识别。
- 两者不互相依赖。

## 4. Source 配置草案

每个 Webhook source 建议包含：

```ts
type WebhookSource = {
  id: string
  name: string
  enabled: boolean
  projectID: string

  presetId?: string

  auth: WebhookAuthConfig
  requestSchema: WebhookRequestMapping
  promptTemplate: string

  sessionPolicy: {
    mode: 'new-session-per-event'
    titleTemplate?: string
  }

  runtimeProfile: {
    modelMode: 'default' | 'custom'
    model?: { providerID: string; modelID: string }

    resourcesMode: 'default' | 'default-plus-selected'
    mcpServers?: string[]
  }

  permissionPolicy: {
    mode: 'default' | 'full'
  }

  requestGuards: {
    dedupe?: {
      enabled: boolean
      keyTemplate?: string
      ttlSeconds: number
    }
    rateLimit?: {
      enabled: boolean
      maxRequests: number
      windowSeconds: number
    }
    cooldown?: {
      enabled: boolean
      seconds: number
    }
    replayProtection?: {
      enabled: boolean
      timestampHeader?: string
      signatureHeader?: string
      maxSkewSeconds: number
    }
  }
}
```

其中 `runtimeProfile.modelMode` 的含义是：

- `default`：沿用普通对话默认模型。
- `custom`：这个 webhook source 创建 session 时使用用户在 source 配置里显式选择的模型。

`custom` 不代表锁死模型。它只表示 webhook source 在 session 创建时传入明确的模型选择；后续仍遵循现有 runtime / controller 的模型切换与 override 机制。

MCP 的 UI 先按两段式表达：

- `default`：使用用户普通对话配置中的默认 MCP。
- `add`：在默认 MCP 基础上追加指定 MCP。点击后展示当前可用 MCP 的多选列表，确认后把追加项列在下方。

无论是在 Overview 摘要里，还是在 Runtime 的 MCP 配置区，都应该显示具体启用的 MCP 名称，而不是只显示 `default + N added` 这种数量摘要。推荐分成两组展示：默认继承的 MCP、当前 source 额外追加的 MCP。

Skills 第一版不在 Webhooks 页面配置。当前没有提供清晰的关闭/启用交互，直接追加 skills 容易让用户误解为可以完整控制 skills 集合。

## 5. 请求解析与 Prompt 模板

Webhook source 应允许用户配置任意请求格式映射。

第一版建议优先支持：

- JSON body。
- headers。
- query params。
- 简单字段映射，例如 `fields.service = body.monitor.name`。
- 安全模板渲染，例如 `{{fields.service}}`、`{{body.object_kind}}`。
- 粘贴样例请求后预览渲染结果。

Prompt 模板由用户控制，系统只提供 presets 示例。

示例：

```text
项目 {{project.name}} 收到外部告警。

来源：{{source.name}}
服务：{{fields.service}}
状态：{{fields.status}}
消息：{{fields.message}}

请根据项目上下文进行检查，并在当前权限范围内执行必要操作。
```

## 6. 运行记录

Webhook 触发后应创建运行记录，用于索引和审计。

建议结构：

```ts
type WebhookRun = {
  id: string
  sourceID: string
  projectID: string
  sessionID?: string
  turnSnapshotId?: string
  status: 'received' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'busy' | 'rejected'
  receivedAt: number
  startedAt?: number
  finishedAt?: number
  requestSummary: unknown
  renderedPromptPreview: string
  error?: string
  dedupeKey?: string
}
```

运行记录列表只做索引和摘要。具体 agent 执行过程复用 session/message UI 展示。

## 7. 权限策略

Webhook 权限策略应复用现有权限类型和规则语义，不单独发明一套 webhook 专用权限模型。

第一版只提供两种用户可选模式：

- `default`：使用普通对话时 agent 拥有的权限。运行过程中如果出现额外权限请求，系统自动拒绝该请求，并把原因写入 run 记录。
- `full`：完全权限模式。运行过程中出现权限请求时，系统自动允许。

这两个模式在实现上仍应落到现有 permission 体系：

- `default` 模式继承 default-user-template / 当前普通对话权限配置，并在不支持人工交互的 webhook 场景下自动拒绝 permission ask。
- `full` 模式通过现有 permission 规则或 permission answer 机制自动允许权限请求。

如果 runtime 存在不可覆盖的 hard deny 或能力本身不可用，`full` 模式仍应失败并记录原因。

## 8. 请求保护

Webhook 是公网/局域网自动触发入口，请求保护需要作为第一版能力设计。

建议支持：

- 去重：根据用户配置的 key template 生成 dedupe key，在 TTL 内重复请求不再次触发 agent。
- 限流：按 source 维度限制窗口期内最大请求数。
- 冷却时间：某个 source 成功触发后，在冷却期内拒绝或记录但不执行新 run。
- 重放保护：支持时间戳 header、签名 header 和最大时间偏移，避免旧请求被重复发送。
- 密钥轮换：source secret 应支持重新生成，服务端只保存 hash 或等价安全表示。
- 脱敏记录：运行记录中不要保存 authorization、cookie、token 等敏感 header 原文。

请求被保护策略拦截时，也应写入 WebhookRun，状态可以是 `rejected`，并记录清晰原因。UI 不需要额外弹通知，只在 run 记录中展示即可。Webhook HTTP 响应应体现拦截结果，例如返回 `429`、`409`、`401` 或结构化 JSON 错误。

## 9. Webhooks 页面 UI/UX 要求

Webhooks 页面是用户把外部服务接入 Nine1Bot 的主要工作台。页面首屏应直接展示当前服务可访问状态，避免用户在配置外部 webhook 时不知道该使用哪个 URL。

建议首屏包含：

- 当前本地 webhook 地址，例如 `http://127.0.0.1:4096/webhooks/{sourceId}/{secret}`。
- 当前公网/局域网可访问地址，例如 tunnel URL。
- 服务监听状态，例如 `Listening`、`Stopped`、`Port unavailable`。
- 隧道状态，例如 `ngrok active`、`tunnel disabled`、`auth required`、`error`。
- 复制 URL、刷新状态等快捷操作。

当隧道不可用或服务未监听时，页面仍应允许用户编辑 source 配置，但需要在状态区域明确展示原因。Webhook 运行记录中也应保留因入口不可达、签名错误、限流、去重、冷却等原因被拒绝的 run。

当前还没有 tunnel 的 web 端配置能力，所以 Webhooks 页面第一版不展示 tunnel setup / tunnel config 入口。后续如果补齐 tunnel 管理功能，再把配置入口放回状态区域。

## 10. 开发阶段拆分

这个功能建议分三阶段完成。第一阶段必须做成能真实接收 webhook 并启动 session 的纵向闭环，后续配置和体验都基于这个闭环逐步增强。

### 阶段 1：端到端 MVP

目标：打通“外部请求 -> WebhookRun -> Controller 创建 session -> agent 执行 -> UI 可追溯”的最小可用链路。

开发任务：

- Web 端增加顶级 `Webhooks` 导航入口，与 Projects 同级。
- 实现 Webhooks 页面基础结构：地址状态区、source 列表、source 详情、runs 列表。
- 定义并持久化最小 `WebhookSource` / `WebhookRun` 数据结构。
- 支持 source 的创建、编辑、启用/停用、删除或软删除。
- 提供本地 webhook endpoint，例如 `POST /webhooks/:sourceId/:secret`。
- 支持 source secret 校验，服务端保存 hash 或等价安全表示。
- 支持 JSON body、headers、query params 的基础读取。
- 支持简单字段映射和 prompt 模板渲染。
- 支持项目绑定，触发后在绑定项目上下文下创建新 session。
- 通过 Controller API 创建 session 并发送渲染后的首条用户消息。
- 第一阶段只支持 `new-session-per-event`。
- Runtime 先使用普通对话默认模型、默认 MCP、默认权限策略。
- Webhook 场景下如果出现额外权限请求，默认自动拒绝并写入 run 记录。
- Run 记录展示 received / accepted / running / succeeded / failed / rejected 等状态。
- Run 记录可以跳转到对应 session，具体执行过程复用现有对话记录 UI。
- 对 request summary 做基础脱敏，避免保存 authorization、cookie、token 等敏感 header 原文。

阶段完成标准：

- 用户能创建一个 source，把本地 URL 配到外部服务或用 curl 发送测试请求。
- Nine1Bot 能创建对应项目下的新 session，并启动 agent 行动。
- Webhooks 页面能看到 run 记录和对应 session。

### 阶段 2：运行配置与请求保护

目标：补齐 webhook 自动触发场景下最重要的 runtime 选择、安全策略和滥用防护。

开发任务：

- Model 支持 `default/custom`：`default` 展示用户普通对话配置中的默认模型，`custom` 提供模型下拉选择。
- `custom` 只作为 session 创建时的初始模型选择，后续仍遵循现有 runtime / controller 的模型 override 机制。
- MCP 支持 `default/add`：`default` 展示用户普通对话配置中的默认 MCP，`add` 展示当前可用 MCP 多选，确认后列出额外追加项。
- Skills 暂不在 Webhooks 页面展示。
- 权限策略支持 `default/full` 两种模式，并映射到现有 permission 类型和规则语义。
- `default` 权限模式下，额外 permission ask 自动拒绝。
- `full` 权限模式下，permission ask 自动允许；runtime hard deny 或能力不可用时仍失败并记录原因。
- 实现去重：根据 key template 生成 dedupe key，在 TTL 内重复请求不再次触发 agent。
- 实现限流：按 source 维度限制窗口期内最大请求数。
- 实现冷却时间：source 成功触发后，冷却期内记录但不执行新 run。
- 实现重放保护：支持 timestamp header、signature header、最大时间偏移。
- 实现 secret rotate，并保证旧 secret 的失效逻辑清晰。
- 请求保护触发时写入 run 记录，并返回对应 HTTP 状态或结构化 JSON 错误。
- 增加关键链路的类型检查和必要测试，重点覆盖 request guard、权限策略、sessionChoice 生成。

阶段完成标准：

- 每个 source 可以明确配置模型、追加 MCP、权限模式和请求保护策略。
- 防护策略触发时，UI 与 HTTP 响应都能明确体现原因。
- 自动触发不会绕开现有 Controller / Runtime / Permission 体系。

### 阶段 3：Presets 与体验完善

目标：让常见接入场景更容易配置，同时把 UI 的可理解性和排错能力补齐。

开发任务：

- 提供 Uptime Kuma preset：预填认证建议、样例请求、字段映射、prompt 模板。
- 提供 GitLab Webhook preset：作为普通 webhook preset，与 `packages/platform-gitlab` 保持独立。
- 提供 Generic JSON preset，作为任意来源的起点。
- 支持粘贴样例请求并预览字段映射结果。
- 支持 prompt 模板实时渲染预览。
- Source 列表增加搜索、状态筛选、preset / project / enabled 状态展示。
- Run 列表增加状态筛选、source 筛选、错误原因摘要、HTTP 响应码展示。
- Webhooks 页面展示服务监听状态、本地地址、当前可用 tunnel 地址和 tunnel 状态。
- 在 web 端 tunnel 配置功能完成前，只展示 tunnel 只读状态，不提供 tunnel setup / tunnel config 入口。
- 补齐空状态、错误态、加载态和危险操作确认，例如 rotate secret、删除 source、full 权限提示。
- 根据真实实现更新产品文档和手动验证步骤。

阶段完成标准：

- 用户能通过 preset 快速完成 Uptime Kuma / GitLab Webhook 这类常见接入。
- 配置页面能解释当前 source 会继承哪些默认能力、追加哪些 MCP、使用哪个模型和权限策略。
- 运行失败或被防护拦截时，用户能从 run 记录中定位原因。

## 11. 待讨论问题

后续需要继续确认：

- `default/custom` 在 UI 上的具体文案。
- `full` 权限模式在 UI 上是否需要额外风险确认。
