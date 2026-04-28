# Nine1Bot 新架构打点与量化指标规划

## 1. 目标

基于新的 Agent Runtime 架构，建立一套可持续扩展的观测方案，满足以下三层指标需求：

- 接口层：请求数、成功率、P95/P99 响应时间、错误码分布
- 模型层：每次请求 token、cost、首字延迟、总耗时、finish reason、provider/model 维度聚合
- 工具层：工具调用次数、成功率、平均耗时、失败原因

同时要求：

- 优先复用新架构已提供的 Controller API、Runtime Event、Debug/Audit 能力
- 不再围绕旧 session/message 内部实现做强耦合埋点
- 支持 Web UI、CLI、SSE、Debug Panel、Prometheus、OpenTelemetry 等多种消费方式
- 支持未来 GitLab、Browser、Feishu 等入口和 platform adapter 的渐进扩展

## 2. 新架构下的关键变化

相比旧架构，当前系统的核心边界已经发生变化：

- 产品入口统一通过 Controller 接入
- Controller 负责生成 `AgentRunSpec`
- Runtime 负责将 `AgentRunSpec` 编译为 `TurnRuntimeSnapshot` 并执行 agent loop
- 运行过程通过统一的 `RuntimeEventEnvelope` 输出事件
- 会话级稳定配置通过 `profileSnapshot` 持久化
- 调试与审计通过 Debug API 暴露 `profileSnapshot`、`turnSnapshot`、`contextAudit`、`resourceAudit`、事件列表

新架构下，打点不应再以“直接深入某段历史执行代码补日志”为主，而应改为：

1. 以 Controller API 为请求入口观测边界
2. 以 Runtime Event 为统一事件源
3. 以 Debug/Audit 为补充解释层
4. 以聚合服务为指标计算层

## 3. 相关文档与可复用能力

本规划主要基于以下文档：

- `docs/agent-runtime-developer-guide/01-runtime-controller-architecture.md`
- `docs/agent-runtime-developer-guide/03-agent-run-spec-fields.md`
- `docs/agent-runtime-developer-guide/05-conversation-runtime-flow.md`
- `docs/agent-runtime-developer-guide/07-context-pipeline-implementation-design.md`
- `docs/agent-runtime-developer-guide/08-resource-resolver-implementation-design.md`
- `docs/agent-runtime-developer-guide/09-platform-adapter-boundary.md`
- `docs/agent-runtime-developer-guide/11-controller-api-runtime-events.md`

新架构已明确提供的观测相关能力：

- `GET /nine1bot/runtime/capabilities`
- `POST /nine1bot/agent/sessions`
- `POST /nine1bot/agent/sessions/:id/messages`
- `GET /nine1bot/agent/sessions/:id/events`
- `GET /nine1bot/agent/sessions/:id/debug?turnSnapshotId=...`
- `runtimeOverride.debug`
- `runtimeOverride.timing`
- `RuntimeEventEnvelope`
- `profileSnapshot`
- `TurnRuntimeSnapshot`
- `contextAudit`
- `resourceAudit`

结论：

- 新架构已经具备“标准化观测协议”的基础
- 新版打点方案的重点不是自己重新发明事件流，而是规范如何消费、补足和聚合这些事件

## 4. 设计原则

### 4.1 事件优先，指标后算

底层先产出统一结构化事件，再由聚合层计算：

- counter
- rate
- avg
- P50 / P95 / P99
- topN
- 按维度聚合

这样可以避免每个入口各自维护一套统计口径。

### 4.2 Snapshot 与 History 分离

新架构里必须尊重两条边界：

- `history` 负责表达语义事实
- `TurnRuntimeSnapshot` 负责冻结本轮运行时输入

因此打点也要分开：

- 语义类事件：context event、message completed、resource failed
- 运行时类事件：turn started、context compiled、resources resolved、turn completed、turn failed

### 4.3 低侵入

优先采集以下现成输出：

- Controller API 请求/响应
- SSE Runtime Events
- Debug API 审计数据

只有当现有事件不能满足指标需求时，才补新的 telemetry 字段或 event type。

### 4.4 标签控制

通用指标只允许低基数标签进入聚合系统，例如：

- `route`
- `method`
- `status`
- `entry_source`
- `platform`
- `provider`
- `model`
- `agent`
- `tool`
- `result`
- `finish_reason`
- `resource_type`
- `error_type`

以下字段只保存在事件明细或 debug/audit 中，不进入公共 labels：

- `sessionId`
- `turnSnapshotId`
- `profileSnapshotId`
- `messageId`
- 原始 URL
- 原始错误全文
- 原始用户输入

### 4.5 与平台适配解耦

