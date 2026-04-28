# Nine1Bot 打点方案实施计划

## 1. 文档目标

这份文档用于把 `metrics-instrumentation-plan.md` 中的方案，进一步拆成可执行的实施任务。

目标不是重复架构设计，而是明确：

- 每个子任务要解决什么问题
- 需要改哪些模块
- 预期产出是什么
- 验收标准是什么
- 建议的实施顺序是什么

默认实施分支：

- `feat/add-metrics-instrumentation`

## 2. 实施原则

本轮实施遵循以下原则：

1. 先打通主数据流，再补精细指标
2. 优先复用现有 `Controller API + Runtime Event + Debug/Audit`
3. 先保证指标可稳定聚合，再考虑更复杂的实时体验
4. 优先做接口层、模型层、工具层的核心指标
5. Timing trace 默认按采样或按需开启，不做全量重型方案

## 3. 总体排期建议

建议按三阶段推进：

### 阶段 A：把数据吐出来

- 任务 1：Runtime Event 到指标字段映射表
- 任务 2：补 `runtime.turn.completed` 的核心模型字段
- 任务 3：补 `runtime.tool.*` 事件或 tool normalizer
- 任务 4：给 `nine1bot-agent` 路由补接口层 metrics hook

### 阶段 B：把数据聚起来

- 任务 5：实现 metrics normalizer + aggregator
- 任务 6：新增 `/nine1bot/metrics/*` 查询接口

### 阶段 C：把数据展示出来

- 任务 7：实现第一版 dashboard 总览页
- 任务 8：补 controller/resource/server 层测试

说明：

- 如果你希望更稳，可以把任务 8 提前到任务 6 之后
- 如果你希望先看到页面，可以把任务 7 提前到任务 8 前

## 4. 子任务清单

## 任务 1：梳理并固化 Runtime Event -> 指标字段映射表

### 目标

明确每一种协议事件在指标系统里如何解释，避免后续代码边写边猜。

### 需要覆盖的事件

- `runtime.turn.started`
- `runtime.turn.completed`
- `runtime.turn.failed`
- `runtime.context.compiled`
- `runtime.resources.resolved`
- `runtime.resource.failed`
- `runtime.message.part.updated`
- 可能新增的 `runtime.tool.started/completed/failed`

### 涉及模块

- [protocol.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/runtime/controller/protocol.ts)
- [events.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/runtime/controller/events.ts)
- [metrics-instrumentation-plan.md](C:/Users/leg/IdeaProjects/nine1bot/docs/metrics-instrumentation-plan.md)
- 本文档

### 产出

- 一张事件到指标字段映射表
- 一份标准化字段字典
- 一份“哪些字段已存在 / 哪些字段缺失”的确认结果

### 当前建议映射表

| Runtime / API 事件 | 指标归类 | 当前可直接使用字段 | 当前主要缺口 |
| --- | --- | --- | --- |
| `POST /nine1bot/agent/sessions/:sessionID/messages` | 接口层 / 回合入口 | `status`, `accepted`, `busy`, `entry.source`, `entry.platform` | 缺统一聚合出口 |
| `runtime.turn.started` | 回合层 / 模型层起点 | `sessionID`, `turnSnapshotId`, `profileSnapshotId`, `agent`, `model.providerID`, `model.modelID` | 缺入口维度回填、缺 timing summary |
| `runtime.turn.completed` | 回合层 / 模型层完成态 | 当前协议已声明完成事件 | 缺 token、cost、finishReason、firstTokenLatency、duration |
| `runtime.turn.failed` | 回合层 / 模型层失败态 | `error` | 缺标准化 `errorType` |
| `runtime.context.compiled` | 上下文层 | `blockCount`, `renderedCount`, `droppedCount`, `tokenEstimate`, `audit`, `dropped` | 缺耗时字段 |
| `runtime.resources.resolved` | 资源层 | `declared`, `resolved`, `unavailable`, `failures` | 缺 `builtinTools`、缺 resolve duration |
| `runtime.resource.failed` | 资源层 | `resourceType`, `resourceID`, `status`, `stage`, `message`, `recoverable` | 基本可用，建议补 reason 归一化 |
| `runtime.message.part.updated`(tool) | 工具层过渡数据源 | `tool`, `callID`, `state.status`, `state.time` | 缺专用 tool runtime event |

### 验收标准

- 能明确回答每个核心指标来自哪条 event
- 能明确哪些指标还依赖旧内部结构推导
- 后续 normalizer 实现时不需要再补充口径讨论

### 建议动作

- 先在文档中固化映射表
- 再按映射表改代码

## 任务 2：为 `runtime.turn.completed` 补 token/cost/finishReason/latency 字段

### 目标

让模型层核心指标可以直接从 turn 完成事件中提取，而不是散落在旧 message/part 结构里做脆弱拼接。

