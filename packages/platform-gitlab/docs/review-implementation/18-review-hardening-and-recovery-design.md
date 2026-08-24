# GitLab Review 安全加固与可恢复执行设计

## 1. 文档状态

- 状态：已实现并完成自动化验证，等待真实 GitLab 联调验收
- 日期：2026-08-10
- 目标分支：`feat/gitlab-review-workflow`
- 适用范围：`platform-gitlab`、`nine1bot` Review controller、OpenCode 自动化运行时、Web GitLab 配置页
- 前置设计：`16-runtime-ci-on-demand-tool-design.md`

## 2. 背景与产品边界

本轮改进不是扩展一个通用 GitLab 客户端，而是收紧自动化 Review 的安全边界、CI 归属规则和失败恢复规则。MCP 仍不在范围内，模型仍不得直接使用 GitLab CLI、`curl`、`webfetch` 或任意网络工具访问 GitLab。

这里的“产品边界”表示产品明确承诺支持的行为范围，而不是某一行代码是否能够实现。本轮确定以下两项边界：

1. CI 支持 source pipeline、detached merge request pipeline、merged-results pipeline 和 merge-train pipeline，但必须证明流水线属于当前 MR 且包含当前 MR 的 source HEAD。
2. 找不到可信 CI、CI API 不可用或日志不可读时，Review 继续执行，只记录稳定诊断；禁止退化为“取项目最新流水线”。
3. 因项目配置缺失、禁用、未绑定或配置冲突而拒绝的 run，可以在配置修复后显式重试。
4. 重试创建新的 attempt。原拒绝 run 保持终态，不覆盖错误、时间和审计记录。

## 3. 已确认问题

| 编号 | 级别 | 问题 | 设计结论 |
| --- | --- | --- | --- |
| R1 | P1 | GitLab API 请求自动跟随跨 authority 重定向，可能转发 `PRIVATE-TOKEN` | 手动处理重定向，仅允许同 authority，限制跳转次数 |
| R2 | P1 | 自动 Review 的 `tools` 只是权限补丁，不是工具白名单 | 自动化 session 使用显式 deny-by-default 工具选择策略 |
| R3 | P1 | pipeline/job API 原始对象和数量可无界进入模型上下文 | 运行时投影字段，设置数量与序列化字节硬上限 |
| R4 | P1 | CI 日志脱敏无法覆盖带空格值、凭据 URL、密钥块等常见秘密 | 分层脱敏并保留严格日志字节上限 |
| R5 | P2 | CI 请求完成后可能写入已经结束或已经重试的 run | signal 贯穿请求，并以 attempt/session generation 条件更新 |
| R6 | P2 | diff 中源码行以 `+++` 或 `---` 开头时行号映射错误 | 在 hunk 状态内按首字符判断增删行 |
| R7 | P2 | runtime monitor 在首消息发送后才订阅，可能漏掉快速完成事件 | 先订阅 monitor，再发送消息；发送失败时清理订阅 |
| R8 | P2 | 前后端 profile parser 静默丢弃非法或重复配置，可能误报健康并破坏保存数据 | 解析与校验分离，保留原始条目并阻止有损保存 |

## 4. 总体架构

```mermaid
flowchart LR
  A["GitLab webhook / 显式 retry"] --> B["Review trigger resolver"]
  B --> C["Review attempt store"]
  C --> D["Context pipeline"]
  D --> E["OpenCode automated session"]
  E --> F["受限 gitlab_ci_inspect"]
  F --> G["CI candidate verifier"]
  G --> H["GitLab REST API v4"]
  E --> I["Review publisher"]

  C -. "retryOf / rootRunId" .-> C
  G -. "无可信 CI 时仅返回诊断" .-> E
```

职责保持分层：

- `platform-gitlab`：GitLab REST 请求、响应投影、CI 候选可信校验、日志脱敏、diff 解析和配置结构校验。
- `nine1bot`：run/attempt 生命周期、项目配置和 secret 解析、session 绑定、CI 查询审计与重试恢复。
- OpenCode：自动化 session 建立、工具可见性和权限白名单、monitor 生命周期、tool 输出持久化边界。
- Web：无损编辑 profile，展示逐条校验错误，错误存在时阻止保存。