GitLab、Browser、Feishu 等平台相关语义应通过 adapter 提供 page context / template / resource contribution。
指标系统不直接依赖具体平台实现，只消费统一字段：

- `entry.source`
- `entry.platform`
- `context event`
- `resource resolved`
- `resource failed`

## 5. 新架构下的观测分层

建议按五层理解，而不是只看三层：

1. 接口接入层
   - Controller API 请求与响应
2. 会话/回合层
   - `profileSnapshot`、`turnSnapshot`、busy reject、turn lifecycle
3. 上下文编译层
   - context pipeline、dedupe、budget/drop、page context 注入
4. 资源解析层
   - tools、MCP、skills、permission gate、resource availability
5. 模型与工具执行层
   - LLM 输出、tool call、tool result、turn completion

其中用户最直接关心的三类指标仍然是：

- 接口层
- 模型层
- 工具层

但为了让这些指标可解释、可扩展，底座必须额外覆盖回合层、上下文层、资源层。

## 6. 统一事件来源

### 6.1 Controller API 事件

应围绕以下 API 采集：

- `GET /nine1bot/runtime/capabilities`
- `POST /nine1bot/agent/templates/resolve`
- `POST /nine1bot/agent/sessions`
- `POST /nine1bot/agent/sessions/:id/messages`
- `POST /nine1bot/agent/sessions/:id/model`
- `POST /nine1bot/agent/permissions/:requestId/answer`
- `GET /nine1bot/agent/sessions/:id/debug`
- `GET /nine1bot/agent/sessions/:id/events`

这些请求天然对应接口层指标。

### 6.2 Runtime Event 事件

统一消费以下事件类型：

- `runtime.turn.started`
- `runtime.context.event`
- `runtime.context.compiled`
- `runtime.resources.resolved`
- `runtime.resource.failed`
- `runtime.permission.requested`
- `runtime.permission.answered`
- `runtime.model.changed`
- `runtime.message.delta`
- `runtime.message.completed`
- `runtime.turn.completed`
- `runtime.turn.failed`

这些事件是新的主观测源。

### 6.3 Debug/Audit 辅助数据

Debug API 提供：

- `profileSnapshot`
- `turnSnapshot`
- `contextAudit`
- `resourceAudit`
- `permissionAudit`
- `events`

它们不适合作为实时主数据流，但非常适合：

- 排查指标口径问题
- 做抽样审计
- 给 Debug Panel 展示解释信息

## 7. 指标体系设计

## 7.1 接口层指标

目标：衡量 Controller API 的可用性、性能和入口差异。

核心指标：

- `controller_api_requests_total`
  - 维度：`route`, `method`, `entry_source`
- `controller_api_responses_total`
  - 维度：`route`, `method`, `status`
- `controller_api_errors_total`
  - 维度：`route`, `method`, `status`, `error_type`
- `controller_api_duration_ms`
  - 维度：`route`, `method`, `status`
- `controller_api_busy_reject_total`
  - 维度：`route`, `entry_source`, `platform`

建议重点看：

- `POST /nine1bot/agent/sessions/:id/messages`
  - 请求量
  - 成功率
  - Busy reject 比例
  - P95/P99

新增说明：

- 新架构下 busy reject 是重要系统行为，不只是“一个错误”
- 它必须单独作为指标监控，而不是混入普通 4xx

## 7.2 回合层指标

目标：衡量单轮 agent 运行的整体健康度。

核心指标：

- `runtime_turn_started_total`
  - 维度：`entry_source`, `platform`, `agent`
- `runtime_turn_completed_total`
  - 维度：`entry_source`, `platform`, `agent`, `result`
- `runtime_turn_failed_total`
  - 维度：`entry_source`, `platform`, `agent`, `error_type`
- `runtime_turn_duration_ms`
  - 维度：`entry_source`, `platform`, `agent`, `result`

其中 `result` 建议规范为：

- `completed`
- `failed`
- `busy-reject`

这层是模型层和工具层的总包络，后续页面上适合展示“单轮平均耗时”“失败率”“按入口分布”。

## 7.3 模型层指标

目标：衡量 LLM 请求性能、成本和模型行为。

核心指标：

- `llm_requests_total`
  - 维度：`provider`, `model`, `agent`, `entry_source`, `platform`
- `llm_request_errors_total`
  - 维度：`provider`, `model`, `error_type`
- `llm_first_token_latency_ms`
  - 维度：`provider`, `model`, `agent`
- `llm_total_duration_ms`
  - 维度：`provider`, `model`, `agent`, `finish_reason`
- `llm_input_tokens_total`
  - 维度：`provider`, `model`
- `llm_output_tokens_total`
  - 维度：`provider`, `model`
- `llm_reasoning_tokens_total`
  - 维度：`provider`, `model`
