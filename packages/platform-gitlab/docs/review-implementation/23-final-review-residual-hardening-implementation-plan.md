# GitLab Review 最终复审遗留加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each production change must follow RED-GREEN-REFACTOR and receive an independent scoped review before the next task starts.

**Goal:** 关闭最终分支复审确认的 4 组遗留问题：GitLab specialist 资源快照回填导致会话失去复用资格、同一次发布的多个 POST 之间缺少冻结 HEAD 校验、发布聚合/渲染/编码预算在 claim 后才失败，以及项目档案 canonical/alias/null 输入可互相遮蔽并在 Web 往返时丢失原值。

**Architecture:** OpenCode specialist 会话在创建时显式声明“已解析且为空”的资源快照；Nine1Bot 把 MR 冻结 HEAD 校验下沉到每次写请求的紧邻前置步骤；`platform-gitlab` 在任何 claim 和网络访问前一次性构造不可变发布计划并校验所有可能的正文与表单编码；项目档案使用共享的“逐个已出现表示”校验结果驱动后端诊断和 Web 无损编辑。

**Tech Stack:** TypeScript、Bun test、Vue 3、OpenCode SessionPrompt/RuntimeResourceResolver、Nine1Bot ReviewRun publication 状态机、GitLab REST API v4。

**Spec:** 本计划补充 [20-review-follow-up-hardening-design.md](./20-review-follow-up-hardening-design.md) 和 [21-review-follow-up-hardening-implementation-plan.md](./21-review-follow-up-hardening-implementation-plan.md)。实施基线为已推送到 `origin/feat/gitlab-review-workflow-v2` 的 `509eb4403ad7ca1a281c3e4f85cb34ba1a29b1fa`。

## Global Constraints

- 不引入 MCP、GitLab CLI 模型权限、通用网络工具、数据库或多实例共享锁。
- specialist 资源快照必须是显式 deny-by-default：空 MCP、空 skill、空 builtin tool；不能依赖后续全局资源编译得到“碰巧为空”。
- foreign session ID 只能作为调用参考，不能让 GitLab Review 继承其他会话的上下文、资源、permission grant、目录或 client provenance。
- MR 的 summary note、inline discussion、inline fallback、blocked comment 和 failure comment 每次 POST 前都必须重新验证当前 HEAD；commit review 不增加可变 HEAD 逻辑。
- HEAD 改变后立即停止后续 POST，返回 `gitlab_review_head_changed` 或 `gitlab_review_diff_head_unverified`，不得包装成 `gitlab_api_*`。
- 发布计划预算失败必须发生在 payload claim、远端对账和任何 GitLab 请求之前；不得把超限输入写成新的 `publication.partial`。
- `gitlab_review_publication_input_too_large` 保持为稳定、脱敏的领域错误；管理发布接口映射为 HTTP 413。
- GitLab 请求正文使用实际 `application/x-www-form-urlencoded` 编码后的 UTF-8 字节数计费；不能只校验渲染前 Markdown。
- 项目档案中 canonical 与每个受支持 alias 只要实际出现，就必须独立验证；显式 `null` 是非法 profile 字段值，字段缺失仍表示未配置。
- Web 对无关字段的编辑不得删除、改写或 canonicalize 尚未修复的非法原值；用户显式修改对应逻辑字段时才清理该字段的旧表示。
- 项目上下文长度继续按 UTF-16 code units 执行 64,000 精确边界：64,000 有效，64,001 无效。
- 复杂度回归使用可重复的调用次数/扫描次数证据，不以固定毫秒阈值作为通过条件。
- 所有生产代码修改前先加入能够复现目标缺陷的失败测试并确认失败原因；每个任务独立提交。
- 不修改或提交 `.idea/`、`nine1bot.iml`，不写入任何真实 token、密码、远端评论正文或 CI 日志。

---

## 文件结构

### 实际新增文件

- `packages/platform-gitlab/src/review/project-profile-input.ts`：共享 profile 字段表示描述、逐表示校验和合法值选择，供后端与 Web 复用同一结构化校验合同。
- `packages/platform-gitlab/src/review/utf8-budget.ts`：共享单向 UTF-8 截断，统一 API response、CI trace、context block 和 diff path 的线性字节预算。
- `packages/platform-gitlab/src/review/secret-redaction.ts`：共享有界敏感信息扫描，覆盖结构化配置、shell/YAML/header、ANSI/NUL、凭证 URL、PEM 和 GitLab token。

### 重点修改文件