## 5. GitLab API 请求安全

### 5.1 重定向规则

所有携带 `PRIVATE-TOKEN` 的请求使用 `redirect: "manual"`。客户端最多处理 3 次重定向，并对每个 `Location` 执行以下校验：

1. 相对 URL 以当前 URL 为基准解析。
2. 目标协议只能是 `http:` 或 `https:`。
3. 目标 authority 经标准化后必须与客户端初始 authority 完全相同，包括显式端口。
4. 跨 authority、非法 URL、缺失 `Location` 或超出次数时立即失败，不向目标发送请求。

允许同一 GitLab 实例内部的相对路径和同 authority 绝对跳转。错误通过稳定诊断暴露，不返回 token、原始响应正文或完整 `Location` 查询参数。

### 5.2 Abort 传播

`GitLabApiClient` 的所有读取方法接受可选 `AbortSignal`，并传给每一次 fetch 和手动重定向请求。tool 的 `Tool.Context.abort` 必须贯穿到 `nine1bot` inspector、`platform-gitlab` inspector 和 API client。

## 6. CI 可信归属与选择

### 6.1 官方 API 依据

设计使用 GitLab 官方接口和字段：

- MR 流水线列表：`GET /projects/:id/merge_requests/:merge_request_iid/pipelines`
- MR 详情与当前 head pipeline：`GET /projects/:id/merge_requests/:merge_request_iid` 的 `diff_refs.head_sha` 和 `head_pipeline`
- 流水线详情：`GET /projects/:id/pipelines/:pipeline_id`
- 临时提交父节点：`GET /projects/:id/repository/commits/:sha` 的 `parent_ids`

官方文档说明 MR pipelines API 返回属于指定 MR 的流水线；merged-results pipeline 测试 source 与 target 组成的临时合并提交；merge train 使用 merged-results pipelines。参考：

- <https://docs.gitlab.com/api/merge_requests/#list-merge-request-pipelines>
- <https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/>
- <https://docs.gitlab.com/ci/pipelines/merge_trains/>
- <https://docs.gitlab.com/api/commits/>

### 6.2 候选集合

候选只能来自指定 MR 的 pipelines endpoint 和同一次 MR 详情响应中的 `head_pipeline`，两者按 pipeline ID 去重。禁止从项目 pipelines endpoint 选择“最新”记录。候选还必须满足：

- `source === "merge_request_event"`，或者是 SHA 等于当前 source HEAD 的 source/branch pipeline；
- 项目 ID、MR IID 和 host 均来自冻结的 ReviewRun target；
- pipeline ID、SHA、ref 和 status 均通过运行时结构校验。

### 6.3 可信关联规则

候选按以下顺序验证和分类：

1. `source`/detached：`pipeline.sha === currentHeadSha`，可直接证明属于当前源码版本。
2. merged-results：候选来自当前 MR endpoint，`source === "merge_request_event"`，ref 属于当前 MR ref，且临时提交 `parent_ids` 包含 `currentHeadSha`。
3. merge-train：候选来自当前 MR endpoint，`source === "merge_request_event"`，并且临时提交的父提交关系可证明包含 `currentHeadSha`。ref 或版本相关的事件类型字段只用于分类，不单独作为信任依据。

如果 self-managed GitLab 版本没有返回足够字段，或者临时提交已经不可读取，则候选不可信。系统返回 `ci_pipeline_unverified_for_current_head`，不会选择较旧或仅时间更新较晚的 pipeline。

“可信”与“分类”必须解耦。部分 self-managed GitLab 版本不能稳定区分 merged-results 和 merge-train；此时只要 MR 归属与父提交关系通过，仍可作为 `integrated` pipeline 使用，但不得猜测具体子类型。`kind` 使用 `source`、`detached`、`merged_result`、`merge_train` 或 `integrated`，`verification` 记录实际通过的校验。

