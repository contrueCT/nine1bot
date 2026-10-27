# Nine1Bot 用户体验与功能审查

审查日期：2026-10-22。基线为 `main` 的 `4d918fd1e555c5505705014f726b0b02d1167428`，已通过 `gh` 确认与当时 GitHub 主分支一致。审查分支为 `review/full-ux-20261022`，采用独立 Git worktree 进行修复和验证。

**基线审查确认的 15 项问题已全部修复，并补充回归测试。** 原严重级别为 3 项 P1、12 项 P2；编号与基线发现保持对应。代码、测试和证据随修复分支一并提交；本轮未部署生产环境。

初轮修复的根目录 `ci:test` 为 **1247 通过、2 跳过、0 失败**；后端运行时主批次 **518 通过、13 跳过**，registry 补充批次 **1 通过**，均无失败。7 个 workspace 类型检查和 Web 生产构建全部通过。DOCX 已在真实浏览器中验证首次显示和文档切换。

## 2026-10-28 与 main 同步验证

同步 `main` 的 `1441700`（PR #71）后，手工解决 `useSession.ts` 和输入框生命周期测试两处冲突。保留恢复取消、缓冲溢出后的有界重试、逐 requestID 的待办合并，以及输入框草稿 lease 和压缩状态保护。

每次恢复重试都会取得新的交互读取顺序，避免重试使用旧顺序而丢弃新快照。新增回归用例覆盖：旧恢复阻塞 → 独立列表完成 → 事件溢出 → 新恢复成功，最终必须显示重试的新卡片。

本轮在合并结果上重新验证（Bun 1.3.14，macOS）：

- `ci:test`：1312 通过、3 跳过、0 失败。
- `ci:test:opencode-runtime`：主批次 518 通过、13 跳过；registry 补充 1 通过，均无失败。
- 7 个 workspace 类型检查、Web 生产构建和浏览器专项类型检查：通过。
- 终端快照与 screen-buffer 专项：9 通过。
- 使用本机 Microsoft Edge 的真实无头 Chromium 浏览器回归：9 个场景全部通过（1 个测试入口）。普通 `ci:test` 中该入口仍默认跳过，专项已单独执行。此结果不包含 Chrome/MV3 外部扩展验收。

以下原始验证统计保留为 2026-10-22 审查记录，本节为同步 main 后的最新验证结果。

## 修复与回归映射

