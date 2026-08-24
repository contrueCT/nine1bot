# PR #52 Review 跟进修复记录

日期：2026-08-24

## 1. 目标

本批次收敛 PR #52 最新 review 提出的五项问题，同时保持既定产品边界：

- 自动 Review 只使用 ReviewRun 绑定的专用 wrapper tool。
- 模型不获得 token、任意 GitLab API 地址、裸 `glab`、shell、通用文件读取或通用网络能力。
- CI 和仓库上下文均为按需补充证据，不能替代冻结 diff，也不能扩大审查范围。
- 旧 ReviewRun 不覆盖；恢复执行创建关联的新 attempt。

## 2. 已完成 Batch

### Batch 1：CLI host allowlist 非法配置 fail-closed

完成项：

- 区分 allowlist 未配置、配置有效、配置非法三种状态。
- `allowedHosts` 非法时，CLI wrapper 拒绝所有目标，不再因规范化为空数组而退化为允许任意 host。
- allowlist 校验从 `review.enabled` 中解耦；即使 webhook Review 关闭，交互式 CLI 能力仍会报告配置错误。

稳定诊断：`GitLab host allowlist configuration is invalid`。

### Batch 2：瞬时 `load_changes` 失败恢复

完成项：

- 仅将 408、425、429、5xx、网络 `TypeError` 和 `AbortError` 识别为可恢复瞬时失败。
- GitLab 重发同一 webhook 时，只有“未发布、无 publication 状态、明确标记 recoverable”的失败 run 才创建新 attempt。
- 新 attempt 使用 `rootRunId`、`retryOf` 和递增 `attempt` 关联原记录；原 run 的错误、时间和状态保持不变。
- 403、策略拒绝、已发布和部分发布记录不会自动恢复，避免重复评论。
- 自动恢复只接受带有 `transient` 标记的 `gitlab_api_load_changes_failed:*`；其他失败即使错误地带有 `recoverable` 也不能进入该路径。
- 可恢复的加载失败不发布失败评论；已有 `failureNotifiedAt` 或任意 publication 状态的 run 一律不允许重试，避免旧失败通知与新 review 竞争。
- GitLab API 超时使用专用 `GitLabApiTimeoutError`，可稳定进入瞬时失败恢复路径，不依赖错误消息匹配。

### Batch 3：冻结仓库上下文 wrapper

新增 `gitlab_repository_inspect`，支持：

- `search_text`：通过 GitLab Repository Tree API 有界枚举候选文件，并在冻结 review head 上做固定字符串搜索。
- `read_file`：通过 GitLab Repository Files API 读取冻结 review head 中的单个文件，可指定起始行和最大行数。

边界与预算：

- Nine1Bot Project 只负责 instructions、shared context、environment 和 session 归属，不要求其运行目录是 Git 仓库。
- 代码来源只取 ReviewRun 冻结的 `trigger host + projectId + headSha/commitSha`；模型不能传入或覆盖目标、ref、token 或 API path。
- ReviewRun 对外 DTO 会移除仓库查询计数等内部状态，浏览器端不可见。
- 每次调用校验当前 session、最新 attempt、generation、活动状态和 Project Profile 与 trigger 的 host/projectId 一致性。
- 只接受 GitLab 提供的 40 或 64 位十六进制 commit SHA，不接受分支名、tag 或模型提供的 ref。
- GitLab API client 继续执行同 authority 重定向、HTTPS 降级拒绝、请求超时、Token 服务端注入和有界响应读取；不引入 clone、fetch、checkout 或本地 Git 生命周期。
- 路径拒绝绝对路径、反斜杠、空段、`.`、`..`、`.git` 和控制字符。
- `excludePathPatterns` 与硬黑名单形成统一服务端访问边界：`read_file` 在请求前拒绝，`search_text` 在 tree 候选读取前和结果返回前双重过滤。
- `includePathPrefixes` 保持“候选优先级”语义，不被隐式改成访问 allowlist。
- 单 run 最多 12 次查询，单次内容最多 20 KiB，累计最多 128 KiB，单文件最大 256 KiB，搜索最多枚举 200 个 tree entry、读取 32 个候选文件、扫描 512 KiB 并返回 50 条匹配。
- 最终工具输出严格小于 32 KiB，并使用 `untrusted-gitlab-repository` fence 隔离提示词注入。

