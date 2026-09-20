# FOG 综合报告对接与目标项目联调

更新日期：2026-09-19。

## 已确认的边界

- GitLab Review 与 FOG 报告投递独立。FOG 不可用或报告尚未满足发送条件，不阻断 GitLab 评论发布。
- 用户已确认：缺少最终 CI 时暂缓发送。无流水线、运行中、取消、跳过、状态未知都不能伪造成 `success` 或 `failed`。
- 只有可信关联且与本次 AI 审查完整 SHA 一致的 CI 最终结果才允许组成报告。不能使用项目最新流水线补位；可信 merged-result / merge-train 也不能绕过 FOG 的 SHA 一致性约束。
- FOG Token 由服务器秘密配置提供，不进入代码、文档、模型上下文或普通日志。目前尚未提供，不能宣称已完成真实投递。
- 自动 Review 首先限定到 `topview-studio/restructure-archive-system-backend`，不扩大到全部仓库。

## 当前产出与事实

### Batch 0：协议确认和只读核查，已完成

- 已阅读用户提供的《Nine1Bot → FOG HTTP 综合报告接口文档2.md》。
- 已通过 GitLab API 验证账号可登录，目标项目 ID 为 `57`。
- MR `!4` 查询时为 opened，source SHA 为 `11cdeebba554244ca3cb3f9367b83da106f2eaeb`，目标分支为 `dag-2.0`。该信息是核查快照，触发前必须重新读取。
- 初次只读核查时目标项目没有 webhook；该阶段未修改线上配置。后续配置变更见下方手动触发记录。
- 公网 API 返回的 MR `web_url` 使用内网地址 `http://10.21.76.81:8929`。必须验证部署地址映射，不能把它直接当作无条件可信跳转，也不能通过放开任意 host 解决。
- 此阶段尚无 FOG 实现；后续本地实现进度见 Batch 1/2 及 [实现与运维](./29-fog-report-outbox.md)。本次尚未部署或向真实 FOG 投递。

### Batch 3 前置联调：手动触发，进行中

用户要求优先触发 MR `!4`，因此先执行目标配置和手动审查，不等待 FOG 实现。

- 已使用原有内网连接和公网入口分别核对目标 MR：两端均为 project `57`、MR 全局 ID `45`、相同 source SHA，确认是同一实例。保留服务端自报的内网 API 地址，不修改 host 一致性校验。
- 已创建项目范围 API 凭证，凭证 ID `26`，到期日 `2026-12-18`。角色 Maintainer 用于项目 webhook 管理，凭证通过现有平台设置 API 存入 secret store；本记录不包含密钥。
- 平台审查范围切换为仅目标项目 `57`；UF 历史审查记录保留，其他平台配置不变。
- 已建立独立 Nine1Bot 目录项目 `dir_05f1372b474eaf1ee160c698557a64de36d5452d`，目录 `/home/contrue/workspace/gitlab-archive-backend-review` 仅作会话容器，不是源码 checkout。
- 已配置项目上下文，源码证据来自冻结 MR diff 和受限仓库工具，不沿用 UF 的路径过滤或架构假设。
- 已创建项目 webhook `10`：评论事件开启，MR 自动事件关闭。`review.webhookAutoReview` 仍为 `false`，尚未开启 MR 自动审查。
- 已发布触发评论 `250`。真实 webhook 已启动 `review_mu8c34c9_f`，会话为 `ses_f4677b933ffeONtHR8c2134u2A`，归属目标项目；source SHA 为 `11cdeebba554244ca3cb3f9367b83da106f2eaeb`。
- 使用模型 `tv-litellm/Qwen3.8-27B-NVFP4`。记录时状态为 `running`，尚不能认定评论发布成功。

## 实施批次

### Batch 1：协议模型与持久化待发送报告，已实现

1. 根据接口文档建立类型、输入验证、字段映射及大小预算。标题、项目路径、MR 分支和 SHA 来自可信 GitLab 元数据，不由模型猜测。
2. 保存本次审查结果、项目身份和固定 SHA；同一报告首次创建 UUID 并持久化。网络重试复用相同请求体和幂等键，新真实审查使用新键。
3. 状态区分等待 CI、等待配置、可发送、重试等待、已接受及需人工处理。诊断不包含凭证或远端原始错误体。
4. 待发送存储需要原子写入、权限限制、容量上限和可观测诊断。明确进程崩溃及发布完成到报告入队之间的恢复策略，不能仅依赖内存回调。

