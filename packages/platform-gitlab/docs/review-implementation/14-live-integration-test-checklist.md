# GitLab Review 真实联调测试清单

> 用途：在隔离的 self-managed GitLab 上验证 Nine1Bot GitLab Review 全链路。本文不保存真实 token、密码、webhook secret 或带凭证 URL；所有尖括号变量都要在本机临时替换，结果只记录非敏感 ID、状态和稳定诊断。
>
> 文档日期：2026-08-15　测试人：Codex（自动化验证）　测试日期：2026-08-15

## 0. 验收范围与当前状态

本批次在 `54c3be6` 运行的自动化验证已通过：聚焦测试 `350 pass / 0 fail / 1217 expect()`（9 files）、根测试 `554 pass / 0 fail / 2040 expect()`（59 files）、根 typecheck、OpenCode typecheck 和 Web production build 均为 exit 0；Web build 转换 1862 个模块。`git diff --check` 为 exit 0；敏感信息扫描仅命中稳定字段名与脱敏规则，未发现凭证值。

本批次没有执行任何 external self-managed GitLab 操作。下列 P1--P6、A1--A6、B1--B4、C1--C5、D1--D5、E1--E7、R1--R5、F1--F6 以及第 8 节结论表的所有外部验证项均为 **待人工联调**；自动化测试不是 live-integration 证据。联调需要覆盖：

1. source 或 detached MR pipeline 能作为审查上下文。
2. 环境支持时，merged-results 或 merge-train pipeline 经过父提交关系校验后能作为审查上下文。
3. 没有可信 CI、CI 失败或日志不可读时，Review 继续并返回稳定诊断，不退化到项目最新流水线。
4. 配置型拒绝在修复后通过显式 retry 创建新 attempt，旧 run 保持不变。
5. Review 结果归属正确的 GitLab project profile、项目和 MR。

## 1. 环境信息

| 项目 | 联调值 |
| --- | --- |
| GitLab base URL | `<GITLAB_BASE_URL>` |
| Nine1Bot base URL | `http://<NINE1BOT_HOST>:<PORT>` |
| GitLab project path / ID | `<GROUP>/<PROJECT>` / `<PROJECT_ID>` |
| 测试 MR IID | `<MR_IID>` |
| Review project profile ID | `<PROFILE_ID>` |
| Nine1Bot project ID | `<NINE1BOT_PROJECT_ID>` |
| 审查模型 | `<PROVIDER_ID>/<MODEL_ID>` |
| Webhook URL | `http://<NINE1BOT_HOST>:<PORT>/webhooks/gitlab/<WEBHOOK_SECRET>` |

凭证只写入 Nine1Bot secret store 或 GitLab 管理界面，不写入仓库、命令历史、提示词、Issue 或本表。若使用自定义配置路径，启动前确认：

```powershell
$env:NINE1BOT_CONFIG_PATH = '<ABSOLUTE_CONFIG_PATH>'
$env:NINE1BOT_PLATFORM_SECRETS_PATH = '<ABSOLUTE_SECRET_STORE_PATH>'
bun run packages/nine1bot/src/index.ts start
```

自动 webhook Review 模型没有 CLI、shell、`curl`、`webfetch` 或通用网络工具，CI 只能通过受限的 `gitlab_ci_inspect` REST wrapper 按需读取。交互式 GitLab 页面会话可使用独立的受控 CLI wrapper，但该能力不进入 ReviewRun，也不能替代本清单中的 webhook、项目档案和可信 CI 联调。

## 2. 配置前置检查

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| P1 | 打开 Web 的 GitLab 配置页 | 页面显示配置文件加载状态、secret 状态和 GitLab 连接引导 | 未执行 | 待人工联调 |
| P2 | 配置启用的 project profile | host、project ID、profile ID、Nine1Bot project ID 均有效且唯一 | 未执行 | 待人工联调 |
| P3 | 配置项目上下文 | 项目说明、审查规则和上下文预算保存后重新加载不丢失 | 未执行 | 待人工联调 |
| P4 | 测试 GitLab token | 连接成功；页面和日志不显示 token | 未执行 | 待人工联调 |
| P5 | 配置 Project Hook | 开启 Merge request events 与 Note events，secret 与 Nine1Bot 一致 | 未执行 | 待人工联调 |
| P6 | 检查 Review 设置 | `dryRun=false` 时允许真实回写；自动触发范围符合测试项目 | 未执行 | 待人工联调 |

非法或重复 profile 必须逐条显示错误并阻止保存，不能静默过滤后覆盖原配置。