PM coordinator 和 MR/commit review skill 只允许在 diff 中的符号缺少必要上下文时调用该工具。仓库证据只能佐证 diff finding，不能产生仓库级扩展 finding。

### Batch 4：MR URL 单一来源

完成项：

- 初始 Review prompt 不再用 `https://${host}` 手工拼接 MR URL。
- `gitlab_ci_inspect` 的 `list` 结果基于 `resolveGitLabApiBaseUrl` 返回 canonical MR URL。
- 保留 self-managed GitLab 的 `http` 协议和子路径部署，例如 `http://host/gitlab/...`。

### Batch 5：CI 调用顺序与诊断一致性

完成项：

- inspector 层强制 `list -> read_job_log`。
- 只有 `list` 成功完成并写入 `listCompletedAt` 后才允许读取日志；并发中尚未完成的 list 预留不会提前解锁 read。
- `listCompletedAt` 只在最终 `< 32 KiB` DTO 成功生成后写入；输出超限返回失败时仍保持 `ci_list_required`。
- 未执行 `list` 时返回 `ci_list_required`，且不解析 token、不占用日志配额、不访问 GitLab。
- `ci_not_queried` 继续以 list 为正常协议依据，同时兼容历史上已存在 `jobLogReadCount` 的持久化记录，避免错误补记诊断。
- CI 缺失、读取失败或任意 job 状态仍不阻断 Review 发布。

### Batch 6：CLI 执行可信化与 diff 覆盖诊断

完成项（提交 `d54759d`、`305d3f8`）：

- `glab` 只从受信任的进程 `PATH` 解析一次，不允许仓库根目录及其任意子目录（包括 `node_modules/.bin`、`tools`）中的同名程序覆盖可执行文件。
- 缓存后的 `glab` 真实路径会按每次调用的仓库目录树再次校验，拒绝在切换项目后落入新仓库边界的路径。
- 子进程使用受控环境，不继承 GitLab token、CI 凭证、代理和可改变认证目标的变量。
- 认证状态按显式目标 host 检查，不再依赖当前目录或 `glab` 默认 host。
- MR/commit diff 获取采用 `maxFiles + 1` 的有界探测，并把“仍有更多文件”和 GitLab 自身截断状态写入 coverage 诊断，避免把不完整 diff 当作完整审查范围。
- 所有 CLI wrapper 继续使用固定参数和结构化输入；模型没有裸 `glab`、shell 或任意 API 调用能力。

### Batch 7：统一 host 策略与配置可停用性

完成项（提交 `ac70d87`、`4ae1f78`）：

- 配置页、页面上下文、CLI URL 解析和浏览器目标共用同一套有效 host 策略。
- host 优先从有效 `allowedHosts`、`baseUrl` 推导，最后才回退到 `gitlab.com`；非法 allowlist 保持 fail-closed。
- 显式 URL 指向禁用 host 时不会被低优先级文本 URL 或裸项目简写绕过。
- hostless 简写只在唯一有效 host 可确定时解析。
- 页面跳转使用 host-aware 目标，支持 self-managed GitLab 协议和 base path。
- 平台或自动 Review 被关闭时，陈旧项目绑定和 profile 诊断不再阻止保存；一旦重新开启，活动配置仍执行严格校验。
- runtime 发布前重新读取实时配置；平台、Review 或 publication 模式已关闭时不再发布结果或失败通知。

### Batch 8：ReviewRun 发布状态机原子化

完成项（提交 `6f52b5a`）：

- runtime 结果只接受严格、闭合的结构化 envelope，解析失败在任何 GitLab 访问前拒绝。
- 结果发布与失败通知使用互斥 claim，同一 attempt 最多只有一个发布所有者。
- 迟到的 runtime、失败通知和普通 store update 不能覆盖 terminal、published、partial 或 rejected 状态。
- 活动 attempt 只有在租约明确过期后才允许创建关联 retry；重复 webhook 也必须证明旧租约失效。
- retry 保留 `rootRunId`、`retryOf` 和递增 attempt，且每条 trigger lineage 有明确上限。
- 进程重启后可降级遗留 publishing owner 并恢复 partial publication，不会把旧记录直接改写成新 attempt。
- marker、失败记录和最终发布状态持久化失败时执行有界回滚；最终保存失败返回可恢复 partial，不伪装成 published。
- store 裁剪按完整 attempt lineage 处理，并在超过上限时优先删除最老 attempt，避免孤立关系和无界增长。

### Batch 9：自动 Review 运行时可信工具边界