- `opencode/packages/opencode/src/tool/task.ts`
- `opencode/packages/opencode/test/tool/task-gitlab-review.test.ts`
- `packages/nine1bot/src/review/gitlab-controller.ts`
- `packages/nine1bot/src/review/gitlab-controller.test.ts`
- `packages/platform-gitlab/src/review/publisher.ts`
- `packages/platform-gitlab/src/review/publication-budget.ts`
- `packages/platform-gitlab/src/review/publication-reconciliation.ts`
- `packages/platform-gitlab/src/review/api-client.ts`
- `packages/platform-gitlab/src/review/index.ts`
- `packages/platform-gitlab/src/review/settings.ts`
- `packages/platform-gitlab/src/review/context-builder.ts`
- `packages/platform-gitlab/test/gitlab-review.test.ts`
- `opencode/packages/opencode/src/server/routes/webhooks.ts`
- `opencode/packages/opencode/test/server/webhooks-status.test.ts`
- `web/src/lib/gitlab-project-profile-document.ts`
- `web/test/gitlab-project-profile.test.ts`

---

### Task 1: 固化 GitLab specialist 的显式空资源快照

**Files:**
- Modify: `opencode/packages/opencode/src/tool/task.ts`
- Test: `opencode/packages/opencode/test/tool/task-gitlab-review.test.ts`

**Interfaces:**
- Produces: 模块内 `gitLabReviewSpecialistTemplateIds(ownerSessionID): string[]`，同时供创建与复用校验使用。
- Keeps: `RuntimeResourceResolver.emptyResources()` 返回空资源内容。
- Guarantees: `sourceTemplateIds` 同时包含 `gitlab-review-specialist`、owner marker 和 `RuntimeResourceResolver.resourceTemplateId()`。
- Keeps: generic `TaskTool` 的合法 child-session 复用行为不变。

- [x] **Step 1: 写真实 prompt-path 的失败测试**

在现有 foreign allow-all 场景上增加资源配置：注册一个全局 MCP server 和一个全局 skill。保存原始 `SessionPrompt.prompt`，测试 spy 只把 TaskTool 传入参数补成 `noReply: true` 后调用原实现，不返回伪造结果。这样会真实执行 `ensureRuntimeProfile()` 和 `RuntimeResourceResolver.withProfileResources()`，同时不连接模型 provider。

第一次 TaskTool 调用后断言：

```ts
expect(profile?.sourceTemplateIds).toEqual([
  "gitlab-review-specialist",
  `gitlab-review-owner:${root.id}`,
  RuntimeResourceResolver.resourceTemplateId(),
])
expect(profile?.resources.mcp.servers).toEqual([])
expect(profile?.resources.skills.skills).toEqual([])
expect(profile?.context.blocks).toEqual([])
expect(profile?.sessionPermissionGrants).toEqual([])
```

用第一次返回的 specialist session ID 再调用一次，断言复用同一 ID。foreign session 保持原 permission、资源和上下文；specialist 对 `bash`、`read`、`webfetch`、浏览器工具和未声明 MCP tool 仍为 deny。

- [x] **Step 2: 写 generic reuse 防回退测试**

保留并改为同一真实 prompt helper 的 generic child-session 场景，断言非 GitLab caller 继续复用合法 child session，且不被 GitLab owner marker 或空资源约束影响。

- [x] **Step 3: 运行 RED**

```powershell
bun test opencode/packages/opencode/test/tool/task-gitlab-review.test.ts --timeout 30000
```

Expected: 第一次真实 prompt 会给旧 profile 追加 resolver template 并回填全局资源；第二次调用因 `sourceTemplateIds` 精确比较失败而新建 session，或 specialist 出现全局资源，测试因目标缺陷失败。

- [x] **Step 4: 实施最小修复**

创建 profile 时直接写入 resolver template marker，同时保持 `resources: RuntimeResourceResolver.emptyResources()`。复用校验使用同一个 template ID helper，禁止创建与校验的数组顺序漂移。不要关闭全局 resource resolver，也不要修改其他 session 的 backfill 行为。

- [x] **Step 5: 运行 GREEN 与 OpenCode 运行时回归**

```powershell
bun test opencode/packages/opencode/test/tool/task-gitlab-review.test.ts opencode/packages/opencode/test/runtime opencode/packages/opencode/test/session --timeout 30000
bun run --cwd opencode/packages/opencode typecheck
```

- [x] **Step 6: 独立 scoped review 后提交**

reviewer 必须检查真实 prompt 是否确实执行、全局 MCP/skill 是否无法回填、owner provenance 是否仍严格、generic reuse 是否无回退。Critical/Important finding 修复并复审为 0 后提交：

```powershell
git add opencode/packages/opencode/src/tool/task.ts opencode/packages/opencode/test/tool/task-gitlab-review.test.ts
git commit -m "fix(opencode): preserve GitLab specialist resource snapshots"
```

---

### Task 2: 为每次 MR 写请求建立紧邻 HEAD 校验

**Files:**
- Modify: `packages/nine1bot/src/review/gitlab-controller.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`