在多个可信候选同时存在时，优先选择已验证的 integrated/merge-train/merged-results pipeline，再选择 detached/source pipeline；同层选择 pipeline ID 最大的记录。返回结果增加 `kind` 和 `verification`，便于模型理解证据来源，但不暴露原始 API 对象。

### 6.4 非阻断诊断

以下情况均不阻断 Review 发布：

- `ci_pipeline_not_found_for_current_mr`
- `ci_pipeline_unverified_for_current_head`
- `ci_pipeline_metadata_unavailable:<ErrorName>`
- `ci_jobs_unavailable:<ErrorName>`
- `ci_job_log_unavailable:<jobId>:<ErrorName>`
- `ci_request_aborted`

诊断进入 run 的有界审计摘要和 tool 返回值，不进入 GitLab 评论中的 finding 证据，除非最终 Review 摘要明确需要说明 CI 未检查。

## 7. CI 输出与日志边界

### 7.1 DTO 投影

运行时只允许以下 pipeline 字段：

- `id`、`iid`、`projectId`、`status`、`source`、`sha`、`ref`、`webUrl`、`createdAt`、`updatedAt`
- 派生字段 `kind`、`verification`

运行时只允许以下 job 字段：

- `id`、`name`、`stage`、`status`、`allowFailure`、`webUrl`、`startedAt`、`finishedAt`、`duration`

`user`、`runner`、`commit`、variables、token、原始错误正文和其他服务端扩展字段全部丢弃。

### 7.2 硬上限

配置值只能在服务端硬上限内收紧，不能放大：

- pipeline 候选最多读取 50 条；
- tool list 最多返回 100 个 job；
- list 序列化后最多 32 KiB；
- 每个 run 最多读取 10 份 job log，默认 3 份；
- 单份日志最多 16 KiB，默认 8 KiB；
- 诊断最多 20 条，每条最多 256 字符。

超过 job 数量或字节上限时，按稳定顺序截断，并返回 `ci_jobs_truncated`、原始计数、返回计数和 `truncated: true`。tool 自己完成截断，OpenCode 不得把未截断副本写入 session 文件。

### 7.3 日志脱敏

日志处理顺序固定为：ANSI 清理、结构化秘密识别、UTF-8 字节截断。至少覆盖：

- `TOKEN`、`PASSWORD`、`SECRET`、`API_KEY`、`ACCESS_KEY` 等环境变量赋值，包括引号和带空格值；
- `Authorization`、Bearer、Basic 和常见私有 token；
- `scheme://user:password@host` 形式的凭据 URL；
- PEM/private key 块；
- JWT-like 三段 token；
- 常见云访问密钥格式。

脱敏是纵深防护，不承诺识别任意秘密，因此日志始终按需读取并受硬字节上限约束。

## 8. 自动化工具白名单

### 8.1 工具选择语义

OpenCode 为自动化 session 增加显式工具选择规则：

- `"*": false` 表示默认不可见且不可执行；
- 精确的 `toolName: true` 才允许加入模型工具表；
- false 工具不仅权限为 deny，也不进入模型上下文；
- 未配置 `"*": false` 的普通对话保持现有兼容行为。

GitLab MR PM session 只暴露：

- `gitlab_ci_inspect`
- 受限 `task`，且只能调用已冻结的 GitLab review specialist agents

GitLab commit Review 不暴露 CI tool。specialist agent 默认不拥有本地文件、shell、网络、MCP、terminal、发送文件、写入或其他工具。它们只消费由 context pipeline 冻结的证据。权限层继续保留 deny-by-default，形成“不可见 + 不可执行”两层约束。

### 8.2 非 Review session

普通对话、其他 webhook 和未绑定 ReviewRun 的 session 不应看到 `gitlab_ci_inspect`。即使绕过模型直接调用 wrapper，仍必须因 session/run 未绑定而 fail closed。

## 9. Review attempt 与显式恢复