- `llm_cache_read_tokens_total`
  - 维度：`provider`, `model`
- `llm_cache_write_tokens_total`
  - 维度：`provider`, `model`
- `llm_cost_usd_total`
  - 维度：`provider`, `model`
- `llm_finish_reasons_total`
  - 维度：`provider`, `model`, `finish_reason`

建议补充的单次明细字段：

- `session_id`
- `turn_snapshot_id`
- `profile_snapshot_id`
- `provider`
- `model`
- `agent`
- `entry_source`
- `platform`
- `started_at`
- `first_token_at`
- `finished_at`
- `first_token_latency_ms`
- `duration_ms`
- `finish_reason`
- `input_tokens`
- `output_tokens`
- `reasoning_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `cost_usd`
- `success`

### 模型层事件来源建议

优先来源：

- `runtime.turn.started`
- `runtime.message.delta`
- `runtime.message.completed`
- `runtime.turn.completed`
- `runtime.turn.failed`

补充来源：

- `turnSnapshot`
- `contextAudit`
- `resourceAudit`

说明：

- 首字延迟可以通过首个 `runtime.message.delta` 相对 `runtime.turn.started` 的时间计算
- 总耗时可以通过 `runtime.turn.completed` 相对 `runtime.turn.started` 的时间计算
- token/cost 最好由 runtime 在 `runtime.turn.completed` 或 `runtime.message.completed` 数据中直接输出
- 如果首版没有完整 token/cost 事件字段，可以先通过现有内部 usage 汇总补齐，但新架构目标应是事件直出

## 7.4 工具层指标

目标：衡量 tool、MCP tool、skill 相关执行链路的效率与稳定性。

核心指标：

- `tool_calls_total`
  - 维度：`tool`, `source`, `agent`
- `tool_results_total`
  - 维度：`tool`, `source`, `result`
- `tool_call_duration_ms`
  - 维度：`tool`, `source`, `result`
- `tool_call_errors_total`
  - 维度：`tool`, `source`, `error_type`

这里的 `source` 建议为：

- `builtin`
- `mcp`

失败原因建议统一分类为：

- `permission_denied`
- `resource_unavailable`
- `auth_required`
- `validation_error`
- `timeout`
- `runtime_error`
- `unknown`

新架构补充关注点：

- skill 不一定总是直接表现为 tool call，但 resource failure 和 context contribution 也要纳入观测
- MCP 工具需要区分“声明了但不可用”和“执行时报错”

## 7.5 上下文层指标

目标：衡量 context pipeline 的稳定性和投入产出。

核心指标：

- `context_events_total`
  - 维度：`event_type`, `action`, `platform`
- `context_compiled_total`
  - 维度：`entry_source`, `platform`, `agent`
- `context_blocks_compiled_total`
  - 维度：`layer`, `lifecycle`, `source`
- `context_blocks_dropped_total`
  - 维度：`reason`, `layer`, `source`
- `context_compile_duration_ms`
  - 维度：`entry_source`, `platform`

重点看：

- `runtime.context.event` 里的 `inserted` / `deduped`
- `runtime.context.compiled`
- context budget 导致的裁剪情况

这是新架构特有的高价值观测层，可以帮助解释：

- 为什么某轮回答变差
- 为什么上下文重复注入
- 为什么 GitLab 页面的上下文没有生效

## 7.6 资源层指标

目标：衡量 resolver、MCP、skill、permission gate 的运行健康度。

核心指标：

- `resource_resolve_total`
  - 维度：`entry_source`, `platform`, `agent`
- `resource_resolve_duration_ms`
  - 维度：`entry_source`, `platform`
- `resource_availability_total`
  - 维度：`resource_type`, `status`
- `resource_failed_total`
  - 维度：`resource_type`, `stage`, `status`, `recoverable`
- `permission_requested_total`
  - 维度：`tool`, `permission`
- `permission_answered_total`
  - 维度：`tool`, `answer`

其中 `resource_type`：

- `mcp`
- `skill`

其中 `stage`：

- `resolve`
- `connect`
- `auth`
- `load`
- `execute`

这层可以直接服务于后续 GitLab/MCP 接入的可观测性需求。

## 8. 统一事件模型建议

虽然新架构已有 `RuntimeEventEnvelope`，但为指标聚合方便，建议内部再定义一层归一化事件视图：

### 8.1 API 归一化事件

```json
{
  "kind": "api_request",
  "route": "/nine1bot/agent/sessions/:id/messages",
  "method": "POST",
  "status": 200,
  "duration_ms": 85,
  "entry_source": "web",
  "platform": "gitlab",
  "busy": false,
  "timestamp": 1710000000000
}
```

### 8.2 Runtime Turn 归一化事件

```json
{
  "kind": "runtime_turn",
  "session_id": "session_xxx",
  "turn_snapshot_id": "turn_xxx",
  "profile_snapshot_id": "profile_xxx",
  "entry_source": "web",
  "platform": "gitlab",
  "agent": "build",
  "provider": "openai",
  "model": "gpt-4.1",
  "started_at": 1710000000000,
  "first_token_at": 1710000001100,
  "finished_at": 1710000006500,
  "first_token_latency_ms": 1100,
  "duration_ms": 6500,
  "finish_reason": "stop",
  "success": true
}
```

### 8.3 Tool 归一化事件

```json
{
  "kind": "tool_call",
  "session_id": "session_xxx",
  "turn_snapshot_id": "turn_xxx",
  "tool": "read_file",
  "source": "builtin",
  "started_at": 1710000001200,
  "finished_at": 1710000001300,
  "duration_ms": 100,
  "result": "completed",
  "error_type": null
}
```

### 8.4 Resource Failure 归一化事件

```json
{
  "kind": "resource_failure",
  "session_id": "session_xxx",
  "turn_snapshot_id": "turn_xxx",
  "resource_type": "mcp",
  "resource_id": "gitlab-mcp",
  "status": "auth-required",
  "stage": "auth",
  "recoverable": true,
  "timestamp": 1710000002500
}
```

## 9. 推荐采集位置

## 9.1 Controller API 层

优先位置：

- Controller API middleware
- 各新协议路由 handler 外层

采集内容：

- route template
- method
- status
- duration
- busy reject
- entry source
- platform
- trace id

## 9.2 Runtime Event 层

优先位置：

- Runtime Event publish/emit 统一出口
- SSE channel 出口

采集内容：

- event type
- sessionId
- turnSnapshotId
- createdAt
- normalized payload

说明：

- 这里是新版打点的主入口
- 新增指标优先从 event 层扩展，而不是直接深入业务模块

## 9.3 Debug/Audit 层

优先位置：

- Debug API
- `runtimeOverride.debug`
- `runtimeOverride.timing`

采集内容：

- context compile audit
- resource resolve audit
- dropped blocks
- unavailable resources
- timing trace

说明：

- 这层更适合抽样和排障
- 不建议默认全量高频采集到实时指标系统

## 10. 新架构自带 API 的使用建议

### 10.1 `runtimeOverride.timing`

建议作为“细粒度时序采样开关”，优先用于：

- 性能排查
- 压测采样
- 对关键回合做分阶段耗时拆解

建议拆出以下阶段：

- controller request receive
- busy reservation
- context event dedupe/insert
- user message write
- turn snapshot build
- context compile
- resource resolve
- permission gate prepare
- llm start
- first token
- tool phase
- final complete

不要默认对全部请求开启细粒度 timing 明细，避免开销与数据量膨胀。

### 10.2 SSE `/events`

建议作为实时指标与前端动态展示的数据源：

- 前端实时状态
- 轻量实时聚合
- debug panel 时间线

### 10.3 Debug API

建议作为：

- 审计与解释接口
- 离线分析数据源
- 采样式质量核查数据源

不要把 Debug API 当成主指标流。

### 10.4 Capabilities API

建议将能力协商结果纳入指标上下文：

- 哪些客户端支持 page context
- 哪些客户端支持 permission ask
- 哪些客户端支持 resource failure events

这有助于解释不同入口指标表现差异。

## 11. 数据存储与导出

建议保留两层存储：

### 11.1 原始事件存储

用于：

- 回放
- 排查
- 指标口径迭代

可选方案：

- 本地 JSONL
- 项目 Storage
- ClickHouse / Loki

### 11.2 聚合指标存储

用于：

- Web 仪表盘
- CLI summary
- Prometheus exporter

建议优先级：

1. 先做项目内聚合
2. 再做标准 exporter

## 12. Web / CLI 展示建议

### 12.1 总览页

- 请求总数
- 成功率
- Busy reject 比例
- P95/P99 接口耗时
- 总 token
- 总 cost
- 工具调用总数
- 资源失败总数

### 12.2 回合页

- 单轮平均耗时
- 首字延迟
- turn completion rate
- turn fail rate
- 按入口/平台分布

### 12.3 模型页

- 按 `provider/model` 展示请求数、P95 耗时、首字延迟、token、cost、finish reason

### 12.4 工具页

- 按 `tool` 展示调用次数、成功率、平均耗时、P95、失败原因

### 12.5 上下文与资源页

- context event 插入与去重统计
- dropped blocks 分布
- resource availability 分布
- resource failed 明细

## 13. 分阶段实施计划

### 阶段一：协议对齐与事件映射

目标：

- 先完成“新架构事件到指标视图”的映射
- 不急着补大量新埋点

内容：

- 明确 Runtime Event -> 指标字段映射表
- 明确 Controller API -> 接口指标映射表
- 明确 Debug/Audit -> 抽样排障字段映射表

产出：

- 统一事件 schema
- 字段字典
- 指标口径说明

### 阶段二：最小可用聚合层

目标：

- 快速看到接口层、模型层、工具层的基础数据

内容：

- 消费 Controller API 请求
- 消费 Runtime Event SSE
- 聚合 turn、llm、tool、resource failure 基础指标

产出：

- 内部聚合服务
- 基础查询接口
- 简易仪表盘

### 阶段三：补齐 timing 与解释层

目标：

- 把“知道慢”升级成“知道慢在哪”

内容：

- 在关键请求上支持 `runtimeOverride.timing`
- 抽样采集 timing trace
- 关联 `contextAudit`、`resourceAudit`

产出：

- 分阶段耗时视图
- context compile / resource resolve 耗时拆解

### 阶段四：平台与资源专项观测

目标：

- 支撑 GitLab / Browser / MCP 扩展

内容：

- page context 注入效果统计
- resource failure 分阶段统计
- permission ask / answer 行为统计

产出：

- 平台专项指标页
- MCP/Skill 健康度视图

### 阶段五：标准导出

目标：

- 接入外部监控体系

内容：

- Prometheus exporter
- OTLP exporter
- 可选 trace 关联

## 14. 扩展性预留

后续可自然扩展到：

- 会话层指标
  - profile snapshot 创建量
  - legacy session 恢复量
- 平台层指标
  - GitLab repo/MR/issue 页面分布
  - Browser 插件 page payload 质量
- 权限层指标
  - allow-once / allow-session / deny 比例
- 编排层指标
  - single / plan-then-act / supervisor-workers / parallel-review 分布
- 资源层指标
  - MCP auth-required 趋势
  - skill load 失败分布

建议从第一版起统一保留以下公共字段：

- `session_id`
- `turn_snapshot_id`
- `profile_snapshot_id`
- `entry_source`
- `platform`
- `agent`
- `provider`
- `model`
- `tool`
- `result`
- `error_type`
- `timestamp`

## 15. 风险与注意事项

### 15.1 过度依赖旧内部结构

风险：

- 如果仍把旧的 session/message/part 实现当主采集源，后续 runtime 重构会持续打破指标口径

建议：

- 优先消费新协议事件和 snapshot/audit

### 15.2 Runtime Event 字段不够细

风险：

- 首版 runtime event 可能不足以直接产出全部模型/工具指标

建议：

- 优先补 event payload 字段，而不是在外围做脆弱推断

### 15.3 Timing 全量开启成本高

风险：

- `runtimeOverride.timing` 如果全量开启，可能带来明显开销和数据膨胀

建议：

- 默认关闭
- 采样开启
- 问题回放按需开启

### 15.4 Debug 与指标混用

风险：

- 把 debug/audit 全量当指标源会导致数据过重、结构不稳

建议：

- Debug/Audit 只做补充解释层
- 指标主源仍应是稳定协议事件

## 16. 建议的下一步

建议按以下顺序推进：

1. 先补一版“Runtime Event 到指标”的字段映射表
2. 确认 `runtime.turn.completed` / `runtime.message.completed` 是否需要补 token、cost、finish reason 字段
3. 确认 tool call / tool result 是否已在 runtime event 层稳定暴露，若没有则优先补齐
4. 在 Controller API middleware 上落接口层基础指标
5. 做一个最小聚合服务，先支撑总览页和模型页
6. 再引入采样式 timing trace 与 debug/audit 关联

如果后续开始实现，建议优先新增：

- 一个 Runtime Event normalizer
- 一个 metrics 聚合服务
- 一个 metrics 查询接口
- 一个最小 Web 仪表盘

## 17. 实施清单总览

为了让这份规划能够直接指导代码实施，建议把第一阶段工作拆成四个问题来推进：

1. 哪些 event 现在已经有，可以直接消费
2. 哪些字段现在还缺，需要优先补到协议事件里
3. 第一批代码应该改哪些模块
4. 第一版 dashboard 先展示什么

本节给出建议清单，默认目标是“先让指标跑起来，再补精细化解释层”。

## 18. 哪些 event 现在已有

以下内容已经在当前仓库和新协议实现里可见，原则上不需要重新设计，只需要接入和规范化消费。

### 18.1 Controller API 已有

已存在的协议路由文件：

- `opencode/packages/opencode/src/server/routes/nine1bot-agent.ts`

已存在的 API：

- `GET /nine1bot/runtime/capabilities`
- `POST /nine1bot/agent/templates/resolve`
- `POST /nine1bot/agent/sessions`
- `POST /nine1bot/agent/sessions/:sessionID/messages`
- `POST /nine1bot/agent/sessions/:sessionID/model`
- `POST /nine1bot/agent/interactions/:requestID/answer`
- `GET /nine1bot/agent/sessions/:sessionID/debug`
- `GET /nine1bot/agent/sessions/:sessionID/events`

这些 API 已经足够支撑接口层指标。

### 18.2 Runtime Event 已有

当前协议声明里已有的 runtime event type：

- `runtime.server.connected`
- `runtime.server.heartbeat`
- `runtime.session.created`
- `runtime.session.updated`
- `runtime.session.deleted`
- `runtime.session.status`
- `runtime.message.created`
- `runtime.message.updated`
- `runtime.message.removed`
- `runtime.message.part.updated`
- `runtime.message.part.removed`
- `runtime.interaction.requested`
- `runtime.interaction.answered`
- `runtime.artifact.available`
- `runtime.artifact.closed`
- `runtime.resource.failed`
- `runtime.resources.resolved`
- `runtime.context.compiled`
- `runtime.turn.started`
- `runtime.turn.completed`
- `runtime.turn.failed`
- `runtime.todo.updated`

协议定义位置：

- `opencode/packages/opencode/src/runtime/controller/protocol.ts`

事件投影位置：

- `opencode/packages/opencode/src/runtime/controller/events.ts`

### 18.3 当前实现里已经明确发出的关键事件

以下事件不仅在协议中声明了，而且当前实现中已经能看到具体发布逻辑：

- `runtime.turn.started`
  - 来源：`RuntimeControllerEvents.TurnStarted`
- `runtime.context.compiled`
  - 来源：`RuntimeControllerEvents.ContextCompiled`
- `runtime.resources.resolved`
  - 来源：`RuntimeResourceResolver.ResolvedEvent`
- `runtime.resource.failed`
  - 来源：`RuntimeResourceResolver.Failed`

对应文件：

- `opencode/packages/opencode/src/runtime/controller/events.ts`
- `opencode/packages/opencode/src/runtime/resource/resolver.ts`

### 18.4 可直接复用的调试与审计数据

当前 Debug API 已经能返回：

- `profileSnapshot`
- `resourceAudit`
- `contextEvents`
- `recentMessages`

来源：

- `debugSession()` in `opencode/packages/opencode/src/server/routes/nine1bot-agent.ts`

这意味着：

- 接口层指标可以直接做
- 回合开始、上下文编译、资源解析、资源失败已经有统一事件源
- 上下文和资源层的初版面板已经有可用数据基础

## 19. 哪些字段现在还缺

这部分是第一批最值得补的内容。优先原则不是“让事件更全”，而是“让核心指标不需要靠脆弱推断”。

### 19.1 模型层字段缺口

当前最明显的缺口是，模型层虽然已经有 `runtime.turn.started` / `runtime.turn.completed` / `runtime.turn.failed` 这些生命周期事件，但还缺少稳定的模型指标字段。

建议优先补充到 `runtime.turn.completed` 或 `runtime.message.completed`：

- `providerID`
- `modelID`
- `agent`
- `finishReason`
- `inputTokens`
- `outputTokens`
- `reasoningTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `costUsd`
- `firstTokenAt`
- `completedAt`
- `durationMs`
- `firstTokenLatencyMs`