**Interfaces:**
- Produces: 模块内 `headGuardedPublicationClient(...)`，包装 `createNote` 与 `createDiscussion`。
- Produces: 模块内 `assertGitLabReviewWriteHeadCurrent(...)`，在每次 MR POST 前读取 MR metadata 并验证冻结 HEAD。
- Keeps: `GitLabApiClient` 安全重定向、token 边界和 publication claim guard。
- Guarantees: commit review 不执行 MR HEAD GET。

- [x] **Step 1: 写 summary 后 HEAD 改变的 RED 测试**

创建包含 summary 和至少两个合法 inline finding 的 MR Review。mock 请求顺序为：初始 guard 返回 HEAD A；summary 紧邻校验返回 A；summary POST 成功；第一条 discussion 紧邻校验返回 HEAD B。断言：

```ts
expect(result).toMatchObject({
  published: false,
  error: "gitlab_review_head_changed",
})
expect(summaryPosts).toBe(1)
expect(discussionPosts).toBe(0)
expect(ReviewRunStore.get(run.id)?.publishedAt).toBeUndefined()
expect(ReviewRunStore.get(run.id)?.publication).toMatchObject({ state: "partial" })
```

再加入“第一条 discussion 成功、第二条前 HEAD 改变”的矩阵，断言只产生一条 discussion，后续 POST 为 0，已完成 marker 保留用于审计，但旧 HEAD run 不能完成发布。

- [x] **Step 2: 覆盖 fallback、blocked、failure 与 commit 路径**

- inline 400 后准备 fallback note 时再次读取 HEAD；HEAD 改变则不发 fallback。
- blocked/failure 单次 note 继续在 POST 紧邻前验证 HEAD。
- HEAD metadata 缺失返回 `gitlab_review_diff_head_unverified`。
- commit summary 保持一次 POST，不新增 MR metadata 请求。
- claim/generation/latest-attempt 在 HEAD GET 前后和 POST 前后都必须仍有效。

- [x] **Step 3: 运行 RED**

```powershell
bun test packages/nine1bot/src/review/gitlab-controller.test.ts --timeout 30000
```

Expected: 旧实现只在 claim 前校验一次 HEAD，summary 后仍会发 discussion/fallback，并把错误包装或错误地完成 publication。

- [x] **Step 4: 实施共享写前 guard**

每个 MR `createNote`/`createDiscussion` 的执行顺序固定为：

```text
assert run/claim current
  -> GET current MR metadata
  -> assert run/claim current
  -> compare diff_refs.head_sha with frozen trigger.headSha
  -> assert run/claim current
  -> POST
  -> assert run/claim current
```

`gitlab_review_head_changed` 与 `gitlab_review_diff_head_unverified` 作为 policy error 原样穿过 `publicationFailureMessage()`；其他 GitLab GET/POST 错误仍使用现有脱敏 `gitlab_api_<operation>_failed`。一旦 HEAD policy error 出现，当前循环必须抛出并终止。

- [x] **Step 5: 运行 GREEN 与发布状态机回归**

```powershell
bun test packages/nine1bot/src/review/gitlab-controller.test.ts packages/platform-gitlab/test/gitlab-review.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
bun run --cwd packages/nine1bot typecheck
```

- [x] **Step 6: 独立 scoped review 后提交**

reviewer 必须逐个列出所有 MR POST 调用点，确认没有绕过共享 guard；同时检查 HEAD error 不包装、marker checkpoint 不伪完成、commit 不回退。通过后提交：

```powershell
git add packages/nine1bot/src/review/gitlab-controller.ts packages/nine1bot/src/review/gitlab-controller.test.ts
git commit -m "fix(gitlab): verify frozen head before every review post"
```

---

### Task 3: 在 claim 和网络前构造完整发布计划并校验预算