### 9.1 数据模型

ReviewRun 增加以下字段：

- `rootRunId`：一组 attempts 的首个 run ID；首个 run 创建后等于自身 ID。
- `attempt`：从 1 开始递增。
- `retryOf`：直接前一 attempt 的 run ID。
- `triggerKey`：同一 GitLab 事件/源码版本的稳定分组键。
- `generation`：绑定异步写入的不可复用代号。
- `rejectionKind`：`configuration`、`authentication`、`payload` 或 `policy`。
- `recoverable`：是否允许显式 retry。

保留 `idempotencyKey` 作为每个 attempt 的唯一键。首个 attempt 使用当前事件键，后续 attempt 使用稳定派生键。store 提供按 `triggerKey` 获取最新 attempt 和条件更新 API。

### 9.2 可恢复范围

仅以下配置型拒绝允许显式重试：

- `project_profile_missing`
- `project_profile_disabled`
- `project_binding_missing`
- `project_profile_identity_duplicate`
- 平台已启用但当前没有可用 project profile

Webhook secret 无效、payload 非法、事件不受支持和策略拒绝不能通过 run retry 绕过。它们必须由新的合法 webhook 重新进入系统。

### 9.3 Retry 流程

`POST /gitlab/runs/:runId/retry` 对配置型拒绝执行：

1. 读取原 run 的冻结 trigger identity，不复用原 project snapshot 或 context。
2. 重新读取当前平台配置和 secret，并重新解析 project profile。
3. 配置仍无效时不创建新 attempt，返回稳定诊断。
4. 配置有效时创建 attempt N+1，设置 `retryOf`、`rootRunId` 和新 `generation`。
5. 重新从 GitLab 获取 MR changes，重新构建 context，再启动新的 session。
6. 原 run 保持 `rejected`，新 run 独立进入 accepted/running/terminal 状态。

普通 runtime 失败也统一使用新 attempt，不再原地清空和复用 session 字段。已发布 run、正在运行的最新 attempt 和重复 retry 请求返回 409。幂等锁以 `triggerKey + latestAttempt` 条件创建，避免并发生成两个 attempt。

## 10. 生命周期与竞态控制

### 10.1 CI 查询条件更新

开始查询前必须同时验证：

- run 存在且状态为 `running`；
- run 的 `sessionId` 等于 tool context session；
- run 的 `generation` 等于查询开始时捕获值；
-当前 run 是该 `rootRunId` 的最新活动 attempt。

每个 await 返回后再次执行同样条件。条件失效时丢弃结果并返回 `ci_review_attempt_stale`，不得更新新 attempt 的 CI 摘要或消耗其日志额度。abort 映射为 `ci_request_aborted`，不记录原始异常正文。

日志额度采用条件 reserve。失败或 stale 请求是否归还额度必须保持确定：在真正开始读取 trace 前失败则归还，已经发出 trace 请求则保留审计计数。

### 10.2 Monitor 时序

自动化运行流程调整为：创建 session、执行 `onSessionCreated`、订阅 monitor、发送首消息。monitor 返回显式 dispose handle；首消息未接受、发送抛错或初始化失败时立即 dispose，并只触发一次 `onFinished`。完成事件、超时和初始化失败通过单一幂等 `finish()` 收口。

## 11. Diff 行号映射

解析器维护 `outside-hunk` 与 `inside-hunk` 状态：

- 仅在 `outside-hunk` 识别 `+++ ` 和 `--- ` 文件头；
- 进入 `@@ ... @@` 后，任何首字符为 `+` 的行都是新增，首字符为 `-` 的行都是删除；
- 因此源码 `++counter` 对应 diff 行 `+++counter`，源码 `--value` 对应 diff 行 `---value`，不会误判为文件头；
- `\ No newline at end of file` 不推进任一侧行号。

## 12. Profile 无损配置

### 12.1 后端