如果协议上不想让 `runtime.turn.completed` 过重，也可以拆为：

- `runtime.message.completed`
  - 承担 token / cost / finish reason
- `runtime.turn.completed`
  - 承担 turn 级总状态与总耗时

但至少要保证其中一条事件能稳定提供模型量化字段。

### 19.2 工具层字段缺口

当前事件流里还缺少一类“对 dashboard 友好的工具级 runtime 事件”。

虽然旧实现中有 `message.part.updated`，其中 tool part 里可以推断出：

- tool name
- running/completed/error
- start/end time

但这仍然偏底层，对聚合层不够友好。

建议新增或标准化以下事件：

- `runtime.tool.started`
- `runtime.tool.completed`
- `runtime.tool.failed`

至少需要稳定暴露字段：

- `tool`
- `toolCallId`
- `source`
  - `builtin` / `mcp`
- `startedAt`
- `finishedAt`
- `durationMs`
- `result`
- `errorType`
- `errorMessage`

如果暂时不想新增 event type，也至少要让 `runtime.message.part.updated` 中的 tool payload 有规范化抽取器。

### 19.3 首字延迟字段缺口

当前协议里有 `runtime.message.updated` 和 `runtime.message.part.updated`，理论上可以通过“首个文本 delta 的时间”推导首字延迟，但这会让聚合层逻辑复杂且不稳定。

