# GitLab Review 项目归属、CI/CD 与上下文管线实施计划

> 本文记录 2026-08-06 确认的改进方案，并在 2026-08-09 根据 PR review 修正项目领域边界。2026-08-10 的 Batch 7 已将 CI 从 controller 预取改为运行时按需工具；本文保留早期批次的演进记录，并以 Batch 7 的边界作为当前实现。

## 目标

将 GitLab Review 从“按一次 webhook 创建的通用审查任务”升级为“隶属于明确 GitLab 项目的审查任务”。以 `root/uftest` 为第一个项目档案：该仓库的说明、架构知识、审查重点和上下文预算只用于该仓库触发的 review。

同时，将 GitLab CI/CD 作为可选的审查证据接入：MR Runtime 可先查询当前 HEAD pipeline 和全部状态的 job，再按需读取受限日志；不存在、尚未完成、无权限读取或 API 失败时记录降级状态，但不得阻断 review 创建、运行、发布或重试。

## 已确认决策

- Nine1Bot `Project` 是项目身份、工作目录和通用项目上下文的唯一主实体；GitLab 项目档案不得复制出第二套项目模型。
- GitLab 项目档案采用“GitLab 仓库映射 + Nine1Bot Project 绑定 + review 专属策略”，其中 Markdown 仅作为 review overlay，通用项目说明继续由 `Project.instructions` 管理。
- 配置了 GitLab 项目档案却没有有效 Nine1Bot Project 绑定时必须 fail closed，不得静默回退到 `NINE1BOT_PROJECT_DIR` 或 `process.cwd()`。
- 每个 `ReviewRun` 必须固化项目身份和项目配置快照，历史 run 不因后续编辑项目配置而改变归属或证据。
- CI/CD 仅是增强上下文，第一版不作为 review 发布门禁，也不触发、重跑、取消或修改 GitLab pipeline。
- 不让模型直接执行 GitLab CLI、`curl` 或任意 API；CI 只能通过 `gitlab_ci_inspect` wrapper tool 读取，host、项目、MR、token 和请求路径均由服务端绑定。
- 长上下文采用“冻结 diff、分层、受预算控制的 context packet + CI 渐进加载”，借鉴 `best-copilot` 的 bounded packet 与渐进加载原则，但不引入其多代理运行时和仓库记忆文件模型。[参考仓库](https://github.com/funky-eyes/best-copilot)

## 立项时差距

| 领域 | 当前状态 | 本轮补齐 |
| --- | --- | --- |
| 项目归属 | webhook trigger 含 `projectId/projectPath`，`ReviewRun` 未有稳定项目实体 | 新增项目档案匹配、配置快照和对外展示字段 |
| 项目知识 | 仅有全局 scope 和 review 参数 | 项目专属 Markdown 说明、审查重点、路径规则与预算 |
| CI/CD | 立项时未调用 pipeline/job API | Runtime 查询 MR HEAD pipeline，并按需读取任意状态 job 的受限日志 |
| 长 diff | `maxFiles/maxDiffBytes` 后按文件整体取舍 | 文件优先级、hunk 切片、摘要和裁剪清单 |
| 上下文边界 | trigger 和 diff manifest 为固定 context blocks | 冻结项目 overlay、manifest 与 diff slices；CI 不进入初始 packet |
| Web 管理 | GitLab 设置偏全局 | 项目档案列表、编辑、校验和 run 项目筛选/展示 |

## 目标架构

```text
GitLab webhook / @Nine1bot
  -> event-parser 解析 GitLabReviewTrigger
  -> GitLabProjectProfileResolver 按 host + projectId 匹配项目档案
  -> project profile 提供 opaque nine1botProjectID
  -> controller/server 边界解析 Nine1Bot Project
  -> ReviewRun 创建并持久化 GitLab identity + project binding snapshot
  -> GitLabApiClient 读取 MR diff
  -> ReviewContextPacketBuilder 受预算组装：review overlay -> diff manifest -> diff slices
  -> Runtime session 与 ReviewRun 绑定后执行既有 GitLab review workflow
  -> bot 通过 gitlab_ci_inspect 按需读取当前 HEAD pipeline/job 与受限日志
  -> ReviewRun 和 GitLab 回写都保留项目归属与证据摘要
```

上下文包固定为四层，优先级从高到低如下：

1. **项目层**：Nine1Bot Project 通过既有 context pipeline 注入通用 instructions、环境变量键和 shared files；GitLab profile 只补充 review overlay、审查重点、路径规则和项目级预算。
2. **CI 层**：MR HEAD SHA 对应 pipeline 摘要；仅包括状态、web URL、失败/取消 job 的名称、阶段、失败原因和脱敏截断日志。
3. **变更清单层**：全部变更文件、过滤原因、切片与裁剪统计。
4. **Diff 证据层**：按排序后的文件和 hunk 生成的可审查片段，带文件路径、old/new line 范围和被省略标记。

模型提示只能依据实际提供的 diff slice 形成代码 finding；CI 日志只作为运行症状和验证线索，不能替代代码证据。冻结 packet 通过 `contextBudgetBytes`、diff stats 和 skipped/omissions 暴露预算与降级结果；CI 查询状态由 ReviewRun 安全摘要另行记录。当前实现不宣称提供逐层字节审计。

## 数据模型与配置

### 项目档案

在 `GitLabReviewSettings` 下新增 `review.projects`，项目的唯一匹配键为 `(host, projectId)`；`pathWithNamespace` 只用于显示、人工校验和项目搜索，不作为唯一键。

```ts
type GitLabReviewProjectProfile = {
  id: string
  host?: string
  projectId: string | number
  nine1botProjectID: string
  pathWithNamespace?: string
  displayName?: string
  enabled: boolean
  reviewContextMarkdown?: string
  reviewFocus?: string[]
  includePathPrefixes?: string[]
  excludePathPatterns?: string[]
  maxContextBytes?: number
  maxFiles?: number
  ci: {
    maxJobLogs: number
    maxJobLogBytes: number
  }
}

type GitLabReviewProjectSnapshot = Omit<GitLabReviewProjectProfile, 'reviewContextMarkdown'> & {
  reviewContextMarkdown?: string
  matchedAt: number
}
```

规则：`(host, projectId)` 是唯一仓库身份，同一身份存在多个档案时配置无效并 fail closed。非 dry-run 审查必须匹配已启用且包含 `nine1botProjectID` 的档案；未建档项目返回 `project_profile_missing`，未绑定项目返回 `project_binding_missing`。如果绑定的 Nine1Bot Project 已删除或不可读，Runtime 启动失败并记录同一错误，不得使用进程默认目录。历史 `contextMarkdown` 在读取时迁移为 `reviewContextMarkdown`，但不再承担通用项目说明职责。

`ReviewRunRecord` 新增 `project?: GitLabReviewProjectSnapshot`、`contextDiagnostics?: GitLabReviewContextDiagnostics` 和 `ci?: GitLabPipelineSummary`。其中 project snapshot 固化 GitLab identity 与 `nine1botProjectID`，但 Runtime 每次启动仍须验证绑定 Project 存在。webhook 路由的 public DTO 仅暴露安全字段，不能返回完整 review overlay、原始 job trace、token、项目本地路径或 GitLab API 错误正文。

## CI/CD 证据策略

`GitLabApiClient` 新增只读方法：

```ts
getMergeRequestPipelines(projectId, mrIid): Promise<GitLabPipelineSummary[]>
getPipelineJobs(projectId, pipelineId): Promise<GitLabPipelineJob[]>
getJobTrace(projectId, jobId): Promise<string>
```

选择规则：`gitlab_ci_inspect(action=list)` 只选择 `sha === trigger.headSha` 的最新 pipeline；若 GitLab API 未返回 sha 匹配项，则不猜测关联关系，标记 `pipeline_not_found_for_head_sha`。pipeline 与 job 列表使用显式、有限的分页策略。模型可针对任意状态的 job 调用 `read_job_log`，服务端先验证 job 确属当前 HEAD pipeline，再清除 ANSI 控制符和可能的密钥形式，并按 `maxJobLogBytes` 截断。日志只存在于当次 tool output，`ReviewRunStore` 仅持久化 pipeline/job 摘要、查询次数和 diagnostics。

所有以下情况均返回稳定的“CI 证据不可用/不完整”诊断并继续 review：无 MR、无 HEAD SHA、无 pipeline、token 缺失、403/404、超时、单个 job trace 读取失败。pipeline running 仍可正常列出，模型可按需查看其 job；只有 diff 自身的既有硬阻断仍可阻断 review。

## 长上下文切片策略

在保留现有文件黑名单和 diff overflow 保护的前提下，引入 `GitLabReviewContextPacketBuilder`。它不读网络、不读本地仓库，只消费 webhook、项目快照、CI 摘要和 GitLab changes 响应，因而可用 fixture 做确定性测试。

### 文件排序

按以下顺序排序，排序结果和理由写入 manifest：

1. 匹配项目 `includePathPrefixes` 或 review focus 的文件。
2. 安全、鉴权、数据库、配置、依赖、CI 定义等高风险路径。
3. 改动行数与 hunk 数较少但可完整提供的业务文件。
4. 其他普通源码文件。

项目 `excludePathPatterns` 在全局黑名单之后执行；它仅排除模型上下文，不改变 GitLab 的真实 diff 或已有 inline 定位逻辑。

### 文件内 hunk 切片

- 先完整保留高优先级文件的 hunk，直到耗尽 diff 预算。
- 单文件过大时，按 hunk 而不是按字符串中间位置截断；每片保存文件路径和完整 hunk，渲染时生成稳定序号及 old/new line map，总体记录 `usedBytes`。
- 当前实现对单个超过剩余预算的 hunk 整体省略并记录 `budget-exceeded`，不会截断在半行或伪造行号。首尾带行号窗口仍是后续增强项，不能在验收结论中声称已经支持。
- 被过滤的文件进入 `skipped`，原因包括 `profile-excluded`、`generated`、`blacklisted`、`too-large` 和 `budget-exceeded`；预算内无法提供的 hunk 文件进入 `omissions`，原因为 `budget-exceeded`。
- 预算分配先计算首个 diff hunk 的完整 evidence 成本；总预算足以同时容纳该 hunk 和最小补充空间时先做预留，再让项目 overlay、CI 与 manifest 共享剩余预算。
- CI 与其他可选 block 不得把本来可容纳的 hunk 数压到 0；若总预算连一个完整 hunk evidence 都无法容纳，则保留明确的 omission，而不是截断 hunk。

第一版不做向量检索、代码库全量索引或跨 MR 长期记忆；这些会引入索引一致性、权限和成本问题，且不满足当前 MR diff review 的最小闭环。

## 分批实施计划

### Batch 1：项目档案与 ReviewRun 归属

**状态：已完成（2026-08-06）**

已实现项目档案归一化与 `(host, projectId)` 匹配；`ReviewRun` 已持久化项目快照。该批次最初允许未建档项目继续执行，现由 Batch 6 的显式 Project 绑定和 fail-closed 规则替代；公开 run DTO 仍只返回项目摘要，不暴露 review overlay 或策略字段。

**范围**

- 修改 `packages/platform-gitlab/src/review/types.ts`、`settings.ts`，定义、归一化并校验项目档案。
- 新增 `packages/platform-gitlab/src/review/project-profile.ts`：按 `(host, projectId)` 匹配档案、生成无档案快照、返回拒绝/告警结果。
- 修改 `packages/nine1bot/src/review/run-store.ts` 与 `gitlab-controller.ts`：创建 run 前解析项目档案，持久化 `project` 快照。
- 修改 `opencode/packages/opencode/src/server/routes/webhooks.ts`：列表和详情响应返回脱敏项目摘要。
- 增加 platform-gitlab 与 nine1bot controller/store 的单测与旧 run JSON 兼容测试。

**验收**

- `root/uftest`（project id 3）触发 review 后，run 记录和 API 响应都有稳定的项目名称、路径、项目 ID 与快照版本。
- 同项目的后续配置修改不改变历史 run 的项目快照。
- 未建档兼容行为仅记录为历史实现；Batch 6 完成后，未建档、未绑定和禁用档案的项目均被确定性拒绝。

### Batch 2：可降级 CI/CD 上下文（历史预取实现）

**状态：历史批次已完成，controller 预取已由 Batch 7 替代（2026-08-10）**

该批次曾接入 MR pipeline、pipeline jobs 与 job trace 的 controller 预取；仅精确匹配当前 HEAD SHA。其 GitLab API 能力和日志清理规则继续复用，但 `pipeline-context.ts`、初始 CI context block 和提前选择失败日志的流程已删除，当前行为见 Batch 7。

**范围**

- 扩展 `packages/platform-gitlab/src/review/api-client.ts`，加入 pipeline、job 与 trace 的只读 API 和类型。
- 新增 `packages/platform-gitlab/src/review/pipeline-context.ts`，负责 HEAD SHA 匹配、job 选择、trace 清理/截断、诊断输出。
- 扩展 `context-builder.ts` 与 `gitlab-controller.ts`，仅对 MR review 在 token 可用时加载 CI 证据；任何 CI 失败走降级路径。
- 扩展 review prompt 和发布摘要，显示 pipeline 状态及“未读取/不完整”原因，不把 CI 状态写成代码 finding。
- 使用 mock fetch 覆盖 success、failed、running、missing、403、trace 失败与超预算日志。

**验收**

- UFtest MR 的成功/失败 pipeline 出现在 context diagnostics 中；失败 job 的日志摘要有上限且不含 ANSI 控制序列。
- GitLab 无 pipeline、token 无效或 job trace 失败时，review 仍进入 runtime 并能够发布。
- 不产生 GitLab CI/CD 的任何写操作。

### Batch 3：冻结上下文包与 diff 切片

**状态：已完成（2026-08-06）**

已新增 hunk 边界切片器并接入 review context/runtime prompt；模型只消费 slices，裁剪的 hunk 会以 omission 形式显式呈现。既有 diff manifest、GitLab overflow 防护和 inline position 校验保持不变。

**范围**

- 扩展 `context-builder.ts` 并新增 `diff-slicer.ts`，将项目、CI、manifest 与 slice 组成确定性 packet。
- 让 `context-builder.ts` 从全量文件 diff 改为消费 packet，保持 `buildGitLabReviewContext` 的调用边界尽量稳定。
- 修改 `gitlab-controller.ts` 的 runtime prompt：渲染 slice 与 omissions，禁止模型声称审查了未提供的内容。
- 对已有 `diff-builder.ts` 的 global blacklist、overflow 和 inline position 依赖做回归保护；切片只影响模型输入，不破坏发布定位。
- 建立 large MR fixtures，覆盖多文件预算竞争、单 hunk 超限、项目 include/exclude、CI 预算预留和同输入确定性。

**验收**

- 相同输入在不同运行中得到相同 slice 顺序、内容和 diagnostics。
- 任意模型输入均不超过配置预算；切片不会截断在半行或伪造行号。
- prompt 中存在清晰 omissions，且 finding 只能引用实际提供文件/行范围。

### Batch 4：配置页、运行记录与 GitLab 联调

**状态：实现完成，真实 GitLab 部署复验待执行（2026-08-06）**

已复用现有 PlatformManager 动态设置保存通道，而非新增硬编码配置页：项目搜索结果可直接创建审查档案；档案支持启用状态、显示名称、审查关注点、私有 Markdown 上下文、单次审查最多读取日志数和单个任务日志最大字节数。旧 CI 启用开关、失败日志开关和 `maxFailedJobs` 已迁移，不再控制 Runtime。Review Runs 展示项目归属与 pipeline 摘要、诊断信息。`publicGitLabReviewRun` 对 `ci` 使用字段白名单，防止未来实现误将 trace 等重型或敏感字段带到浏览器。部署候选版本仍需使用隔离测试项目完成真实 webhook、pipeline 和评论回写复验；不得以本地 mock 结果替代该验证。

**范围**

- 定位当前 GitLab 配置页的数据源，复用已完成的 Feishu 平台配置模式；提供项目档案列表、搜索项目、编辑表单和 Markdown 上下文编辑器。
- 表单字段包括项目、启用状态、显示名、审查重点、include/exclude 路径、总上下文预算、单次日志读取上限、单日志字节上限与项目说明。
- 在 review runs 列表和详情中展示项目归属、pipeline 摘要、context diagnostics、切片/省略统计；默认不展示 Markdown 全文或原始日志。
- 为前端状态、配置 round-trip、路由 DTO 与空/错误态补测试。
- 使用有效 GitLab token 在 UFtest 完成真实 MR 联调：项目匹配、pipeline 可用与不可用、手动 mention、自动 webhook、结果回写、重试与幂等。

**验收**

- 用户可以在 GitLab 配置页创建并保存 UFtest 项目档案，无需手改配置文件。
- 一个 UFtest review 在页面、run API、runtime prompt 和 GitLab 回写中都可追溯到 UFtest。
- CI 不存在或读取失败的真实 MR 仍能完成 review；存在失败 pipeline 时审查结果可辨认其证据状态。

### Batch 5：合并前稳定性与安全加固

**状态：已完成（2026-08-08）**

分支基于最新 `origin/main` 重整后完成两轮代码审查，并修复最终审查发现的预算、实例身份、幂等、CI 降级和响应体边界问题。

**完成项**

- context builder 直接生成最终 `diffEvidence`；项目、CI、精简 manifest、实际渲染的 hunk、跳过项和 omission 摘要共享同一字节预算。跳过/省略详情有数量和路径长度上限，controller 不再从原始 manifest 二次展开。
- diff 文件名、代码行、项目 Markdown、用户 mention 和 CI/job trace 均以明确的 untrusted JSON evidence 注入；原始用户指令不再重复进入 system-required trigger block。
- GitLab authority 在后端与 Web 统一按小写 `host[:port]` 规范化；同主机不同端口保持隔离，旧的无 host 档案不会跨实例匹配。
- 幂等检查先于项目禁用策略执行；禁用档案产生的 rejected run 保存项目快照，配置变化不会让同一已接受事件生成第二条 run。
- CI token 读取和整个可选 CI 分支纳入独立降级边界；单 job trace 失败不丢失其他 pipeline 证据，CI 异常仍不阻断 review。
- GitLab API 请求覆盖连接与响应体读取超时；JSON、错误正文和 trace 均流式限量读取，到达上限时取消未消费流。`**/` 排除规则同时匹配仓库根目录和嵌套目录。

**验证结果**

- `bun run ci:test`：410 个测试通过，0 失败。
- `bun run ci:typecheck`：全部 package 及 Web 类型检查通过。
- `bun run build:web`：生产构建通过；仅保留既有的大 chunk 提示。

**仍保留的边界**

- GitLab 返回 `overflow` 或 `too_large` 且无法提供可信 diff 时继续硬阻断，不会依据不完整页面内容猜测审查结果。
- 单个 hunk 大于全部剩余预算时当前整体省略；尚未实现首尾窗口切片。
- 本轮不提供仓库级语义检索、向量索引或跨 MR 长期记忆；大 PR 优化仍以文件优先级、hunk 边界切片、确定性预算和显式 omission 为主。

### Batch 6：PR Review 收敛修正

**状态：已完成（2026-08-09）**

本批次只修复 PR #52 已确认的领域边界、安全和稳定性问题，不再增加 GitLab 能力面。

**完成项**

- 项目档案已增加 `nine1botProjectID`，历史 `contextMarkdown` 只在读取时迁移为 `reviewContextMarkdown`；配置页可从现有 Nine1Bot Project 列表选择绑定项目。
- Controller/server 在启动 Runtime 前解析绑定 Project，并使用其 `rootDirectory/worktree`；未建档、未绑定、重复映射或绑定失效均 fail closed，不再回退到进程目录。
- 非法 `allowedHosts` 与未配置状态已区分；重复 `(host, projectId)` 被拒绝，GitLab identity 全程保留 `host[:port]`。
- Diff evidence 会先保留首个可审查 hunk 的完整渲染预算；CI block 只存在于当次 Runtime 输入，落盘 context 删除 job trace，仅保留 pipeline 摘要和 diagnostics。
- Pipeline/job 列表固定 `per_page=100` 且最多读取 5 页；响应体恰好等于 byte limit 时会继续确认 EOF，不再误报超限。
- Web 项目档案已补齐 Nine1Bot Project 绑定、review overlay、include/exclude、上下文预算、文件上限和 job log 预算；原始 `review.projects` JSON 继续隐藏。该批次的失败 job 数字段已由 Batch 7 迁移为状态无关的 `maxJobLogs`。
- 专用 GitLab webhook 的内部结果仍携带完整 context 启动 Runtime，但公网 HTTP 响应会剥离 context，避免 diff 或当次 CI trace 进入调用方及中间代理日志。
- 新增和修改按 TDD 完成，分为 `716b51d`、`54b4204`、`5b29dc5`、`1da9852` 四个独立实现提交，便于 PR 审阅和必要时逐批回退。

**验证结果**

- `bun run ci:test`：421 个测试通过，0 失败，覆盖 58 个测试文件。
- `bun run ci:typecheck`：platform-protocol、platform-feishu、platform-gitlab、nine1bot、browser-extension、browser-mcp-server 与 Web 全部通过。
- `bun run build:web`：生产构建通过；仅有既有的大 chunk 警告。
- `bun test opencode/packages/opencode/test/server/webhooks-status.test.ts`：10 个测试通过，0 失败；`bun run --cwd opencode/packages/opencode typecheck` 通过。
- `git diff --check origin/main...HEAD`：通过后方可推送；该命令在最终文档提交后重新执行。

**后续环境验收**

- 本批次没有把 mock API 测试标记为真实 GitLab 联调。部署候选版本后仍需在隔离测试项目验证一次项目绑定、MR HEAD pipeline、无 CI 降级、评论回写和幂等重放。
- 单 hunk 大于全部可用预算时仍会整体省略并明确记录 omission；首尾窗口切片继续属于后续增强，不阻塞本批次合并。

### Batch 7：运行时按需 CI 工具与 PR 收口

**状态：代码与本地验证已完成，真实 GitLab 部署复验待执行（2026-08-10）**

**完成项**

- 所有 MR API 读写统一绑定 webhook trigger host；配置 authority 不一致时 fail closed，并保留自定义端口。
- 修复窄上下文预算边界，只要总预算可容纳首个完整 hunk 就优先保留；skipped/omitted 路径使用 JSON evidence，避免文件名突破 prompt 数据边界。
- 新增状态无关的纯 CI inspector、ReviewRun session 服务和 OpenCode `gitlab_ci_inspect` wrapper tool；工具输入仅允许 `list` 或携带 `jobId` 的 `read_job_log`。
- Runtime session 在首条消息发送前绑定 ReviewRun；非 review session、重复 session、host 不匹配、token 缺失或 job 越界均确定性拒绝。
- 删除 controller CI 预取与 `pipeline-context.ts`。MR prompt 只提供 MR URL、HEAD 和受控工具使用规则；commit review 不暴露 CI 工具。
- CI 对所有 pipeline/job 状态开放，日志按需读取；每 run 有日志数量与字节预算，retry 使用新 session 重新读取最新状态。
- Web profile 迁移为 `maxJobLogs`/`maxJobLogBytes`，并抽出可单测的 parse/serialize helper；配置测试改为真实 save/reload round-trip。
- ReviewRun 与公网 DTO 只保存/返回安全摘要、查询计数和稳定诊断，不持久化 trace、token、secret ref 或原始 GitLab 错误正文。

**验证结果**

- `bun run ci:test`：432 个测试通过，0 失败，覆盖 59 个测试文件。
- `bun run ci:typecheck`：platform-protocol、platform-feishu、platform-gitlab、nine1bot、browser-extension、browser-mcp-server 与 Web 全部通过。
- `bun run --cwd opencode/packages/opencode typecheck`：通过。
- `bun run build:web`：生产构建通过；仅保留既有的大 chunk 警告。
- `git diff --check origin/main...HEAD`：通过；敏感信息扫描未发现新增凭证。

**后续环境验收**

- 本批次未把 mock API 或本地测试标记为真实 GitLab 联调。部署候选版本后仍需在隔离测试项目验证 `list`、成功/失败/运行中 job 日志、无 CI 降级、评论回写和 retry 新鲜度。
- GitHub PR 的 5 条 review thread 仍由 reviewer/维护者确认后处理；当前代码已逐条增加对应行为回归，本次不自动回复或解决 thread。

## 稳定性与安全约束

- 项目档案匹配只信任 GitLab webhook 解析出的 host/project ID，不信任用户评论中的项目文字。
- 项目 Markdown、job trace 与用户 mention 都是非指令性数据；分别用显式标签包裹，继续沿用现有 prompt-injection 风险处理。
- 原始 trace、PAT、webhook secret、完整 API 错误正文不得存入 `ReviewRunStore`、对外路由响应、日志或 GitLab 评论。
- CI API 读取需有每次 review 的最大请求数和超时；一次失败不触发无限重试。
- run store 继续兼容 `version: 1` 的旧记录，新增字段均可选；读取旧 run 时以 `project: undefined` 表示历史无归属。
- 所有项目配置变更通过现有 config-store 原子写入；secret 继续只由 platform secret store 管理。

## 测试矩阵

| 层级 | 关键用例 |
| --- | --- |
| 纯函数 | 项目匹配、配置归一化、无档案/未绑定拒绝、禁用拒绝、排序、hunk 切片、预算和 omission |
| GitLab API client | pipeline/job/trace 路径、分页/空响应、非 2xx、日志内容读取 |
| Controller/session service | run 快照、session 绑定、CI 成功/失败/缺失、CI 降级不阻断、prompt/tool 边界、幂等与 retry |
| Store/路由 | 旧 run 兼容、脱敏 DTO、项目和诊断展示 |
| Web | 表单保存/重载、项目编辑、空态、错误态、run 归属展示 |
| 真实联调 | UFtest MR 的有 CI、无 CI、失败 CI，以及真实 comment 回写 |

## 实施顺序与提交建议

1. `feat(gitlab): persist project review profiles and run snapshots`
2. `feat(gitlab): add optional pipeline evidence to reviews`
3. `feat(gitlab): slice review context within deterministic budgets`
4. `feat(web): manage gitlab project review profiles`
5. `test(gitlab): verify project and pipeline review integration`

每个 batch 完成后先运行其对应的 package test，再运行 GitLab review 全量测试；Batch 4 之前不改变真实 GitLab hook 配置。真实联调必须使用有效且最小权限的 GitLab token，完成后将项目名、MR IID、pipeline 状态和验收结论记录到联调清单，但不记录 token、webhook secret 或完整 job trace。

## 非目标

- 不把 GitLab 能力改造成 MCP，也不向模型暴露裸 GitLab CLI。
- 不引入向量数据库、全仓索引、跨仓库记忆或自动学习项目规则。
- 不将 CI 结果作为发布阻断条件，也不控制 GitLab CI/CD 生命周期。
- 不更改现有 MR/commit review 的触发、幂等、inline comment 降级与失败回写语义，除非本计划明确要求。