完成项（提交 `a9067f1`）：

- GitLab 自动 Review 会话只暴露实现身份匹配的内置 `task`、`gitlab_ci_inspect` 和 `gitlab_repository_inspect`。
- 工具冲突按 ID fail-closed：内置、自定义、MCP 和平台注册工具任意重复时，冲突实现全部不进入模型上下文。
- 自动 Review 不扫描或导入仓库 `.opencode/tool*`，不枚举 MCP，也不加载平台注册工具；可信工具执行前后的仓库 plugin hook 同样不运行。
- coordinator 同时校验会话 client、冻结 agent、agent source provenance、profile snapshot、对象模板、资源快照模板和 `gitlab-context` 组；只伪造 agent 名称无法获得工具。
- `TaskTool` 只允许固定 GitLab specialist，并校验 specialist 的平台 owner、source 和 visibility；外部 session 不能把上下文、目录、资源、权限或 grant 带入 Review 子会话。
- specialist profile 使用空 context、空 MCP、空 skill 和严格 deny 权限；恢复子会话时重新校验 parent、project、directory、client、profile、权限和 owner marker。
- 自动模式不再自动批准 `gitlab_cli_publish_*` 权限；monitor 的 `allow-session` 策略也会拒绝这些安全关键写权限。

### Batch 10：monitor 与通用 Webhook 终态竞争

完成项（包含于 `a9067f1`）：

- monitor 超时会主动取消对应 session，清理订阅，并保证 terminal callback 只执行一次。
- 快速 `session.idle`、首消息失败和超时通过同一幂等 finish 路径收口。
- 通用 Webhook 的 controller response、runtime finish 和 interaction 更新进入单一串行队列。
- runtime 先完成、controller response 后返回时，持久化状态仍保持 succeeded/failed，不会回退到 running。
- 真实 controller 创建路径测试确认 GitLab profile 包含 `browser-gitlab`、MR/commit 对象模板、资源快照标记、`internal-runtime` agent 来源和 `gitlab-context`。

### Batch 11：Project 领域边界与仓库可见范围收敛

完成项：

- 删除 Project runtime directory fingerprint、Git 子进程和本地仓库根目录校验，不再把 Nine1Bot Project 当成代码仓库。
- `gitlab_repository_inspect` 与 `gitlab_ci_inspect` 一样，从平台动态配置读取 GitLab base URL，并从 secret store 解析服务端 token。
- OpenCode tool 不再把 `context.cwd` 传给仓库 inspector；模型 schema 继续拒绝 directory、runId、token 和其他目标字段。
- ReviewRun 的 repository 字段只保存查询次数和累计输出预算，不保存本机路径或目录派生身份。
- Diff builder 和 repository inspector 共用 `decideGitLabReviewPathAccess`，排除目录不会因按需搜索或读取重新进入模型上下文。
- GitLab 文件、目录树和所有最终证据均固定到 ReviewRun 中的 SHA；找不到可信仓库证据时返回稳定诊断，自动 Review 主流程继续运行。
- GitLab 自动 Review 的 `task` 提示词不再解析 `@file`、`@directory` 或 `@~/...` 本地引用，而是以纯文本传给 specialist，阻断通过通用 prompt 解析器枚举 Project 目录或工作区外路径的旁路；普通 TaskTool 的本地引用能力保持不变。

### Batch 12：仓库优先路径发现与聚合资源预算

完成项：

- 未显式提供 `pathPrefix` 时，`search_text` 会先规范化并去重 Project Profile 中的 `includePathPrefixes`，最多选择 4 个优先路径，在最多 100 个 tree entry 的配额内先行查询；随后使用剩余配额做全仓 tree 回退，并按路径去重，单次搜索总量仍不超过 200 个 entry。
- 配置中的优先路径返回 404 时将其视为过期提示并继续全仓回退；显式 `pathPrefix` 返回 404 时仍给出稳定的 `repository_search_path_not_found`。`includePathPrefixes` 只影响发现顺序，不构成访问 allowlist。
- GitLab API client 在每次真实 `fetch` 前调用服务端预算钩子，分页请求和同 authority 重定向分别计数，无法再通过一次 wrapper 调用放大为未计量的 HTTP 请求。
- 每个 ReviewRun attempt 最多允许 64 次 GitLab HTTP 请求、48 次 raw file 读取和 2 MiB 文件读取字节；这些计数与原有 12 次工具查询、128 KiB 累计输出预算一起持久化，并在新 attempt 创建时重置。
- raw file 请求在首个网络访问前原子预留 HTTP、文件次数和最大读取字节，成功后回收未使用字节；失败或中断的请求保留预留额度，避免重复失败请求绕过总预算。并发工具调用也不能让计数越过硬上限。
- 每次 `search_text` 增加 30 秒服务端硬截止，截止信号贯穿 tree 分页和 raw file 读取；上游取消仍返回 `repository_request_aborted`，内部截止稳定返回 `repository_search_timeout`。
- 资源预算耗尽分别返回 `repository_api_request_limit_reached`、`repository_file_fetch_limit_reached` 和 `repository_fetch_byte_limit_reached`，并在下一次网络访问前停止，不返回不完整的伪成功结果。