建议优先二选一：

1. 在 `runtime.turn.completed` 里直接输出 `firstTokenLatencyMs`
2. 新增单独事件 `runtime.message.first-token`

第一版更推荐做法 1，改动小，消费简单。

### 19.4 接口层上下文字段缺口

为了让接口层能按入口和平台切片，建议确保以下字段在路由层可稳定取到：

- `entry.source`
- `entry.platform`
- `entry.mode`
- `traceId`

这部分在 `RuntimeControllerProtocol.Entry` 里已经定义了，但需要确保：

- 中间件或 handler 统计时能统一取到
- 没带值时有默认值，比如 `source=api` 或 `platform=unknown`

### 19.5 Timing 分阶段字段缺口

`runtimeOverride.timing` 现在已经是协议字段，但文档层面提到了 timing，代码层还没有形成一套统一 timing payload。

建议第一批至少统一这些阶段名：

- `request_received`
- `busy_reserved`
- `context_event_processed`
- `prompt_compiled`
- `context_compiled`
- `resources_resolved`
- `llm_started`
- `first_token`
- `llm_completed`
- `turn_completed`

并且建议产物结构固定为：

```ts
type TimingPhase = {
  name: string
  at: number
  durationMs?: number
  metadata?: Record<string, unknown>
}
```