## 3. 基础链路

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | 打开 `<NINE1BOT_BASE_URL>/webhooks/status` | 返回 `listening: true`，公开 URL 可由 GitLab 访问 | | |
| A2 | 从 GitLab 发送测试 webhook | 返回 2xx，Nine1Bot 收到事件且日志不含 secret/token | | |
| A3 | 在测试 MR 留言 `@Nine1bot review` | 创建 attempt 1，状态从 `accepted` 进入 `running` | | |
| A4 | 查询 `GET /webhooks/gitlab/runs` | run 包含正确 project、MR、`rootRunId`、`attempt=1` 和 session 信息 | | |
| A5 | 等待 Review 完成 | run 成为 `succeeded`，MR 出现 summary；可定位 finding 才创建 inline discussion | | |
| A6 | 重放同一 webhook | 不创建重复 run，不重复发布评论 | | |

常用只读命令：

```powershell
curl.exe '<NINE1BOT_BASE_URL>/webhooks/status'
curl.exe '<NINE1BOT_BASE_URL>/webhooks/gitlab/runs'
curl.exe '<NINE1BOT_BASE_URL>/webhooks/gitlab/runs/<RUN_ID>'
```

## 4. CI 可信关联

CI 是补充证据，不是 Review 发布门禁。模型按审查需要调用 `gitlab_ci_inspect`；wrapper 使用冻结的 project、MR IID 和 source HEAD，自行读取 GitLab API，提示词和 tool 参数中都不包含 token。

### B. Source / Detached Pipeline

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | 为当前 MR source HEAD 运行 source 或 detached MR pipeline | GitLab MR pipelines 接口能看到该 pipeline | | |
| B2 | 触发 Review 并观察 CI tool 调用 | 只查询冻结 MR，候选最多 50 条，不访问项目 latest pipeline | | |
| B3 | 查看 tool/run CI 摘要 | pipeline SHA 等于冻结 source HEAD；`kind` 为 `source` 或 `detached`，`verification` 说明 HEAD 校验 | | |
| B4 | 让 pipeline 成功或失败后分别审查 | 两种状态都可作为上下文，Review 都能继续发布 | | |

### C. Merged-results / Merge Train

仅在测试 GitLab 版本和项目设置支持时执行；不支持则记录“跳过”和环境原因。

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | 启用 merged results pipelines，运行当前 MR pipeline | pipeline 来自当前 MR，source 为 `merge_request_event` | | |
| C2 | 触发 Review | 临时合并提交的 `parent_ids` 包含冻结 source HEAD 后才被信任 | | |
| C3 | 查看 CI 摘要 | `kind=merged_result`；版本字段不足时可为 `integrated`，但 `verification` 必须记录父提交校验 | | |
| C4 | 环境支持时把 MR 加入 merge train 并再次 Review | 可信结果为 `merge_train` 或 `integrated`，不能仅凭 ref 猜测 | | |
| C5 | 同时保留 source 与可信 integrated pipeline | 选择可信 integrated 类，再在同类中选择 ID 最大者 | | |

### D. 无可信 CI 与故障降级

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | source HEAD 更新后暂不创建对应 pipeline | 返回 `ci_pipeline_not_found_for_current_mr` 或 `ci_pipeline_unverified_for_current_head` | | |
| D2 | 项目另有更新、更晚但不属于当前 MR 的 pipeline | 不选择该流水线，不请求项目 latest pipeline | | |
| D3 | 暂时让 pipeline/jobs API 不可用 | 返回 `ci_pipeline_metadata_unavailable:*` 或 `ci_jobs_unavailable:*` | | |
| D4 | 让一份 job trace 无权限或不可读 | 返回 `ci_job_log_unavailable:<jobId>:*`，其他有界证据仍可使用 | | |
| D5 | 等待上述 Review 结束 | CI 诊断明确，Review 仍可成为 `succeeded` 并发布结果 | | |

## 5. 配置拒绝与显式 Retry

仅 `rejectionKind=configuration` 且 `recoverable=true` 的 run 可恢复。Webhook secret、非法 payload、策略拒绝不能通过该接口绕过。

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| E1 | 临时禁用或移除测试项目 profile，再触发合法 webhook | attempt 1 为 `rejected`，错误为稳定配置诊断，`recoverable=true` | | |
| E2 | 配置仍错误时调用 retry | 不创建新 attempt，返回当前配置诊断 | | |
| E3 | 修复并保存 profile，确认配置健康 | profile 能唯一匹配同一 host/project，并绑定 Nine1Bot project | | |
| E4 | `POST /webhooks/gitlab/runs/<RUN_ID>/retry` | 返回 202 和新 run ID，新 run 重新获取 MR changes 与项目上下文 | | |
| E5 | 分别读取旧、新 run | 旧 run 仍为 rejected；新 run `attempt=2`、`retryOf=<OLD_RUN_ID>`，两者 `rootRunId` 相同 | | |
| E6 | 并发或重复 retry 同一旧 run | 最多创建一个新 attempt，其余请求返回冲突，不覆盖现有记录 | | |
| E7 | 等待 attempt 2 完成 | 新 session 独立运行；旧 CI 请求或回调不能写入 attempt 2 | | |