**Files:**
- Modify: `packages/platform-gitlab/src/review/publication-budget.ts`
- Modify: `packages/platform-gitlab/src/review/publisher.ts`
- Modify: `packages/platform-gitlab/src/review/publication-reconciliation.ts`
- Modify: `packages/platform-gitlab/src/review/api-client.ts`
- Modify: `packages/platform-gitlab/src/review/index.ts`
- Modify: `packages/nine1bot/src/review/gitlab-controller.ts`
- Modify: `opencode/packages/opencode/src/server/routes/webhooks.ts` only if the existing 413 mapping needs a typed error branch; do not change the public route shape.
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`
- Test: `opencode/packages/opencode/test/server/webhooks-status.test.ts`

**Interfaces:**
- Produces: `prepareGitLabReviewPublicationPlan(input): GitLabReviewPreparedPublicationPlan`。
- Changes: `publishGitLabReviewResult()` 接受已准备 plan；直接平台调用未提供 plan 时仍在函数入口同步准备并执行相同防御校验。
- Changes: `reconcileGitLabReviewPublicationMarkers()` 可复用已准备 plan 的 marker catalog 与规范渲染结果，避免 controller 二次聚合。
- Produces: 共享 note/discussion form encoder，preflight 与 `GitLabApiClient` 使用同一编码实现。
- Keeps: `GITLAB_REVIEW_PUBLICATION_INPUT_TOO_LARGE` 和 `GitLabReviewPublicationBudgetError`。

`GitLabReviewPreparedPublicationPlan` 至少冻结以下数据：

```ts
type GitLabReviewPreparedPublicationPlan = Readonly<{
  summary?: Readonly<{ body: string; marker?: string; encodedBytes: number }>
  inline: readonly Readonly<{
    finding: AggregatedReviewFinding
    body: string
    position: Readonly<Record<string, unknown>>
    inlineMarker?: string
    fallback: Readonly<{ body: string; marker?: string; encodedBytes: number }>
    encodedBytes: number
  }>[]
  summaryFallbacks: readonly Readonly<{
    finding: AggregatedReviewFinding
    body: string
    marker?: string
    encodedBytes: number
  }>[]
  warnings: readonly string[]
}>
```

具体字段名可随实现调整，但 plan 必须包含 publisher 会发送的规范正文、position、marker 和编码字节结果，且不得在 claim 后重新聚合或重新渲染相同内容。

- [x] **Step 1: 写聚合膨胀的 controller RED 测试**

使用 500 条 raw snapshot 合法但相同聚合 key 的 finding，使原始总量不超过 256,000，而 `Duplicates:` 分隔和标签把聚合正文推过上限。首次发布和已有 `publication.partial` 的恢复发布各测一次。两者均断言：

```ts
expect(result).toEqual({
  published: false,
  runId: run.id,
  error: "gitlab_review_publication_input_too_large",
})
expect(gitLabRequests).toHaveLength(0)
expect(claimPublicationCalls).toBe(0)
expect(newClaimId).toBeUndefined()
```

恢复场景保留原 partial 的 claim/checkpoint 历史，不创建新 claim，不把错误包装成 `gitlab_api_publish_result_failed:*`。

- [x] **Step 2: 写渲染与表单编码精确边界测试**

- aggregate code-unit 和 UTF-8 byte 各覆盖 exact limit 与 limit + 1。
- rendered body code-unit 和 UTF-8 byte 各覆盖 exact limit 与 limit + 1。
- `URLSearchParams` percent-encoding 后的管理请求 UTF-8 bytes 覆盖 exact `2_000_000` 与 `2_000_001`；包含 ASCII、中文、emoji、换行和 position 字段。
- note、discussion、summary fallback、inline 400 fallback 都进入相同编码预算。
- deep API guard 单独测试：绕过 prepared plan 直接调用超限 `createNote`/`createDiscussion` 时，fetch 次数为 0。

- [x] **Step 3: 写管理接口 413 集成测试**

向 `/webhooks/gitlab/runs/:runId/publish` 提交 raw request 大小合法、但 plan 聚合或编码超限的 stage result。断言 HTTP 413、body error 精确等于 `gitlab_review_publication_input_too_large`、ReviewRun 没有新 claim、GitLab POST 为 0。保留现有 request-body 2 MB middleware 测试，区分 transport 413 与 domain 413。

- [x] **Step 4: 运行 RED**

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
```

Expected: 聚合/渲染超限在 claim 后抛出，被包装成 502 风格错误并留下 partial；编码膨胀没有显式上限。

- [x] **Step 5: 实施不可变 prepared plan**

在 `publishGitLabReviewRunResult()` 中执行顺序调整为：

```text
parse + raw snapshot
  -> prepare immutable publication plan
  -> catch budget error as stable domain result
  -> resolve token/client and initial HEAD guard
  -> compute payload hash
  -> claim publication
  -> reconcile with the same plan
  -> publish only operations stored in the same plan
```

plan builder 一次完成 finding 聚合、inline position 分类、summary/inline/fallback 渲染、marker 附加、所有可能请求的 form encoding 和预算断言。inline 400 的 fallback 文本必须确定性且有界；不要把任意 GitLab error body 拼进未预检正文。结果 warnings 可继续使用现有最多 240 字符的脱敏摘要，但发布正文只使用 plan 中已验证的稳定诊断。

对象通过 readonly 类型和构造时复制冻结可变数组/position；publisher 不修改 plan。`isGitLabReviewPublicationComplete()` 和 reconciliation 复用 plan 的 markers，保持旧 marker、legacy reconstruction 和相同 payload resume 兼容。

- [x] **Step 6: 在 API client 保留深层请求 guard**

note/discussion 的实际 `URLSearchParams` 必须由与 preflight 相同的 pure encoder 构造。`GitLabApiClient` 在 `fetchWithSafeRedirects()` 前重新检查编码后 UTF-8 bytes；超限抛同一个 budget error，fetch 为 0。该 guard 是防御层，不替代 controller 的 claim 前 preflight。

- [x] **Step 7: 运行 GREEN、兼容和恢复回归**