配置解析返回 `value + diagnostics`，不再静默删除条目。验证覆盖：JSON 非数组、非对象条目、缺失 ID/projectId、非法 host、重复 profile ID、重复 host/project identity、非法数值上限和缺少 Nine1Bot 项目绑定。

GitLab Review 启用时至少需要一个满足以下条件的 profile，健康状态才为 configured：

- profile 自身启用；
- host/project identity 唯一且有效；
- `nine1botProjectID` 已绑定；
- 上下文和 CI 数值配置通过上限校验。

否则配置状态为 degraded/unconfigured，并列出可定位到 profile index/id 的错误。

### 12.2 前端

编辑器保存“用户当前看到的完整条目集合”。parser 不再通过 dedupe 改写数组；所有重复和非法记录作为逐条错误展示。存在错误时禁用保存，不序列化缩水后的数组覆盖原配置。用户修复后才输出 canonical JSON。

## 13. 错误与公开数据边界

- 所有公开错误使用稳定 code，不包含 token、header、原始 GitLab 响应正文、内部文件路径或堆栈。
- `ReviewRun` 只持久化冻结 target、profile snapshot、CI 投影摘要、diagnostics 和 attempt 关系。
- tool 输出不包含 token、API base URL 中的 userinfo、原始 pipeline/job 对象或未截断日志。
- Review finding 必须以冻结 diff 为代码证据；CI 只能补充风险和验证状态。
- CI 故障不改变 Review 是否允许发布，Review 主链路故障仍按现有失败发布规则处理。

## 14. 测试策略

### 14.1 Platform GitLab

- 两台本地 HTTP server 验证跨 authority 跳转不发送 token，同 authority 跳转继续工作，循环和超限失败。
- API JSON 注入额外 `runner/user/commit/variables` 字段，验证 DTO 完全丢弃。
- source、detached、merged-results、merge-train、旧 SHA、伪造 ref、缺少 parent metadata 的候选表驱动测试。
- 101+ jobs、超 32 KiB list、超大配置值的硬上限和截断诊断。
- 带空格密码、凭据 URL、JWT、PEM、AWS-like key 和 ANSI 日志脱敏。
- `+++counter`、`---value` 及后续行号映射回归。

### 14.2 Nine1Bot

- terminal run 禁止 CI 查询，abort 后无持久化写入。
- deferred fetch 期间触发 retry，旧 generation 不得覆盖新 attempt。
- 配置拒绝修复后产生新 run，原 run 不变，attempt 链正确。
- 配置仍错误、并发 retry、已发布/活动 attempt 的稳定响应。
- run store 旧版本记录加载兼容与新字段持久化。

### 14.3 OpenCode

- 使用实际 ToolRegistry 验证自动 Review PM 只看到 allowlist 工具，普通 session 看不到 GitLab CI tool。
- specialist agent 无本地文件、shell、网络、MCP 和 terminal 工具。
- 发送首消息期间立即发布 `session.idle`，monitor 仍能完成且只完成一次。
- 发送失败和未接受路径都释放订阅和 timeout。

### 14.4 Web

- malformed、duplicate ID、duplicate identity、空数组和非数组配置均保留原始编辑内容并阻止保存。
- 合法配置 parse/edit/serialize/reload 无损 round trip。
- GitLab Review 已启用但无可用 profile 时显示可操作的 degraded 状态。

### 14.5 全量验收

- `bun run ci:test`
- `bun run ci:typecheck`
- OpenCode package typecheck
- `bun run build:web`
- `git diff --check`
- 本地模拟 GitLab webhook、显式 retry 和按需 CI 查询
- 隔离测试项目执行一次真实 source/MR pipeline 联调；环境支持时补充 merged-results 或 merge-train 联调

## 15. 实施批次建议