### 期望新增字段

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
- `firstTokenLatencyMs`
- `durationMs`
- `completedAt`

### 涉及模块

- [events.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/runtime/controller/events.ts)
- [processor.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/session/processor.ts)
- [llm.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/session/llm.ts)

### 产出

- 增强版 `runtime.turn.completed`
- 模型层指标可直接由 runtime event 提取

### 验收标准

- 一次完整对话结束后，`runtime.turn.completed` 能带出 token/cost/finishReason
- 能计算首字延迟与总耗时
- 聚合层不再需要深入旧 assistant message 才能得到核心模型指标

### 风险提示

- 首字时间可能需要从 stream 生命周期里显式记录
- 如果一次 turn 内有多段输出，要明确首字时间口径

## 任务 3：补 `runtime.tool.*` 事件或 tool normalizer

### 目标

给工具层建立稳定、易消费的事件源。

### 两种可选方案

#### 方案 A：新增 runtime tool 事件

新增：

- `runtime.tool.started`
- `runtime.tool.completed`
- `runtime.tool.failed`

优点：

- 语义清晰
- 聚合层简单

缺点：

- 需要扩展协议事件清单

#### 方案 B：先做 tool normalizer

基于：

- `runtime.message.part.updated`

解析 tool part 状态流转，转成内部统一 metrics event。

优点：

- 改协议少

缺点：

- normalizer 更复杂
- 后续维护成本更高

### 建议

优先选方案 A。  
如果考虑短期改动最小，可以先做方案 B 过渡，但文档口径仍建议朝方案 A 靠齐。

### 涉及模块

- [protocol.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/runtime/controller/protocol.ts)
- [events.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/runtime/controller/events.ts)
- [processor.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/session/processor.ts)

### 期望字段

- `tool`
- `toolCallId`
- `source`
- `startedAt`
- `finishedAt`
- `durationMs`
- `result`
- `errorType`
- `errorMessage`

### 验收标准

- 一个工具调用完整生命周期能稳定落成一条 started 和一条 completed/failed
- 工具层统计不再依赖旧 part 结构临时推断

## 任务 4：为 `nine1bot-agent` 路由补接口层 metrics hook

### 目标

把 Controller API 变成接口层指标的统一采集点。

### 需要覆盖的接口

- `GET /nine1bot/runtime/capabilities`
- `POST /nine1bot/agent/templates/resolve`
- `POST /nine1bot/agent/sessions`
- `POST /nine1bot/agent/sessions/:sessionID/messages`
- `POST /nine1bot/agent/sessions/:sessionID/model`
- `POST /nine1bot/agent/interactions/:requestID/answer`
- `GET /nine1bot/agent/sessions/:sessionID/debug`
- `GET /nine1bot/agent/sessions/:sessionID/events`

### 涉及模块

- [nine1bot-agent.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/server/routes/nine1bot-agent.ts)

### 建议采集字段

- `route`
- `method`
- `status`
- `durationMs`
- `entry.source`
- `entry.platform`
- `traceId`
- `busy`

### 产出

- Controller API 请求事件
- Busy reject 统计
- 接口层耗时与成功率统计

### 验收标准

- 每个控制器接口都有统一统计
- busy reject 会被单独记录
- 接口层 Overview 可依赖这些数据独立成表

## 任务 5：实现 metrics normalizer + aggregator

### 目标

建立统一聚合层，把 API 事件和 Runtime Event 转成可查询的指标结果。

### 建议新增目录

- `opencode/packages/opencode/src/runtime/metrics/`

### 建议文件

- `types.ts`
- `normalizer.ts`
- `aggregator.ts`
- `queries.ts`

### 模块职责

#### `types.ts`

- 定义统一 metrics event
- 定义 overview / model / tool / resource 查询结果类型

#### `normalizer.ts`

- 输入：Controller API 事件、Runtime Event
- 输出：统一 metrics event

#### `aggregator.ts`

- 负责：
  - counter
  - duration
  - rate
  - P95/P99
  - 分组聚合

#### `queries.ts`

- 负责按 dashboard 需要返回固定查询结果

### 验收标准

- 能接收接口层和 runtime 事件
- 能产出 overview / models / tools / resources 四类结果
- 计算逻辑与原始事件解耦

## 任务 6：新增 `/nine1bot/metrics/*` 查询接口

### 目标

给 Web 第一版 dashboard 提供固定查询接口。

### 建议新增接口

- `GET /nine1bot/metrics/overview`
- `GET /nine1bot/metrics/models`
- `GET /nine1bot/metrics/tools`
- `GET /nine1bot/metrics/resources`

### 可选查询参数

- `window`
  - 例如 `1h` / `24h` / `7d`
- `platform`
- `entrySource`

第一版可以不做复杂筛选，先保留简单时间窗口。