| 编号 | 已完成的修复 | 主要回归测试 |
| --- | --- | --- |
| 1 | 项目切换清空旧视图；列表响应同时校验项目归属与请求代次；删除只接受当前列表中的目标，旧操作完成后不能刷新新项目。 | [projects-page-ownership.test.ts](../web/test/projects-page-ownership.test.ts)：迟到响应、返回同一项目、共享文件删除归属。 |
| 2 | 增加目录项目到 Git 项目的迁移、旧 ID 解析和可重试检查点，保留当前活动实例的身份；覆盖会话及关联配置、自动化引用；发现与实例登记共用锁，实例关闭后仍等待实际执行权释放。 | [session-storage-regressions.test.ts](../opencode/packages/opencode/test/server/session-storage-regressions.test.ts)：首次提交、已有分裂项目、活动实例、迁移中断与重试；另更新 project 测试契约。 |
| 3 | 平台读取复用全局/项目合并、隔离开关与环境变量解析；保存仅写入变更字段，保留未修改表达式与继承；删除继承值、失败回滚和并发访问有明确处理。 | [config-store.test.ts](../packages/nine1bot/src/platform/config-store.test.ts)、[platform-config-inheritance.test.ts](../opencode/packages/opencode/test/server/platform-config-inheritance.test.ts)、[nine1bot-platforms.test.ts](../opencode/packages/opencode/test/server/nine1bot-platforms.test.ts)。 |
| 4 | 明确 busy 拒绝后恢复可编辑、可重试状态；网络结果未知仍使用回执恢复。 | [composer-stop-lifecycle.test.ts](../web/test/composer-stop-lifecycle.test.ts)：真实输入框的 busy 重试/编辑与未知结果恢复。 |
| 5 | 全局事件更新跨目录后台运行状态；重连按目录校准，保护当前会话及更新的本地/SSE 状态。 | [app-global-session-events.test.ts](../web/test/app-global-session-events.test.ts)、[use-parallel-sessions.test.ts](../web/test/use-parallel-sessions.test.ts)。 |
| 6 | 待处理列表与恢复快照共用读取顺序，按 requestID 合并读取期间的新增/完成状态，保留独立旧卡片并阻止已回答卡片复活。 | [session-live-state.test.ts](../web/test/session-live-state.test.ts)：已回答问题、新权限卡片、多次列表响应乱序。 |
| 7 | 每份附件通过原子分配的独立目录持有最终路径，同名并发上传互不覆盖。 | [session-storage-regressions.test.ts](../opencode/packages/opencode/test/server/session-storage-regressions.test.ts)：重叠流式同名上传返回独立文件，内容保持正确。 |
| 8 | 文件选择时捕获项目 ID；读取、上传和刷新保持原始归属，补充读取/上传失败反馈与重试。 | [projects-page-ownership.test.ts](../web/test/projects-page-ownership.test.ts)：切换项目、离开详情、读取及上传失败。 |
| 9 | 完成自动/授权码 OAuth，保留设备说明与方法索引，支持失败重试、停止等待和原目录请求；全局认证代次阻止旧授权覆盖新登录、API Key 或登出。 | 前端 [provider-oauth.test.ts](../web/test/provider-oauth.test.ts)；后端 [provider-oauth.test.ts](../opencode/packages/opencode/test/auth/provider-oauth.test.ts)。 |
| 10 | DOCX 容器保持挂载；离屏渲染后仅提交当前文档结果，隔离旧请求成功/失败和卸载回调。 | [office-preview-component.test.ts](../web/test/office-preview-component.test.ts)；真实浏览器 [DOCX 验收截图](../review-evidence/docx-browser-verification.jpg)。 |
| 11 | 新文件 URL 统一规范编码，前端统一解码后生成 HTTP 参数；支持 Windows/UNC，并依据 filename 元数据兼容历史原始 URL。 | [file-url.test.ts](../web/test/file-url.test.ts)、[send-file-url.test.ts](../opencode/packages/opencode/test/tool/send-file-url.test.ts)。 |
| 12 | 压缩在修改历史前取得运行准入，准备失败也释放运行锁；前端禁用已知忙碌状态下的压缩，并显示跨客户端竞态拒绝。 | [session-storage-regressions.test.ts](../opencode/packages/opencode/test/server/session-storage-regressions.test.ts)：busy 时历史不变、准备失败释放准入。 |
| 13 | Fork 复制受管理附件及仅存在于工具预览元数据中的文件，重写 URL、工具路径和生成的路径提示；复制失败回滚不完整 fork，保留来源。 | [session-storage-regressions.test.ts](../opencode/packages/opencode/test/server/session-storage-regressions.test.ts)：删除源会话后的附件、编码/历史原始路径、复制失败。 |
| 14 | 消费 `message.part.removed` 并移除对应的积压增量，避免内容复活。 | [session-live-state.test.ts](../web/test/session-live-state.test.ts)：部分删除、重复/无关事件、积压文本。 |
| 15 | 会话列表先按实例规则规范化目录，再过滤会话。 | [session-storage-regressions.test.ts](../opencode/packages/opencode/test/server/session-storage-regressions.test.ts)：规范路径与等价目录别名返回相同会话。 |

## 基线审查记录：原 P1

以下 15 项保留修复前的触发条件与证据。**源码行号均对应基线 `4d918fd`，当前文件已修改，行号可能漂移；复现输出表示当时的缺陷行为。** 当前实现及通过条件以上面的修复映射和正式回归测试为准。


### 1 P1 项目迟到响应导致跨项目误删文件