### 19.6 Dashboard 查询接口缺口

目前还没有看到专门给 dashboard 使用的 metrics query API。

建议新增最小查询接口，例如：

- `GET /nine1bot/metrics/overview`
- `GET /nine1bot/metrics/models`
- `GET /nine1bot/metrics/tools`
- `GET /nine1bot/metrics/resources`

第一版不用追求通用查询 DSL，先把固定聚合接口做出来。

## 20. 第一批代码应该改哪些模块

建议按“先协议边界、再事件归一化、再聚合、最后展示”的顺序推进。

### 20.1 第一优先级：协议入口与事件出口

这些模块最先改，收益最高。

#### A. `server/routes/nine1bot-agent.ts`

职责：

- 给 Controller API 统一补接口层统计
- 在 `create session`、`send message`、`change model`、`answer interaction`、`debug` 等入口上记录 API 指标
- 抽取 `entry.source`、`entry.platform`、`traceId`

建议改动：

- 增加 route 级 metrics middleware 或轻量 helper
- 统一记录 busy reject
- 统一记录 protocol version / capabilities 命中情况

#### B. `runtime/controller/events.ts`

职责：

- 当前 runtime 事件投影中心
- 最适合补“事件归一化增强字段”

建议改动：

- 为 `runtime.turn.completed` 补结构化完成态字段
- 为 `runtime.turn.failed` 补标准化 `errorType`
- 视情况新增 `runtime.tool.*` 事件投影
- 统一规范 envelope data 形状，减少前端和聚合层的兼容逻辑