## 3. 测试覆盖

已完成聚焦红绿测试：

- allowlist 非法配置在 webhook Review 关闭时仍拒绝 CLI 目标。
- 502 首次失败后 webhook 重发创建关联 attempt，旧 run 不变。
- 绑定的 Nine1Bot Project 目录不是 Git 仓库时，仍通过 mocked GitLab API 从冻结 head 读取代码。
- 模型伪造 host、projectId、ref 或 token 不会改变服务端从 ReviewRun 解析的目标。
- `..`、`.git`、绝对路径和控制字符在任何 GitLab 请求前被拒绝。
- `excludePathPatterns` 和硬黑名单同时约束直接读取、搜索前候选和搜索结果；排除路径不会发起 raw file 请求。
- GitLab API 同 authority 重定向、响应字节限制和服务端 token 注入继续适用于仓库读取。
- 仓库查询次数、内容、累计输出和最终 tool DTO 均受限。
- 优先目录位于全仓前 200 个 tree entry 之外时，仍会在全仓回退前被发现；优先目录与全仓结果按路径去重。
- 第 64 次真实 GitLab 请求后，后续分页或 raw file 请求在 `fetch` 前停止；同 authority 重定向的每一跳也独立计数。
- 文件次数、文件字节聚合预算和 30 秒单次搜索截止返回稳定诊断，且不会继续访问 GitLab。
- MR 与 commit review 分别固定使用 `headSha` 和 `commitSha`；模型不能覆盖任一 ref。
- GitLab 自动 Review 的 specialist 任务中，本地 `@` 引用保持为字面文本且不会生成 `file://` part；普通 TaskTool 仍执行原有引用解析。
- CI 日志读取前置 list、token 零读取和 GitLab 零请求。
- self-managed GitLab 的协议与 base path 在 canonical MR URL 中保持不变。
- ReviewRun 状态机定向测试：132 pass / 0 fail。
- GitLab CLI client 与 wrapper tools：39 pass / 0 fail。
- OpenCode GitLab TaskTool 边界聚焦测试：10 pass / 0 fail。
- GitLab 仓库 inspector 聚焦测试：14 pass / 0 fail。
- 仓库定义的 OpenCode runtime CI：194 pass / 0 fail；registry 补充用例：1 pass / 0 fail。
- 根仓库 `ci:test`：758 pass / 0 fail，3342 次断言。
- 根仓库全部 package `ci:typecheck`：通过。
- Web production build：通过（1869 modules transformed）。
- OpenCode `tsgo --noEmit`：通过。

全量测试曾在 Windows 上暴露仓库预算用例接近 Bun 默认 5 秒时限的问题。测试改为直接预置到查询额度临界值，只运行最后一次允许查询和一次拒绝查询；行为覆盖不变，预算用例耗时由约 3.9 秒降至约 1.3 秒。

## 4. 后续计划

### 待部署联调

- 在真实 self-managed GitLab 上复测 webhook、可信 CI 关联、仓库 wrapper、summary/discussion 回写和 partial publication 恢复。
- 验证有 CI、无 CI、失败 CI、merge-result、merge-train、MR 更新和重复 webhook 场景。
- 验证大 MR 的 diff 截断诊断、按需仓库上下文、输出预算和长上下文切片效果。

### 待远端协作

- 推送当前 PR 分支并等待 GitHub CI。
- 根据最新提交回复或 resolve 对应 review thread；远端 thread 状态不由本地测试代替。

自动化通过不等于真实 GitLab 联调完成。MCP 仍不在本项目方案内；对外能力继续由 skill 固定流程、wrapper tool 固定边界、context pipeline 控制注入。