```powershell
bun test packages/platform-gitlab/test packages/nine1bot/src/review opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
bun run --cwd packages/platform-gitlab typecheck
bun run --cwd packages/nine1bot typecheck
bun run --cwd opencode/packages/opencode typecheck
```

必须保留 current marker、legacy summary/fallback、partial resume、并发 claim、payload mismatch、inline 400 fallback 和正常 direct publisher 测试。

- [x] **Step 8: 独立 scoped review 后提交**

reviewer 必须检查所有高成本步骤和网络/claim 的先后顺序、每一种 POST 的 encoded bytes、exact-boundary 算法、plan 不可变性、reconciliation 兼容和错误映射。通过后提交：

```powershell
git add packages/platform-gitlab/src/review/publication-budget.ts packages/platform-gitlab/src/review/publisher.ts packages/platform-gitlab/src/review/publication-reconciliation.ts packages/platform-gitlab/src/review/api-client.ts packages/platform-gitlab/src/review/index.ts packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/src/server/routes/webhooks.ts opencode/packages/opencode/test/server/webhooks-status.test.ts
git commit -m "fix(gitlab): preflight complete publication plans"
```

只 stage 实际有修改的文件。

---

### Task 4: 逐表示校验项目档案并保证 Web 无损修复

**Files:**
- Create or Modify: `packages/platform-gitlab/src/review/project-profile-input.ts`
- Modify: `packages/platform-gitlab/src/review/settings.ts`
- Modify: `packages/platform-gitlab/src/review/index.ts`
- Modify: `packages/platform-gitlab/src/review/context-builder.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`
- Modify: `web/src/lib/gitlab-project-profile-document.ts`
- Test: `web/test/gitlab-project-profile.test.ts`

**Interfaces:**
- Produces: `validateGitLabReviewProjectProfileRepresentations(entry)`，返回含 `code`、`logicalField`、`sourceKey` 的结构化 issue。
- Produces: `selectGitLabReviewProjectProfileValue(entry, descriptor)`，只负责在已验证表示中按 canonical-first 选择，不承担错误遮蔽。
- Changes: Web diagnostic 增加可选 `field?: string`，用于指出非法 canonical/alias key。
- Keeps: Web profile JSON root、未知字段和有效旧 alias 的读取兼容。

- [x] **Step 1: 写后端 collision/null RED 矩阵**

每类字段至少覆盖：

1. valid canonical + invalid alias。
2. invalid canonical + valid alias。
3. canonical 或 alias 显式 `null`。
4. `reviewContextMarkdown` 为 64,000，同时 `context_markdown` 为 64,001。

数值字段覆盖 `maxContextBytes/max_context_bytes`、`maxFiles/max_files`、CI 的 `maxJobLogs/max_job_logs/maxFailedJobs/max_failed_jobs` 和 `maxJobLogBytes/max_job_log_bytes`。上下文字段覆盖 4 个表示；identity/binding/list/string 字段按其现有类型约束覆盖至少一组 collision。

断言每个非法 `sourceKey` 都产生结构化诊断；合法 canonical 不能隐藏非法 alias，合法 alias 也不能隐藏非法 canonical。显式 null 与字段缺失结果不同。

- [x] **Step 2: 写 Web 无损往返 RED 矩阵**

对上述 4 个核心场景执行：parse -> 修改 `displayName` 等无关字段 -> validate -> render/serialize。断言：

- save 被阻止；diagnostic 指向具体 source key。
- raw invalid canonical/alias/null 原值仍逐字存在。
- 未修改逻辑字段的所有表示都保留，未知字段也保留。
- 用户显式修复对应逻辑字段后，旧 canonical/alias 表示被清理，只写 canonical 合法值，serialize 成功。

- [x] **Step 3: 用确定性复杂度证据替换时间阈值**

把 `truncates large ASCII and multibyte context blocks within a linear-time budget` 改为功能 + 调用次数测试：spy `TextEncoder.prototype.encode` 或抽取的 UTF-8 helper，记录一次大 ASCII 与一次大 multibyte tiny-budget 截断的编码调用次数。断言调用次数是常数上限，且单向 code-point 扫描次数不超过输入 code units 加固定常数；不再断言 `elapsedMs < 750`。

同时断言：输出 UTF-8 bytes 不超过预算、不产生破损代理对/替换字符、marker 在能容纳时完整、tiny budget 正确截断 marker。若抽取 helper，生产实现只能有一次正向扫描，循环内不得 `encode(prefix)`、`Array.from(value)` 或反复 `slice/join`。