#### C. `runtime/controller/protocol.ts`

职责：

- 协议 type 和 eventTypes 清单的源头

建议改动：

- 如果新增 `runtime.tool.started/completed/failed`
  - 这里需要补到 `RuntimeEventTypes`
- 如果新增 `runtime.message.first-token`
  - 这里也需要更新协议清单

### 20.2 第二优先级：运行时编译与资源层

#### D. `runtime/context/pipeline.ts`

职责：

- 已有编译结果、dropped、audit、tokenEstimate

建议改动：

- 如果启用 timing，记录 `context_compile_duration_ms`
- 在 audit 里补更稳定的 `layer/source/reason` 输出
- 为 dashboard 预留易消费的 summary 结构

这部分主要支撑上下文层面板和性能拆解。

#### E. `runtime/resource/resolver.ts`

职责：

- 已经有 resolved event 和 failed event

建议改动：

- 记录 `resource_resolve_duration_ms`
- `ResolvedEvent` 中补 `builtinTools` 统计
- 失败事件里统一 `reason` 与 `message`
- 尽量补 `checkedAt`

这部分主要支撑资源层和 MCP/skill 健康度指标。

### 20.3 第三优先级：模型执行链路

#### F. `session/processor.ts`

职责：

- 当前仍掌握实际 LLM/tool 生命周期细节

建议改动：

- 补首字时间、完成时间、tool 起止时间的标准化采集
- 把这些数据通过 runtime 事件抛出去，而不是只落在旧 message/part 模型里

即便新架构要以 runtime 事件为主，短期内这里仍然是很多关键数据的真实来源。

#### G. `session/llm.ts`

职责：

- 当前掌握 provider/model、stream 开始点

建议改动：

- 采集 LLM start timing
- 为 `first token latency` 提供底层时间点
- 如果需要，补 provider/model/usage 归一化 helper