### 涉及模块

- 建议新增 [metrics.ts](C:/Users/leg/IdeaProjects/nine1bot/opencode/packages/opencode/src/server/routes/metrics.ts)
- 同时需要在 server 总路由里注册

### 验收标准

- Web 不需要直接消费底层 runtime event，就能拿到聚合结果
- 接口返回结构稳定，适合后续扩展

## 任务 7：实现第一版 dashboard 总览页

### 目标

先让团队能直观看到打点结果，验证方案是否有价值。

### 第一版建议展示区域

#### A. Overview

- 总请求数
- 成功率
- Busy reject 比例
- P95 接口耗时
- 总 token
- 总 cost
- 工具调用总数
- 资源失败总数

#### B. Models

- 按 `provider/model` 展示：
  - 请求数
  - 平均首字延迟
  - P95 总耗时
  - token
  - cost
  - finish reason

#### C. Tools

- 按 `tool` 展示：
  - 调用次数
  - 成功率
  - 平均耗时
  - P95
  - 失败原因

#### D. Resources

- MCP / skill 状态分布
- auth-required / unavailable 次数
- 失败阶段分布

### 涉及模块

- `web/src/`
- 现有 API client
- 新增 metrics query 调用

### 验收标准

- 第一版页面能覆盖用户最关心的 3 类问题：
  - 响应速度
  - token/cost
  - 工具与资源稳定性

## 任务 8：补 controller/resource/server 层测试

### 目标

给第一版打点链路补最小护栏，避免后续重构把指标字段打断。

### 建议优先补的测试

#### A. Controller 层

目录：

- `opencode/packages/opencode/test/controller/`

重点：

- `runtime.turn.started` / `runtime.turn.completed` 结构
- API 响应中 `turnSnapshotId` / `profileSnapshotId`

#### B. Resource 层

目录：

- `opencode/packages/opencode/test/resource/`

重点：

- `runtime.resources.resolved`
- `runtime.resource.failed`
- 状态字段与 reason 字段稳定性

#### C. Server 层

目录：

- `opencode/packages/opencode/test/server/`

重点：

- 接口层 metrics hook
- busy reject 统计
- `/nine1bot/metrics/*` 查询结果

### 验收标准

- 核心事件字段有测试覆盖
- 基础查询接口有测试覆盖
- busy reject、resource failed、turn completed 三条高价值链路有护栏

## 5. 推荐开工顺序

推荐按下面顺序直接动工：

1. 任务 1：先把事件映射表和字段字典定下来
2. 任务 4：先给 Controller API 补接口层 metrics hook
3. 任务 2：补 `runtime.turn.completed` 模型字段
4. 任务 3：补 `runtime.tool.*` 或 tool normalizer
5. 任务 5：实现 metrics normalizer + aggregator
6. 任务 6：补 metrics 查询接口
7. 任务 8：补测试
8. 任务 7：做第一版 dashboard

如果你更希望“尽快看到页面”，也可以把任务 7 前置到任务 8 前，但建议至少先把 Overview 和 Models 两块的数据链路稳定下来。

## 6. 第一批建议不做的内容

为了让第一版范围可控，建议先不做：

- 通用查询 DSL
- 全量 timing trace 存储
- 复杂筛选器和多维钻取
- 完整 Trace/Metric/Log 联动
- 多入口差异化大屏
- 高级告警系统

第一版只需要做到：

- 关键事件有
- 关键字段全
- 核心指标能聚
- 页面能看

这样后面就可以边用边迭代。

## 7. 开工前检查项

准备动工前建议先确认：

- `runtime.turn.completed` 的字段扩展是否接受
- `runtime.tool.*` 是新增协议事件，还是先做 normalizer 过渡
- metrics 聚合层放在 runtime 目录下是否符合当前模块边界
- dashboard 是放进现有页面体系，还是先做一个独立视图
- timing trace 是否默认关闭，仅在 debug/采样下启用

如果以上这几个点没有分歧，就可以按本计划直接开始做第一批代码改造。
## 0. Current Status

- Task 1: in progress
  - event-to-metric mapping table has been added
- Task 2: in progress
  - direct `runtime.turn.completed` / `runtime.turn.failed` events have been added to the runtime protocol path
- Task 3: in progress
  - direct `runtime.tool.started` / `runtime.tool.completed` / `runtime.tool.failed` events have been added
- Task 4: completed for phase 1
  - Controller API metrics hook is already wired in `nine1bot-agent.ts`

## 0.1 Current Decision

- Tool metrics now use direct runtime events instead of only relying on `runtime.message.part.updated` normalization
- Turn-complete metrics now prefer direct runtime events emitted by `session/processor.ts`
- Legacy `session.idle` / `session.error` projection remains as a compatibility fallback, but it is no longer the preferred source for metrics