- [x] **Step 4: 运行 RED**

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts web/test/gitlab-project-profile.test.ts --timeout 30000
```

Expected: nullish precedence 遮蔽同时存在的非法表示，Web serialize canonicalize 后删除该值；固定时间测试尚未提供确定性复杂度证据。

- [x] **Step 5: 实施共享逐表示校验**

字段 descriptor 使用 `Object.prototype.hasOwnProperty.call(entry, key)` 区分缺失与显式 undefined/null。每个已出现 key 独立执行类型、有限性、正数、字符串长度或数组元素校验。所有 issue 收集完后，runtime value 才从合法表示中 canonical-first 选择；任何非法表示仍进入全局 `configurationErrors`，不能被另一个合法表示抵消。

后端错误至少保留现有前缀，例如：

```text
project_profile_review_context_too_large:<profileId>:<sourceKey>
project_profile_max_context_bytes_invalid:<profileId>:<sourceKey>
```

现有 `startsWith(...)` 消费者保持有效。Web 映射为中文消息并填写 `field=sourceKey`。平台 patch API 顶层用 `null` 清除 settings 的语义不变；本规则只作用于 `review.projects[]` 内部字段。

- [x] **Step 6: 保持 raw document 无损更新**

`updateRawProfile()` 在 `previous` 与 `next` 对应逻辑字段相同时，不删除任何该字段表示。只有用户显式改变该逻辑字段时才删除 canonical 和 aliases，并写入 canonical 新值。`serializeGitLabProjectProfileDocument()` 必须先验证全部 raw entries；有任意 issue 时原样返回 diagnostics，不能先调用 `canonicalProfileEntry()`。

- [x] **Step 7: 运行 GREEN 与配置页回归**

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts web/test/gitlab-project-profile.test.ts web/test/use-settings-platforms.test.ts --timeout 30000
bun run --cwd packages/platform-gitlab typecheck
bun run --cwd web typecheck
bun run build:web
```

- [x] **Step 8: 独立 scoped review 后提交**

reviewer 必须检查所有 aliases 是否纳入 descriptor、null 与 missing 是否分离、64,000/64,001 是否覆盖全部上下文表示、无关编辑是否真正无损、复杂度测试是否不依赖机器速度。通过后提交：

```powershell
git add packages/platform-gitlab/src/review/project-profile-input.ts packages/platform-gitlab/src/review/settings.ts packages/platform-gitlab/src/review/index.ts packages/platform-gitlab/src/review/context-builder.ts packages/platform-gitlab/test/gitlab-review.test.ts web/src/lib/gitlab-project-profile-document.ts web/test/gitlab-project-profile.test.ts
git commit -m "fix(gitlab): validate project profile representations"
```

只 stage 实际存在且有修改的文件。

---

### Task 5: 全量验证、最终独立复审、文档收口与推送

**Files:**
- Modify: `packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/23-final-review-residual-hardening-implementation-plan.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/README.md`

**Interfaces:**
- Guarantees: 只有自动化验证和最终独立 whole-branch review 都通过，才把本计划标记为完成。
- Keeps: 真实 self-managed GitLab 联调单独记录，自动化测试不冒充 live-integration 证据。

- [x] **Step 1: 运行聚焦矩阵**

```powershell
bun test opencode/packages/opencode/test/tool/task-gitlab-review.test.ts packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts web/test/gitlab-project-profile.test.ts --timeout 30000
```

- [x] **Step 2: 运行根测试、三处 typecheck 与 Web build**

```powershell
bun run ci:test --timeout 30000
bun run ci:typecheck
bun run --cwd opencode/packages/opencode typecheck
bun run build:web
```

- [x] **Step 3: 静态、工作树和凭证检查**

```powershell
git diff --check
git status --short --branch
rg -n "glpat-[A-Za-z0-9._-]{12,}|PRIVATE-TOKEN|(?i:(token|password|secret)\\s*[:=])" packages opencode web -g "!*.test.ts" -g "!docs/**"
```

允许命中稳定 header 名称和脱敏正则，不允许真实凭证。`.idea/` 与 `nine1bot.iml` 必须继续保持 untracked 且未进入任何提交。

- [x] **Step 4: 独立 whole-branch review**

fresh reviewer 以 `origin/main...HEAD` 审查最终分支，重点复核本计划四组风险及此前已关闭的 token 重定向、工具白名单、CI 输出、日志脱敏、异步状态竞争、diff 行号、monitor 竞态和配置数据丢失。报告按 Critical/Important/Minor 排序并带文件行号。

Critical 或 Important 不得仅记入文档后继续；必须创建 fix round，运行 scoped tests/typecheck，再由新的 reviewer 复审。只有 open Critical=0 且 open Important=0 才允许收口。

- [x] **Step 5: 更新状态文档并提交**

记录每个 Task 的实现 SHA、RED/GREEN 证据、review verdict、最终测试数量和仍待人工执行的 GitLab 联调项。修正 Plan 21 中过时的“未推送/复审 pending”表述，但不要改写历史事实。

```powershell
git add packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md packages/platform-gitlab/docs/review-implementation/23-final-review-residual-hardening-implementation-plan.md packages/platform-gitlab/docs/review-implementation/README.md
git commit -m "docs(gitlab): close final review residual hardening"
```