```powershell
curl.exe -X POST '<NINE1BOT_BASE_URL>/webhooks/gitlab/runs/<REJECTED_RUN_ID>/retry'
```

## 6. HEAD 锁定与发布恢复

以下用例必须在隔离的 self-managed GitLab 上观察真实 webhook、Notes 和 Discussions 请求。对应自动化回归已经通过，但只证明本地受控行为，不是这些用例的 live-integration 证据。

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | Review 运行期间向 MR 推送新 commit，使 source HEAD 改变 | 旧 attempt 以稳定 HEAD 变化诊断结束；旧结果对 summary、discussion、fallback 和失败提示均为零发布，新 HEAD 只由新 webhook 处理 | 未执行 | 待人工联调 |
| R2 | 对同一 run 和 payload 并发发起两个 publication/callback | 只有一个 publisher 获得 claim；另一个收到稳定冲突，不产生第二套 summary、inline、fallback 或 marker | 未执行 | 待人工联调 |
| R3 | 让 summary 成功后使 inline POST 失败，再以相同 payload 恢复 | run 先进入 `partial`；恢复时先对账已有 marker，只补缺失 inline 或 fallback，不重复 summary 或任何已确认 marker | 未执行 | 待人工联调 |
| R4 | 至少一个 marker 已写入远端后重启服务，留下 stale claim，再以相同 payload 恢复 | 新 owner 通过有界 Notes/Discussions GET 对账并只补缺失项；旧 owner 不能 checkpoint、完成或覆盖新 claim | 未执行 | 待人工联调 |
| R5 | 恢复发布时让有界 Notes/Discussions GET 失败 | run 保持 `partial` 并返回稳定对账失败诊断；本次 POST 数为 0，不盲目重发，GET 恢复后再按相同 payload 续传 | 未执行 | 待人工联调 |

自动化回归已覆盖 R1 的旧 HEAD 零发布、R2 的单 claim、R3 的同 payload 部分恢复、R4 的 stale-claim marker 对账和 R5 的对账失败零盲目 POST；这些通过结果与上表的待人工状态分别记录。

## 7. 安全、上限与长上下文

| # | 操作 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| F1 | 检查自动 Review session 的工具列表 | MR PM 只有明确白名单；普通对话看不到 `gitlab_ci_inspect`；specialist 无 shell/网络/MCP | | |
| F2 | 在 CI 日志放入测试用假 token、Authorization、凭据 URL、JWT、PEM 和 ANSI | tool/session/run 只保存脱敏且截断后的内容 | | |
| F3 | 准备 101+ jobs 或超长日志 | jobs 最多 100、最终成功 list 严格 `< 32 KiB`、单日志最多 16 KiB，并有截断诊断 | | |
| F4 | 超过单 run 日志读取额度 | 最多读取配置额度且绝不超过硬上限 10 | | |
| F5 | 准备大 MR | context pipeline 按预算切片；finding 行号仍对应冻结 diff，源码以 `+++`/`---` 开头时不偏移 | | |
| F6 | 审查服务日志、session 文件和公开 run JSON | 不含 token、原始 GitLab 响应、未截断 CI 输出或完整 secret path | | |

## 8. 问题记录与结论

每个问题记录：用例编号、现象、复现步骤、稳定错误码、脱敏日志、GitLab/Nine1Bot 版本和判断。禁止粘贴 token、密码、webhook secret 或完整凭证 URL。

| 维度 | 结论（通过/失败/跳过） | 证据或说明 |
| --- | --- | --- |
| 项目与 MR 归属 | | |
| Webhook 与幂等 | | |
| Source/detached CI | | |
| Merged-results/merge-train CI | | |
| 无可信 CI 非阻断 | | |
| 配置修复后新 attempt | | |
| MR HEAD 变化零发布 | 待人工联调 | 未执行 external self-managed GitLab 操作 |
| 并发 claim 与 publication 恢复 | 待人工联调 | 未执行真实 Notes/Discussions 回写与对账 |
| Review summary/inline 回写 | | |
| 工具白名单、脱敏与输出上限 | | |
| 大 MR 上下文与行号 | | |
| 是否满足 PR 合并条件 | | |