| Batch | 内容 | 退出条件 |
| --- | --- | --- |
| 1 | R1、R3、R4：API、DTO、输出和日志安全边界 | 安全回归通过，任何配置不能突破硬上限 |
| 2 | R2 工具白名单与 R7 monitor | 实际工具表和事件时序测试通过 |
| 3 | R6 diff 修复 | 极端源码前缀与后续行号正确 |
| 4 | R8 profile 无损校验 | 前后端不再静默丢配置，错误阻止保存 |
| 5 | 新 attempt 数据模型与配置拒绝恢复 | 原 run 不变，重试产生可审计新 attempt |
| 6 | CI 可信选择与 R5 生命周期 | 四类 pipeline 单测覆盖，stale attempt 无写入 |
| 7 | 全量验证、文档同步和真实 GitLab 联调 | 本地 CI 全绿，联调证据和剩余限制已记录 |

## 16. 非目标

- 不建设 MCP server。
- 不允许模型裸跑 GitLab CLI 或任意网络工具。
- 不自动触发、重跑、取消或修改 GitLab pipeline/job。
- 不下载 artifacts，不自动读取全部日志。
- 不把 CI 失败当作 Review 发布阻断条件。
- 不支持无法由 MR 归属接口和当前源码关系证明可信的 pipeline。
- 不在本轮引入数据库；继续使用现有 ReviewRun 文件存储，并保持向后兼容。

## 17. 完成定义

以下条件全部满足后，本轮设计才算实现完成：

1. 八项 review 问题均有失败测试、最小修复和回归测试。
2. source、merged-results 和 merge-train CI 均只能在可信关联成功后进入 tool 上下文。
3. CI 不可用时 Review 仍能发布，并留下稳定诊断。
4. 配置型拒绝可显式恢复，原 run 不覆盖，新 attempt 可追踪。
5. 自动 Review 工具表真正 deny-by-default，普通 session 不暴露专用 CI tool。
6. profile 编辑和保存不会因 parser 静默过滤而丢失用户配置。
7. 全量测试、类型检查、Web 构建和 diff 检查通过，真实联调结果已记录。

## 18. 实施结果与设计差异

截至 2026-08-10，本设计对应实现已完成，自动化测试、类型检查和 Web 构建均通过。真实隔离 GitLab 的 source、merged-results/merge-train 与配置修复后 retry 尚需按 [14-live-integration-test-checklist.md](./14-live-integration-test-checklist.md) 执行，因此当前状态不是“已完成生产验收”。

实现与原设计保持一致，仅有以下落地细节需要固定：

1. `packages/platform-gitlab/src/index.ts` 原有通配导出已经覆盖新增 API 和类型，不需要额外修改入口文件。
2. pipeline 候选硬上限直接落实到 MR pipelines 网络请求的 `per_page=50`，不是在无界响应进入内存后再切片。
3. merged-result、merge-train 和通用 integrated 的可信性由“候选来自当前 MR + `source=merge_request_event` + 临时提交父节点包含冻结 source HEAD”共同证明；ref 只参与分类，不能单独建立信任。
4. 同时存在可信候选时，优先使用已验证 integrated 类 pipeline，再按 pipeline ID 取最新；找不到可信候选时不请求项目级 latest pipeline。
5. CI 查询绑定 `{ runId, sessionId, generation }`，每个 GitLab await 前后都重新校验。trace 请求发出前失效不消耗额度，发出后失效保留旧 attempt 的审计计数，但不写入任何 attempt 的 pipeline 结果。
6. 根测试套件在默认 5 秒单测超时下，少数原有高开销测试可能因机器负载超时；使用 `--timeout 30000` 完整运行后为 459 通过、0 失败。这是测试运行时限说明，不是功能降级。
7. 最终分支 review 进一步收紧了运行时边界：权限 deny 会在内置/MCP 工具进入模型上下文前生效；GitLab base URL 拒绝 userinfo 与非 HTTP(S) 协议；公开 CI 摘要保留 `kind/verification`；终态 run 不会被迟到的 controller response 改回 running；同一失败 webhook 的回放保持幂等，不另起 attempt 根链；runtime 异常只持久化稳定阶段错误码。

本轮提交与自动化证据详见 [19-review-hardening-and-recovery-implementation-plan.md](./19-review-hardening-and-recovery-implementation-plan.md)。