- [x] **Step 6: 普通推送并核对远端**

```powershell
git fetch origin feat/gitlab-review-workflow-v2
git merge-base --is-ancestor origin/feat/gitlab-review-workflow-v2 HEAD
git push origin HEAD:feat/gitlab-review-workflow-v2
git rev-parse HEAD
git rev-parse origin/feat/gitlab-review-workflow-v2
```

只允许 fast-forward 普通 push，不使用 force。两个 SHA 必须一致后才宣称推送完成。

---

## 批次状态

| Batch | 内容 | 状态 | 退出条件 |
| --- | --- | --- | --- |
| Plan 21 Fix Wave | 首轮最终复审修复 | 已完成并推送 | `509eb44` 已在远端；fresh 根测试 `571 pass / 0 fail`，typecheck 与 Web build 通过 |
| Task 1 | specialist 显式空资源快照 | 已完成 | `e522c24` 实施，`1c3e775` 补齐内置工具复审测试；真实 prompt 后可复用且无全局资源注入 |
| Task 2 | 每次 MR POST 紧邻 HEAD 校验 | 已完成 | `ac8f657` 实施，`783efcf` 修复 guard 错误传播；HEAD 改变后零后续 POST |
| Task 3 | claim 前完整发布计划预算 | 已完成 | `7fc88d0` 实施，`feac45e` 补齐编码 preflight；超限时零 claim、零网络并返回 HTTP 413 |
| Task 4 | profile 逐表示无损校验 | 已完成 | `9763894` 实施，`22bb0b1` 修复 Web 诊断区分；collision/null 与无损往返均已覆盖 |
| Task 5 | 全量验证、最终复审、文档与推送 | 已完成并推送 | 自动化与最终 review 全绿；`2059047` 收口点已 fast-forward 推送且本地/远端 SHA 一致，最终状态记录继续普通推送 |

## 实施与验证记录

### Task 1--4

- Task 1 先用真实 prompt 路径复现 specialist 资源回填和复用失败，再由 `e522c24` 固化显式空资源快照；`1c3e775` 补齐内置工具边界复审测试。scoped review 确认全局 MCP、skill、context 和 permission 不会注入，generic child-session 复用不回退。
- Task 2 先复现 summary 或首条 discussion 后 HEAD 改变仍继续 POST，再由 `ac8f657` 将冻结 HEAD 校验移动到每个 MR 写请求紧邻前；`783efcf` 保证 HEAD policy error 不被 API 错误包装。scoped review 确认后续 POST 为 0，commit review 行为不变。
- Task 3 先复现 aggregate、render 和表单编码在 claim 后才超限，再由 `7fc88d0` 在 claim/网络前构造完整 prepared plan；`feac45e` 补齐 URL 编码边界。scoped review 确认所有超限路径均零 claim、零网络，管理接口稳定返回 413。
- Task 4 先复现 canonical、alias 和显式 null 互相遮蔽及 Web 无关编辑丢值，再由 `9763894` 建立逐表示共享校验，`22bb0b1` 区分 Web 字段诊断。scoped review 确认 64,000/64,001 边界、无损往返和确定性复杂度证据完整。

### 最终复审 Fix Round

初次 whole-branch review 后，`53ac1ac`、`3f96862`、`8981215`、`2509bc0`、`34aa56e` 继续关闭 specialist 工具白名单、上游错误脱敏、配置/重试门禁、远端诊断信任和 ReviewRun 事务/裁剪不变量。独立 security 与 state scoped review 均为 Critical 0、Important 0、Minor 0。

随后 whole-branch review 新确认 3 个 Important：公开 webhook 认证前正文无硬上限、CI 日志缺少不可执行边界、同一 ReviewRun 可重复调用 CI `list`。`49916c2` 按 RED-GREEN 修复：

- `/webhooks/gitlab` 与 `/webhooks/gitlab/:secret` 在配置、secret 和 JSON 读取前同时校验声明长度和实际流，2,000,000 字节有效，超出 1 字节返回 413 并取消流；异常流返回 400 并释放 reader lock。
- CI job log 使用不可逃逸的 `untrusted-gitlab-ci-log` 围栏；runtime prompt、PM agent 和 workflow skill 均禁止执行 CI 数据中的指令或接受其中的 `GITLAB_REVIEW_RESULT`。包装后的实际 UTF-8 输出严格 `< 32 KiB`，对抗探针最大为 32,767 bytes。
- 每个 ReviewRun attempt 在首次 GitLab 请求前原子预占一次 `list`；成功、失败、abort、stale 和并发调用都计数，后续调用零 GitLab 请求，retry 新 attempt 独立获得一次配额。

三项 scoped fix review 最终均为 `APPROVED/CLEAN`，Critical、Important、Minor 全部为 0。对应补充矩阵为 `194 pass / 0 fail / 994 expect()`，OpenCode、Nine1Bot、platform-gitlab typecheck 均通过。