位置：[ProjectsPage.vue:119](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/components/ProjectsPage.vue#L119)，相同问题还在会话和文件列表加载的 110、131 行；删除请求使用 266 行的当前项目 ID。

打开项目 A，加载未完成时返回列表并进入 B。如果 B 的响应先完成，A 的响应随后会覆盖 B 页面里的会话、环境变量和文件列表。此时画面显示 A 的文件，删除操作却发往 B。如果两边存在同名文件，B 的文件会被误删。

```text
选 A ── 请求 A ─────────────────── 返回 A，覆盖页面
       选 B ── 请求 B ── 返回 B          │
                     当前项目仍是 B    │
                                      ▼
                          点击画面上的 A/shared.txt
                                      │
                                      ▼
                             删除 B/shared.txt
```

复现使用真实 Vue 组件的 setup/watch，并调用真实 `ProjectSharedFiles.save/remove` 操作临时目录：请求为 `{id:"B", relativePath:"shared.txt"}`，结果 `AExists=true, BExists=false`。修复已增加项目与请求代次守卫、切换清空和写入归属检查。

### 2 P1 首次 Git 提交后已有会话无法打开

位置：[project.ts:280](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/opencode/packages/opencode/src/project/project.ts#L280)。

在普通目录开始对话，之后初始化 Git 并创建首次提交，再重启服务或重建实例，项目 ID 会从 `dir_*` 改为 Git 根提交 SHA。代码只迁移 `global` 项目，没有迁移原目录项目的会话。原会话 GET 返回 404，新项目的会话列表为空；旧记录仍在磁盘中。

复现包含真实临时 Git 仓库、会话和消息存储、实例重建，以及实际路由调用，输出 `originalSessionStatus=404, sessionsAfter=0, originalDataStillStored=true`。修复已实现可重试迁移，覆盖会话及关联配置，并在活动实例存续期间保持身份稳定。

### 3 P1 读取平台列表会覆盖继承配置并恢复默认启用状态

位置：[nine1bot-platforms.ts:47](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/opencode/packages/opencode/src/server/routes/nine1bot-platforms.ts#L47)。

启动时 launcher 用全局与项目合并后的 `effective` 配置初始化平台 manager，但 `NINE1BOT_CONFIG_PATH` 仅指向单个活动文件。打开平台设置触发 GET 后，`syncManagerFromConfig()` 只读活动文件，再全量替换 manager 配置。若平台配置来自全局、项目文件仅有端口配置，读取操作会丢失所有继承的平台设置，并恢复 descriptor 默认值。

复现将启动合并配置中的 Feishu 设为禁用，活动项目文件没有 `platforms`；GET 返回 200 后，manager 配置变为 `{}`，Feishu 从 `enabled=false` 变成 `true`。已确认配置和运行时注册状态变化，未连接真实飞书验证外部副作用。修复已复用启动的合并与环境变量解析语义，并按变更保存源文件，避免写回未修改的展开值。

## 基线审查记录：原 P2

### 4 P2 明确 busy 拒绝后原消息无法重试或编辑

位置：[useSession.ts:722](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/composables/useSession.ts#L722)。

两个客户端接近同时向同一会话发送消息，本地尚未获知忙碌状态的请求可能得到明确的 409 拒绝。前端在 POST 前设置 `attempt.submitted=true`，失败后未恢复。之后点击恢复只能查询不存在的回执，编辑入口也被隐藏。复现结果为 `submitted=true, retried=false, posts=1, editable=false`。修复后明确未接收的请求可以重试和编辑，结果未知的请求仍走只读回执恢复。

### 5 P2 跨工作目录后台会话完成后仍显示运行中

位置：[App.vue:423](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/App.vue#L423)。

在目录 A 启动任务后切到目录 B，旧目录事件流被关闭。当前目录 `/event` 收不到 A 的事件，而真正跨目录的 `/global/event` 回调只处理标题和项目，忽略状态结束事件。A 完成后侧栏持续转圈；累计 10 个这样的状态可耗尽前端并行额度，阻止继续发送。

执行实际 App 全局回调，送入 `session.status:idle` 和 `session.idle` 后，仍得到 `stillRunning=true, runningCount=1`。修复已接入全局事件，并在重连后按目录校准运行状态。

### 6 P2 待处理列表的迟到响应复活已回答卡片或隐藏新卡片

位置：[useSession.ts:1277](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/composables/useSession.ts#L1277)，实际调用入口为 App.vue:599 的会话 watcher。

`loadPendingRequests()` 仅判断是否切换会话，再整批覆盖待回答问题和权限。若请求期间 SSE 已移除已回答问题，旧响应会让它重现；若期间新增权限请求，旧列表可能将其抹掉，导致任务等待而页面没有确认卡片。

复现中回复事件后卡片数为 0，旧列表返回后重新出现 `review-question`。修复已加入请求代次与交互状态版本检查。

### 7 P2 多标签页并发上传同名附件会静默覆盖

位置：[session.ts:108](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/opencode/packages/opencode/src/server/routes/session.ts#L108)，覆盖发生于 220 行的 `fs.rename`。

两个标签页向同一会话并发上传内容不同的 `report.txt`，检查最终路径时都发现不存在，随后各写临时文件并 rename 到同一个最终路径。两个请求均返回 200 和相同 URL，后完成者覆盖先完成者。

实际流式上传复现中，第二个请求上传 `SECOND` 并成功返回，随后文件内容变成 `FIRST`。单个页面的批量选择已有串行队列，本项限定为多标签页或并发 API。修复已使用原子分配的独立附件目录，保留展示名称且不共享目标路径。

### 8 P2 共享文件读取期间切换项目会上传到错误项目

位置：[ProjectsPage.vue:237](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/components/ProjectsPage.vue#L237)。

在 A 选择文件，FileReader 未完成时切到 B，回调使用最新 `props.currentProject.id`，将文件上传到 B。复现记录 `selectedAtUpload=A, projectWhenReadCompleted=B, uploadProject=B`。若只返回列表，会因当前项目为空而失败，页面仅有控制台错误。修复已在文件选择时捕获项目 ID，固定写入归属，并在刷新与反馈前校验当前页面。

### 9 P2 OAuth 授权缺少完成步骤

位置：[useSettings.ts:386](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/composables/useSettings.ts#L386)，以及 [client.ts:2668](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/api/client.ts#L2668)。

供应商 OAuth 仅调用 authorize 并打开网页，没有调用已定义的 `completeOAuth`。后端只有 callback 才持久化认证。GitHub Copilot 的设备码位于 `instructions`，该字段也被客户端丢弃。用户无法从这条 Web 流程完成登录。

真实 composable 配合授权返回值替身得到 `authCalls=1, callbackCalls=0`；代码检查确认完成接口没有调用点。修复已补齐说明展示、自动/授权码完成、失败重试与 providers 刷新，并覆盖跨目录和手动认证变更竞态。真实供应商授权仍未执行。

### 10 P2 DOCX 预览空白

位置：[OfficePreview.vue:63](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/components/preview/OfficePreview.vue#L63)。

初始 `isLoading=true`，渲染容器在 `v-else` 分支中尚未挂载。文档加载完成时 `containerRef` 为空，渲染被跳过；最后清除 loading 才生成空容器。真实 SFC 与模板的 Vue renderer 复现为 `renderCalls=0, containerExists=true, loadingShown=false`。修复已使用常驻容器和离屏渲染提交，补充切换竞态测试；真实浏览器首次显示和文档切换也已验证。

### 11 P2 中文或空格附件名导致预览下载失败

位置：[MessageItem.vue:107](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/components/MessageItem.vue#L107)，同类逻辑在 AgentMessageGroup.vue:44、102。

服务端返回的 file URL 已经编码，前端 `slice(7)` 后再次 `encodeURIComponent`。`报告 1.png` 经该转换后，服务端得到的磁盘路径仍含 `%E6...%20`，不能指向实际文件。修复已统一 URL 编解码，支持 Windows/UNC，并根据 filename 元数据兼容历史原始 URL；无法判别的历史目录歧义见验证边界。

### 12 P2 运行中压缩返回 409 却已写入压缩请求

位置：[session.ts:853](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/opencode/packages/opencode/src/server/routes/session.ts#L853)。

流式回复期间，输入框的 `+ → 压缩会话` 仍可点击。后端先清理与写入 compaction 消息，之后 `SessionPrompt.loop()` 才申请运行锁，因此拒绝来得太晚。复现返回 409，但会话消息数从 0 变成 1，新增 part 为 `compaction`。修复已将运行准入提前至任何历史变更之前，并验证准备失败时释放锁；busy 拒绝不会再写入压缩消息。

### 13 P2 删除原会话破坏 fork 会话附件

位置：[session/index.ts:225](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/opencode/packages/opencode/src/session/index.ts#L225)，源目录删除在 435 行。

fork 直接复制文件 part 的 URL，没有复制受管理附件或记录共享引用。删除原会话后，其 uploads 被移除，fork 会话和消息仍在，但附件失效。复现结果 `forkSurvives=true, forkAttachmentExistsAfterDeletingSource=false`。

当前 Nine1Bot WebUI 没有 fork 入口；本项适用于 TUI/API，在附件消息之后 fork、使附件进入复制历史时触发。修复已复制受管理附件、重写 URL 与生成路径提示，并在失败时回滚不完整 fork。

### 14 P2 删除消息部分事件未同步到其他客户端

位置：[useSession.ts:925](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/web/src/composables/useSession.ts#L925)。

同一会话在两页打开，一页删除某个附件或文本 part，后端正确发出 `message.part.removed`，前端事件处理没有对应分支。另一页保留已删除内容；消息仍有其他 part 时也不会收到整条消息删除事件。复现发送删除 `part-two` 的事件后，列表仍是 `[part-one, part-two]`。修复已补齐部分删除处理，并丢弃对应积压增量。

### 15 P2 等价目录路径导致会话列表漏查

位置：[session.ts:321](https://github.com/contrueCT/nine1bot/blob/4d918fd1e555c5505705014f726b0b02d1167428/opencode/packages/opencode/src/server/routes/session.ts#L321)。

列表路由把已规范化的 `session.directory` 与原始 `query.directory` 直接比较。同一目录使用 `/repo` 可获取会话，使用 `/repo/.` 却返回空列表；macOS 的 `/var` 与 `/private/var` 别名也会触发。实际路由复现两次请求均为 200，规范路径包含会话、等价路径返回 0 条。

本项涉及传 `directory` 查询参数的 API/SDK 客户端；当前 Web 历史列表已取消自动追加该参数。修复已按实例目录规则统一规范路径后过滤。

## 初轮修复验证与边界

本地环境为 macOS Apple Silicon，主要测试使用 Bun 1.3.14。依赖从同 SHA 主 checkout 的现有安装通过 APFS clone 复制到 worktree，未做全新依赖安装。

| 检查 | 最近已完成结果 |
| --- | --- |
| 根目录 `ci:test` | **1247 通过、2 跳过、0 失败**，120 个文件。 |
| `ci:test:opencode-runtime` | 主批次 **518 通过、13 跳过、0 失败**，49 个文件；registry 补充批次 **1 通过、0 失败**。 |
| 7 个 workspace 类型检查 | **全部通过**：platform-protocol、platform-feishu、platform-gitlab、nine1bot、browser-extension、browser-mcp-server、web。 |
| Web 生产构建 | **通过**（`bun run build:web`）。 |
| 额外 vendored OpenCode 独立类型检查 | 仍有 **12 条基线错误**，涉及 MCP/SDK 的 `ChildProcess.on` 类型与隐式 `any`；在原主 checkout 重跑得到相同错误。本轮新增测试与产品改动无新增错误，Feishu 原有 TS2352 已消除。 |
| 针对性回归 | 表中列出的项目、聊天状态、OAuth、文件 URL、DOCX、平台配置和后端存储用例已通过相应批次；批次间有重叠，不累加计数。新增后端用例已接入 `ci:test:opencode-runtime`。 |
| DOCX 真实浏览器验收 | 真实 DOCX fixture 首次显示正常，并完成文档 A/B 切换；证据见 [截图](../review-evidence/docx-browser-verification.jpg)。 |

基线检查曾出现 Chrome 强制终止测试的 SIGTERM/SIGKILL 时序竞争，以及 Feishu CLI 的 TS2352。已分别改为等待 fixture 安装信号处理器的就绪标记、直接使用异常对象的类型字段。Chrome 早退测试也改为核对退出码与 stderr，去掉容易受系统调度影响的 2 秒墙钟断言。空 Git 仓库 ID 的旧 `global` 断言也已更新。基线的失败统计仅用于保留审查历史，不代表修复后状态。

覆盖范围包括 Web 启动、历史、聊天、草稿、重试、SSE、多目录切换、权限和问题卡片、设置、OAuth、模型/MCP、项目、文件、搜索、预览、自动化/Webhook，以及服务端会话、项目、上传、配置、平台生命周期、浏览器启动和相关测试。上游 vendored 代码未逐行穷尽审查。

验收边界：

- OAuth 流程、授权码重试、停止等待及认证代次通过本地受控 API/插件测试验证，**未登录真实供应商账号**；“停止等待”结束前端等待，不表示撤销供应商侧已经授予的权限。
- **未运行真实 LLM 推理、飞书/GitLab 外部写入或生产部署**。模型相关测试使用虚拟模型或替身，不作为真实服务可用性证据。
- DOCX 是已完成的真实浏览器专项验收；根测试中跳过的真实 Chrome/MV3 项目仍未完成，不能把本轮结果视作整套应用的真实浏览器端到端验收。运行时跳过的 13 项为需要原生 Linux 的文件锁/路径别名测试，本机 macOS 未执行这些原生场景。
- 历史原始 `file://` 数据若只有目录包含 `%xx`，且 filename 元数据无法区分“字面百分号路径”和“已编码路径”，无法无损推断。当前兼容逻辑只在 filename 能确认时采用原始路径，其余按标准 URL 解释；新生成数据已统一规范编码。

## 当前回归与证据索引

| 资料 | 状态与用途 |
| --- | --- |
| [初轮验证摘要](../review-evidence/fix-validation.json) | 2026-10-22 修复验证的命令、分批测试计数、浏览器证据与基线类型错误对照。 |
| [UI 回归入口](../review-evidence/ui-review-repro.ts) | 当前可执行入口，运行项目归属、DOCX 和文件 URL 正式测试，断言修复后行为。OAuth 单独在前后端正式测试中覆盖。 |
| [聊天回归脚本](../review-evidence/nine1bot-chat-review-repro.ts) | 当前可执行脚本，验证 busy 重试/编辑、待处理列表竞态和 part 删除事件。 |
| [后台状态回归脚本](../review-evidence/nine1bot-background-status-repro.ts) | 当前可执行脚本，验证跨目录 idle 后清除运行状态。 |
| [聊天回归说明](../review-evidence/chat-review-running.md) | 当前脚本运行方法与修复后预期输出。 |
| [后端存储回归](../opencode/packages/opencode/test/server/session-storage-regressions.test.ts) | 当前正式测试，替代审查阶段的 `full-review-audit.test.ts`，断言历史不被修改、文件不覆盖、fork 附件保留、迁移可重试和目录别名一致。 |
| [平台继承回归](../opencode/packages/opencode/test/server/platform-config-inheritance.test.ts) | 当前正式测试，替代审查阶段的 `full-review-platform-inheritance.test.ts`。 |
| [DOCX 浏览器 fixture](../web/test/fixtures/docx-browser.html) 与 [截图](../review-evidence/docx-browser-verification.jpg) | 当前专项验收资料，加载真实组件及 DOCX 字节，支持 A/B 切换。 |
| [基线验证摘要](../review-evidence/validation-summary.txt) | **历史记录**：保留修复前 CI/typecheck 输出，含已解决的失败；不作为当前状态。 |
| [基线后端复现输出](../review-evidence/final-backend-reproductions.txt) | **历史记录**：名称中的 final 指审查阶段最后一次复现，内容断言缺陷存在，使用当时旧测试文件名；当前测试以上述正式回归为准。 |

在 worktree 根目录执行当前回归：

```sh
bun review-evidence/ui-review-repro.ts
bun review-evidence/nine1bot-chat-review-repro.ts
bun review-evidence/nine1bot-background-status-repro.ts
bun test web/test/provider-oauth.test.ts
bun test --cwd opencode/packages/opencode test/auth/provider-oauth.test.ts test/server/session-storage-regressions.test.ts test/server/platform-config-inheritance.test.ts test/tool/send-file-url.test.ts
bun run ci:test
bun run ci:typecheck
bun run ci:test:opencode-runtime
```

若本机未安装对应版本，可将 `bun` 替换为 `npm exec --yes --package=bun@1.3.14 -- bun`。

DOCX 浏览器专项复查：在 worktree 根目录启动 Web Vite 服务，打开终端输出地址下的 `/test/fixtures/docx-browser.html`，检查文档首次显示以及 Document A / Document B 切换。

```sh
bun run --cwd web dev
```

本轮 15 项基线问题的代码修复、回归转换和 DOCX 浏览器专项验证已完成；真实外部服务及生产验证仍按上述边界记录。