### Batch 2：可信 CI 补齐与独立投递，已实现

1. 后台受限查询可信流水线，不复用仅允许活跃 Review 会话调用的模型工具入口。
2. CI 为 `success` / `failed` 且 SHA 一致才生成可投递快照。MR 已换 HEAD 时不把新 HEAD 的 CI 附到旧报告。
3. `testsRun` 只陈述实际执行且有证据的检查；无明细时为空。未执行、截断、无法确认的部分记录到 `uncovered`。
4. 独立投递器设置超时、响应预算、有限并发、退避及恢复机制；禁止重定向携带 Bearer Token。鉴权或协议错误保留诊断，配置修复后显式重试。
5. 持久化目的地并检查配置变化，防止待发送报告意外投递到另一服务。HTTP 仅使用管理员显式配置的协议地址，不自动跟随来源 URL。
6. 仅 HTTP 200 且响应符合 `accepted: true` 的协议才记为接受。网络响应丢失时按同一幂等键重试。
7. 定时默认分支报告是协议允许的另一种触发类型，不代表现有仓库定时扫描已实现；本轮先打通 MR 生产链路。

### Batch 3：目标 GitLab 配置与真实联调，部分执行

1. 创建最小够用的项目范围凭证并通过现有 secret store 保存，保留无关平台配置。不持久化登录密码。
2. 为目标仓库配置独立的 Nine1Bot 会话归属及项目上下文，不能将 Nine1Bot 源码目录当作被审查仓库。
3. 明确公网入口和 GitLab 自报内网地址的身份映射，凭证请求不得随远端 URL 任意改换 host。
4. 检查 MR 事件 action/state 过滤：开启、重开、有效提交更新可进入审查；关闭、合并及纯元数据变化不盲目触发。
5. 设置仅目标项目启用的自动 Review 和 webhook，验证签名、实际可达性及重复投递幂等，不自动放宽 GitLab 全局网络安全设置。
6. 对 MR `!4` 触发一次真实审查，记录 run、SHA、评论和可信 CI 诊断；不以 API 接受触发代替审查成功。
7. FOG Token 配置后验证真实接收和重复投递；未提供前只验证等待配置及本地协议测试。

## 验收要求

本地已完成 MR 生产链路、SQLite outbox、服务启动恢复、管理状态/重试接口及协议测试。具体容量、历史补发和崩溃恢复限制见 [实现与运维](./29-fog-report-outbox.md)。默认关闭，真实 FOG 联调待 Token 和部署。

2026-09-19 本地验证：

- `bun test packages/nine1bot/src/review packages/platform-gitlab/test scripts/ci-workflow-contract.test.ts`：480 pass，0 fail。
- `bun run ci:test:opencode-runtime`：258 pass，独立 registry 测试 1 pass，均无失败。
- `bun run --cwd packages/nine1bot typecheck` 和 `bun run --cwd opencode/packages/opencode typecheck`：通过。
- `git diff --check`：通过；仅提示仓库既有 LF/CRLF 转换规则。
- 新增 FOG 专项包含本地真实 HTTP 收发测试；未使用真实 FOG 凭证，不计为线上验收。

附带修正既有 repository inspector 测试中一个 fetch mock 的类型断言，以兼容本机 Bun 类型中的 `fetch.preconnect`；不改变产品行为。

- 单元测试覆盖 CI 非最终状态、SHA 不符、字段映射、北京时间、真实检查明细和输出预算。
- 持久化测试覆盖重启恢复、重复入队、同键同请求体、存储失败和过期任务的诊断。
- 投递测试覆盖禁止重定向、超时、响应超限、401/403/422、429/5xx、响应丢失与幂等重试。
- 集成测试证明 FOG 等待或失败不改变 GitLab 评论发布结果，旧 attempt 不能覆盖新审查。
- 记录自动化测试与真实联调结果；不得将待实施批次标为完成。