后续最终收敛继续关闭四类边界：

- `36610ff` 拒绝 POST/PUT 等所有写请求的 301/302/303/307/308 重定向，保持 HEAD 在 303 下仍为 HEAD；同时将 CI trace 与 API 错误的敏感信息处理统一到有界结构扫描，覆盖嵌套 JSON、shell/YAML/header、ANSI/NUL、CRLF 续行、PEM、URL 凭证及 GitLab 官方 token 前缀。内部三态标记保证双扫描不吞掉安全字段，也不能由输入伪造。写重定向和脱敏 scoped review 均为 `APPROVED/CLEAN`。
- `1a953e9` 把 API response、CI trace、context block 和 diff path 的 UTF-8 截断统一到 `utf8-budget.ts` 的单向 code-point 扫描。无效 UTF-8 RED 稳定触发 2,733 次 `TextEncoder.encode`，GREEN 后保持常数次编码；四个调用点的孤立 surrogate、精确字节边界和特殊预算 scoped review 为 `APPROVED/CLEAN`。
- `6e64f47` 为超大单 hunk 增加完整 diff 行内切片，保留 hunk header 和 old/new 行映射，并在合法 JSON evidence 中显式标记 `truncated: true`；裸三反引号统一编码为可 `JSON.parse` 的 `\\u0060` 序列。builder 为 mandatory evidence envelope 预留预算，minimum 在全部文件/hunk 候选中取真实最小值；若连一行代码证据都无法容纳，context 明确 blocked，controller 在 runtime 前结束并写阻断结果。

`6e64f47` 的 scoped review 继续覆盖 fence JSON、Unicode/JSON 转义、多个 hunk/文件、9/10/11 文件计数边界、exact minimum 与少 1 字节边界，最终为 `APPROVED/CLEAN`。随后 fresh reviewer 以 `origin/main...6e64f47` 完成 whole-branch review，覆盖可信 CI、工具白名单、输出预算、重定向、脱敏、状态/monitor/attempt、配置无损、项目上下文、diff 行号和逐 POST HEAD/host，最终 verdict 为 `APPROVED/CLEAN`，开放 Critical 0、Important 0。

### 最终自动化证据

2026-08-21 在 `6e64f47` fresh 运行：platform-gitlab `160 pass / 0 fail / 853 expect()`，GitLab controller `116 pass / 0 fail / 609 expect()`；扩展聚焦矩阵 `376 pass / 0 fail / 1998 expect()`（8 files），根测试 `641 pass / 0 fail / 2834 expect()`（60 files）。根 `ci:typecheck`、OpenCode package typecheck 和 Web production build 均 exit 0；Web build 转换 1,866 modules，仅保留既有的大 chunk 警告。

`git diff --check`、`git diff origin/main...HEAD --check` 和远端祖先检查均通过。敏感信息扫描只命中脱敏正则、固定 `PRIVATE-TOKEN` header 名称和 Web 内部 `output-reset-token` 属性，没有凭证值；`.idea/` 与 `nine1bot.iml` 始终保持 untracked 且未进入提交。

真实 self-managed GitLab 的 webhook、可信 CI、Notes/Discussions 发布、远端 marker 对账和恢复动作仍为 **待人工联调**；以上自动化结果不构成 live-integration 证据。

### 推送记录

2026-08-21 先 fetch `origin/feat/gitlab-review-workflow-v2` 并确认远端 `509eb44` 是本地 HEAD 的祖先。首次 push 在 TLS 握手阶段失败且未修改远端，原命令普通重试后完成 `509eb44..2059047` fast-forward；再次 fetch 后，本地与远端均为 `2059047b44c693486c8a29df42e363d9fe3a30b2`。本状态记录提交同样只允许普通 push，最终完成条件仍是 `git rev-parse HEAD` 与 `git rev-parse origin/feat/gitlab-review-workflow-v2` 完全一致。

## 完成定义

本计划只有同时满足以下条件才完成：

1. 四个生产任务各自有 RED 复现、GREEN 验证、独立 scoped review 和独立提交。
2. specialist 在真实 prompt 路径后仍复用同一 owned session，且没有全局 MCP/skill/context/permission 注入。
3. 每个 MR POST 前都验证冻结 HEAD，HEAD 改变后没有后续写入或伪 published 状态。
4. 所有发布内容和编码预算在 claim/网络前验证，管理接口稳定返回 413，恢复记录不被新 claim 污染。
5. 所有已出现 profile 表示独立校验，显式 null 非法，Web 无关编辑保留原始非法值。
6. 聚焦测试、根测试、typecheck、Web build、静态检查全部通过。
7. 最终独立 whole-branch review 的 Critical 和 Important open findings 均为 0。
8. 文档如实区分自动化验证与尚未执行的真实 GitLab 联调，并将最终提交普通推送到远端分支。