### 20.4 第四优先级：聚合与展示

#### H. 新增 metrics 聚合模块

建议路径：

- `opencode/packages/opencode/src/runtime/metrics/`

建议文件：

- `normalizer.ts`
- `aggregator.ts`
- `queries.ts`
- `types.ts`

职责：

- 消费 API 事件与 Runtime Event
- 转成统一 metrics event
- 做窗口聚合
- 提供 dashboard 查询

#### I. 新增 metrics 路由

建议路径：

- `opencode/packages/opencode/src/server/routes/metrics.ts`

职责：

- 给 Web dashboard 提供固定查询接口

### 20.5 测试模块

建议优先补这些测试目录：

- `opencode/packages/opencode/test/controller/`
- `opencode/packages/opencode/test/resource/`
- `opencode/packages/opencode/test/server/`

第一批测试重点：

- 事件字段完整性
- busy reject 指标统计
- `runtime.turn.completed` 数据形状
- `runtime.tool.*` 或 tool part normalizer
- `runtime.resources.resolved` 与 `runtime.resource.failed` 聚合正确性

## 21. 第一版 dashboard 先展示什么

第一版不要追求面面俱到，建议只做 4 个卡片区域和 4 张核心表。

### 21.1 总览卡片

先展示：

- 总请求数
- 成功率
- Busy reject 次数 / 比例
- P95 接口耗时
- 总 token
- 总 cost
- 工具调用总数
- 资源失败总数

这些指标足够让团队快速判断“系统有没有跑稳”。

### 21.2 模型表现表

按 `provider/model` 展示：

- 请求数
- 平均首字延迟
- P95 总耗时
- 输入 token
- 输出 token
- 总 cost
- finish reason 分布

这张表优先级最高，因为它直接回应“响应速度多少、token 消耗多少”。

### 21.3 工具表现表

按 `tool` 展示：

- 调用次数
- 成功率
- 平均耗时
- P95 耗时
- 失败原因 TopN

如果第一版 `source` 已有，也可以顺手加一列：

- `builtin` / `mcp`

### 21.4 资源健康表

按 `resource_type + status` 展示：

- MCP unavailable 数
- MCP auth-required 数
- skill unavailable 数
- 失败阶段分布

这张表对后续 GitLab / MCP 扩展非常关键。

### 21.5 上下文与回合概览

第一版不需要做复杂可视化，先用简表展示：

- context event inserted 次数
- context event deduped 次数
- dropped blocks 次数
- 平均 turn duration

如果页面空间有限，这块可以先放到次级页。

## 22. 推荐实施顺序

为了减少返工，建议按下面顺序开工：

1. 在 `nine1bot-agent.ts` 上补接口层统计
2. 在 `runtime/controller/events.ts` 上补 turn completed / failed 的结构化字段
3. 确认是新增 `runtime.tool.*`，还是先做 tool part normalizer
4. 在 `runtime/resource/resolver.ts` 和 `runtime/context/pipeline.ts` 上补时序与 summary 字段
5. 新增 `runtime/metrics/` 聚合模块
6. 新增 `server/routes/metrics.ts`
7. 在 Web 里先做 Overview + Models + Tools + Resources 四块

第一批里建议先不做：

- 复杂的自定义时间窗口分析
- 通用查询 DSL
- 全量 timing trace 存储
- Trace/Metric/Log 三合一平台联动

先把“核心指标能稳定看见”做扎实，后面再扩。

## 23. 可以直接拆成 issue 的子任务

建议第一轮直接拆成这些任务：

- 任务 1：梳理并固化 Runtime Event -> 指标字段映射表
- 任务 2：为 `runtime.turn.completed` 补 token/cost/finishReason/latency 字段
- 任务 3：补 `runtime.tool.*` 事件或 tool normalizer
- 任务 4：为 `nine1bot-agent` 路由补接口层 metrics hook
- 任务 5：实现 metrics normalizer + aggregator
- 任务 6：新增 `/nine1bot/metrics/*` 查询接口
- 任务 7：实现第一版 dashboard 总览页
- 任务 8：补 controller/resource/server 层测试

这样拆完以后，代码实施会非常清晰：先把数据吐出来，再把数据聚起来，最后把数据展示出来。
## Implementation Update

- Controller API request metrics are already emitting `runtime.metrics.controller_api.completed`
- Runtime protocol has been extended with:
  - `runtime.turn.completed`
  - `runtime.turn.failed`
  - `runtime.tool.started`
  - `runtime.tool.completed`
  - `runtime.tool.failed`
- `session/processor.ts` is now the preferred emission point for model completion and tool lifecycle metrics
- Legacy projection from `session.idle` / `session.error` is retained only as a fallback path
