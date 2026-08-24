# GitLab Review 二次审查加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复二次代码审查确认的八类权限、安全、一致性、恢复、幂等和资源边界问题，使 ReviewRun 在并发、部分失败和进程重启后仍不会重复发布。

**Architecture:** `platform-gitlab` 提供日志脱敏、diff 状态机、受限 Notes/Discussions 读取、稳定 marker 和可续传 publisher；`nine1bot` 用 ReviewRun publication 状态机原子 claim、校验 MR HEAD、管理 CI 配额和 attempt 链；OpenCode 负责实际 task 权限与 session 启动前检查；Web 阻止陈旧项目绑定。

**Tech Stack:** TypeScript、Bun test、Vue 3、OpenCode PermissionNext/TaskTool、Nine1Bot JSON ReviewRun store、GitLab REST API v4。

## Global Constraints

- 不引入 MCP、数据库、多实例共享锁或模型通用网络能力。
- 模型不得获得 GitLab token、CLI、shell、`curl`、`webfetch`、文件写入或未显式允许的工具。
- MR diff HEAD 在构建上下文前和发布前都必须等于 trigger HEAD。
- CI 不可用或没有可信流水线不阻断 Review；HEAD 不一致必须阻止旧结果发布。
- CI list 最终成功 DTO 的 UTF-8 序列化结果必须严格 `< 32 KiB`；job log 额度在产生 GitLab 元数据请求前预占。
- 发布 marker 不得包含 token、CI 原始日志、项目上下文或 finding 原文。
- 同一 run 的部分发布只能使用相同 `payloadHash` 恢复。
- 每项生产代码修改前先加入失败测试并确认因目标缺陷失败。
- 每个任务独立提交；不修改或提交 `.idea/` 与 `nine1bot.iml`。

---

## 文件结构

### 新建文件

- `packages/platform-gitlab/src/review/publication-markers.ts`：生成、解析和追加稳定 marker，并收集远端完成项。

### 重点修改文件

- `opencode/packages/opencode/src/permission/next.ts`：基础 ruleset 与 session grant 的最终权限语义。
- `packages/platform-gitlab/src/review/ci-inspector.ts`：不完整 PEM、URL 参数秘密脱敏。
- `packages/platform-gitlab/src/review/inline-position.ts`：hunk 内增删行状态机。
- `packages/platform-gitlab/src/review/api-client.ts`：Notes、Discussions、commit comments 的有界读取和投影。
- `packages/platform-gitlab/src/review/publisher.ts`：marker-aware 发布与逐项 checkpoint。
- `packages/nine1bot/src/review/run-store.ts`：publication 状态机和完整 attempt 链裁剪。
- `packages/nine1bot/src/review/gitlab-controller.ts`：HEAD 双重校验和 publication 编排。
- `packages/nine1bot/src/review/gitlab-ci-inspector.ts`：日志额度、target 和输出硬上限。
- `opencode/packages/opencode/src/server/routes/webhooks.ts`：项目绑定 preflight 与终态保护。
- `web/src/lib/gitlab-project-profiles.ts`、`web/src/components/PlatformManager.vue`：项目绑定校验。

---

### Task 1: 修复 coordinator task 权限执行语义（已完成：`c6df20a..c6d67bc`）

**Files:**
- Modify: `opencode/packages/opencode/src/permission/next.ts:280-292`
- Test: `opencode/packages/opencode/test/permission/next.test.ts`
- Test: `opencode/packages/opencode/test/agent/platform-agent-source.test.ts`

**Interfaces:**
- Keeps: `PermissionNext.evaluateWithSessionGrants(permission, pattern, ruleset, sessionGrants): Rule`
- Guarantees: 基础 ruleset 最终 deny 不可被 session grant 覆盖；最终 specific allow 可以覆盖较早 wildcard deny

- [x] **Step 1: 写失败测试**

```ts
const base = PermissionNext.fromConfig({
  '*': 'deny',
  task: { 'platform.gitlab.*': 'allow' },
})
expect(PermissionNext.evaluateWithSessionGrants(
  'task', 'platform.gitlab.risk-qa', base, [],
).action).toBe('allow')
expect(PermissionNext.evaluateWithSessionGrants(
  'bash', '*', base, [{ permission: 'bash', pattern: '*', action: 'allow' }],
).action).toBe('deny')
```

- [x] **Step 2: 运行 RED**

Run: `bun test opencode/packages/opencode/test/permission/next.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts`

Expected: specific task allow 当前得到 `deny`。

- [x] **Step 3: 实施最小修复**

```ts
const base = evaluate(permission, pattern, ruleset)
if (base.action === 'deny') return base
return evaluate(permission, pattern, ruleset, sessionGrants)
```

- [x] **Step 4: 运行 GREEN 与 registry 回归**

Run: `bun test opencode/packages/opencode/test/permission/next.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts opencode/packages/opencode/test/tool/registry.test.ts`

- [x] **Step 5: 提交**

```powershell
git add opencode/packages/opencode/src/permission/next.ts opencode/packages/opencode/test/permission/next.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts
git commit -m "fix(gitlab): allow scoped review task delegation"
```

---

### Task 2: 修复 CI 脱敏与 inline diff 状态机（已完成：`cd05baf..8c8ffcf`）

**Files:**
- Modify: `packages/platform-gitlab/src/review/ci-inspector.ts:219-230`
- Modify: `packages/platform-gitlab/src/review/inline-position.ts:55-87`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`

**Interfaces:**
- Keeps: `sanitizeGitLabCiTrace(trace: string): string`
- Keeps: `validateGitLabInlinePosition(...)`

- [x] **Step 1: 写不完整 PEM 和 URL secret 失败测试**

```ts
const output = sanitizeGitLabCiTrace([
  'curl https://ci.example/run?access_token=query-secret&mode=test',
  'https://ci.example/#client_secret=fragment-secret',
  '-----BEGIN PRIVATE KEY-----',
  'partial-private-material',
].join('\n'))
expect(output).not.toContain('query-secret')
expect(output).not.toContain('fragment-secret')
expect(output).not.toContain('partial-private-material')
```

- [x] **Step 2: 写 `+++counter`、`---flag` 和后续行的 inline position 失败测试**

新增侧只允许 `new_line`，删除侧只允许 `old_line`，后续 context 的 old/new line 必须同步推进。

- [x] **Step 3: 运行 RED**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts`

- [x] **Step 4: 实施脱敏和 hunk 状态**

```ts
.replace(
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/gi,
  '[REDACTED_KEY_BLOCK]',
)
.replace(/([?&#](?:[^?&#\s=]*(?:token|password|secret|api[_-]?key|access[_-]?key|client[_-]?secret)[^?&#\s=]*)=)[^&#\s"']*/gi, '$1***')
```

inline parser 增加 `insideHunk`，仅在 hunk 外识别文件头，hunk 内按首字符 `+`/`-` 分类。

- [x] **Step 5: 运行 GREEN 并提交**

Run: `bun test packages/platform-gitlab/test`

```powershell
git add packages/platform-gitlab/src/review/ci-inspector.ts packages/platform-gitlab/src/review/inline-position.ts packages/platform-gitlab/test/gitlab-review.test.ts
git commit -m "fix(gitlab): close CI redaction and diff position gaps"
```

---

### Task 3: 冻结 MR diff HEAD 并在发布前复核（已完成：`719ae80..449d3e1`）

**Files:**
- Modify: `packages/nine1bot/src/review/gitlab-controller.ts`
- Modify: `opencode/packages/opencode/src/server/routes/webhooks.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`
- Test: `opencode/packages/opencode/test/server/webhooks-status.test.ts`

**Interfaces:**
- Produces: `gitLabReviewChangesHeadError(trigger, changes)`
- Produces: 稳定错误 `gitlab_review_diff_head_unverified`、`gitlab_review_head_changed`
- Keeps: commit review 不执行 MR HEAD 校验

- [x] **Step 1: 写上下文构建前 HEAD 缺失和不一致测试**

断言 run 为 `rejected`、`recoverable=false`，且不创建 context/session。

- [x] **Step 2: 写模型运行期间 HEAD 改变的零发布测试**

changes 初始匹配，发布时 `getMergeRequest()` 返回新 SHA；断言 Notes/Discussions POST 数为 0，runtime 不把 rejected 覆盖为 failed，也不发布失败提示。

- [x] **Step 3: 运行 RED**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`

- [x] **Step 4: 构建 context 前严格比较 HEAD**

```ts
const headError = gitLabReviewChangesHeadError(input.trigger, changes)
if (headError) {
  ReviewRunStore.update(input.run.id, {
    status: 'rejected', error: headError, rejectionKind: 'policy', recoverable: false,
  })
  return retryRejected(input.run, 409, headError)
}
```

所有 dry-run MR fixture 加入匹配的 `diff_refs.head_sha`，不设置测试绕过。

- [x] **Step 5: 发布前通过 `client.getMergeRequest()` 再次比较 HEAD**

不一致时返回稳定拒绝并保持零发布。OpenCode runtime 在看到当前 run 已是 rejected 时不得再次写 failed。

- [x] **Step 6: 运行 GREEN 并提交**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`

```powershell
git add packages/nine1bot/src/review/gitlab-controller.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/src/server/routes/webhooks.ts opencode/packages/opencode/test/server/webhooks-status.test.ts
git commit -m "fix(gitlab): bind review evidence to the trigger head"
```

---

### Task 4: 将失效项目绑定转换为可恢复配置拒绝（已完成：`6a879c3`）

**Files:**
- Modify: `packages/nine1bot/src/review/gitlab-controller.ts`
- Modify: `opencode/packages/opencode/src/server/routes/webhooks.ts`
- Modify: `web/src/lib/gitlab-project-profiles.ts`
- Modify: `web/src/components/PlatformManager.vue`
- Test: `opencode/packages/opencode/test/server/webhooks-status.test.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`
- Test: `web/test/gitlab-project-profile.test.ts`

**Interfaces:**
- Produces: `rejectGitLabReviewRuntimeConfiguration(runId, error): GitLabReviewWebhookResult`
- Produces: `validateGitLabProjectBindings(profiles, projects): string | undefined`
- Changes: `startGitLabReviewRuntimeRun(result, directory)` 只接收已验证目录

- [x] **Step 1: 写 stale binding 生命周期和修复后 retry 测试**

`Project.get()` 找不到绑定时，断言 session 未创建，attempt 1 为 `project_binding_missing`、configuration、recoverable；修复后 retry 产生 attempt 2，attempt 1 不变。

- [x] **Step 2: 写 Web 空项目列表仍拒绝陈旧 binding 的测试**

```ts
expect(validateGitLabProjectBindings([profileWithBinding], [])).toContain('不存在')
expect(validateGitLabProjectBindings([profileWithBinding], [matchingProject])).toBeUndefined()
```

- [x] **Step 3: 运行 RED**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts web/test/gitlab-project-profile.test.ts`

- [x] **Step 4: 在 route 启动异步 session 前 await 目录 preflight**

preflight 失败调用 controller 转换函数并直接返回 202 rejected；成功后把 directory 传给 runtime。webhook 与 retry 共用同一路径。

- [x] **Step 5: 抽取 Web 纯函数并删除 `props.projects.length > 0` 绕过**

列表未加载、为空或缺少目标时都阻止保存；有效 binding 保持原序列化结果。

- [x] **Step 6: 运行 GREEN、Web typecheck 并提交**

Run: `bun run --cwd web typecheck`

```powershell
git add packages/nine1bot/src/review/gitlab-controller.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/src/server/routes/webhooks.ts opencode/packages/opencode/test/server/webhooks-status.test.ts web/src/lib/gitlab-project-profiles.ts web/src/components/PlatformManager.vue web/test/gitlab-project-profile.test.ts
git commit -m "fix(gitlab): recover stale project bindings through retry"
```

---

### Task 5: 建立稳定 marker 与受限远端对账（已完成：`84d664f..5ef8ee3`）

**Files:**
- Create: `packages/platform-gitlab/src/review/publication-markers.ts`
- Modify: `packages/platform-gitlab/src/review/api-client.ts`
- Modify: `packages/platform-gitlab/src/review/publisher.ts`
- Modify: `packages/platform-gitlab/src/review/index.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`

**Interfaces:**
- Produces: `gitLabReviewPublicationMarker({ runId, kind, findingKey? }): string`
- Produces: `gitLabReviewFindingKey(finding): string`
- Produces: `GitLabPublishedComment = { id: string | number; body: string }`
- Produces: `GitLabApiClient.listNotes(...)`、`listDiscussions(...)`，每类最多 500 个投影项
- Extends: `PublishGitLabReviewInput.publication`

```ts
type GitLabReviewPublicationContext = {
  runId: string
  completedMarkers: ReadonlySet<string>
  onMarkerCompleted(marker: string): Promise<void> | void
}
```

- [x] **Step 1: 写 marker 稳定性和敏感信息边界测试**

同一规范化 finding key 稳定；不同 file/line/body 不同；marker 只含版本、run ID、kind 和固定长度 hash。

- [x] **Step 2: 写 Notes/Discussions DTO、分页和 500 项上限测试**

GitLab 响应注入 author/email/position 等字段，断言只返回 `{id, body}`。commit 使用 `/repository/commits/:sha/comments`，MR 使用 notes/discussions。

- [x] **Step 3: 写 publisher 跳过已有 marker 的测试**

completed set 已有 summary 和第一个 inline 时，只允许 POST 第二个 inline，成功后 callback 收到其 marker。

- [x] **Step 4: 运行 RED**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts`

- [x] **Step 5: 实现 marker、API DTO 和 marker-aware publisher**

finding key 使用 SHA-256 前 24 个十六进制字符。所有读取复用安全重定向、AbortSignal、分页和响应字节上限；每次 POST 成功后立即 await checkpoint callback。

- [x] **Step 6: 运行 GREEN 并提交**

Run: `bun test packages/platform-gitlab/test`

```powershell
git add packages/platform-gitlab/src/review/publication-markers.ts packages/platform-gitlab/src/review/api-client.ts packages/platform-gitlab/src/review/publisher.ts packages/platform-gitlab/src/review/index.ts packages/platform-gitlab/test/gitlab-review.test.ts
git commit -m "feat(gitlab): add resumable publication markers"
```

---

### Task 6: 实施 ReviewRun publication 状态机（已完成；最终修复 `7a733c6`）

**Files:**
- Modify: `packages/nine1bot/src/review/run-store.ts`
- Modify: `packages/nine1bot/src/review/gitlab-controller.ts`
- Modify: `opencode/packages/opencode/src/server/routes/webhooks.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`
- Test: `opencode/packages/opencode/test/server/webhooks-status.test.ts`

**Interfaces:**
- Produces: `ReviewRunPublication`
- Produces: `claimPublication`、`recordPublicationMarker`、`failPublication`、`completePublication`

```ts
type PublicationClaimResult =
  | { ok: true; claimId: string; resume: boolean; completedMarkers: string[] }
  | { ok: false; error: 'review_run_already_published' | 'review_run_publish_in_progress' | 'review_run_publish_payload_mismatch' | 'review_run_not_found' }
```

- [x] **Step 1: 写两个并发 publisher 的失败测试**

第一个在 GitLab fetch 上暂停，第二个同时调用；第二个必须返回 `review_run_publish_in_progress`，最终仅一份 summary/inline。

- [x] **Step 2: 写 summary 成功、inline 5xx、同 payload 恢复测试**

第一次使 run 进入 partial。第二次 notes/discussions 返回已有 marker，只补缺失 inline，不重复已完成项。

- [x] **Step 3: 写重启遗留 claim、远端对账失败和 payload mismatch 测试**

使用显式 owner A/B 模拟进程重启；相同 hash 可恢复，不同 hash 拒绝。对账 GET 失败时保持 partial 且 POST 数为 0。

- [x] **Step 4: 运行 RED**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`

- [x] **Step 5: 实施同步 claim 和条件 checkpoint**

所有 store mutation 匹配 `runId + claimId + ownerId + payloadHash`。旧 publisher 不能覆盖新 claim；每次网络 await 前后保持 run 条件校验。

- [x] **Step 6: controller 按 HEAD 复核、claim、对账、publish、complete 编排**

```ts
const payloadHash = reviewStageResultHash(parsed)
const claim = ReviewRunStore.claimPublication({ runId, payloadHash, ownerId: publisherOwnerId })
if (!claim.ok) return { published: false, runId, error: claim.error }
```

resume 时加载远端 marker；每个 marker 成功后 checkpoint；catch 标记 partial；全部确认后写 `publishedAt` 和 stage 对应终态。

- [x] **Step 7: 更新 HTTP 409 映射、运行 GREEN 并提交**

```powershell
git add packages/nine1bot/src/review/run-store.ts packages/nine1bot/src/review/gitlab-controller.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/src/server/routes/webhooks.ts opencode/packages/opencode/test/server/webhooks-status.test.ts
git commit -m "fix(gitlab): make review publication resumable and atomic"
```

#### 完成记录与五轮熔断历史

Task 6 的 publication 状态机由 `d265a47` 建立，随后按独立复审结论逐轮修复。以下五轮熔断记录保留为审计历史；每轮存在未关闭的 Important finding 时均未把 Task 6 标记完成：

1. `d265a47..9456160`：终态竞态、live claim、聚合 marker、远端真值与持久化回滚已加固；redirect 内部 await 保护和 per-finding fallback 完整性仍未关闭，继续熔断。
2. `9456160..48f350d`：redirect hop、持久化规范化、实际 runtime callback 与 per-finding completion 已补齐；旧 `v1` partial 兼容和 response-body claim-loss 优先级仍为 Important，继续熔断。
3. `48f350d..8bc265c`：response consumption 与历史恢复继续收紧；redirect cancellation、历史 summary 子集顺序和 fallback warning 精确匹配仍未关闭，继续熔断。
4. `8bc265c..6a8ced1`：redirect cancellation 与历史 summary/fallback 主路径已修复；嵌入 inline marker、同前缀 warning 顺序仍有缺口，并发现 500 条重复正文约 5.664 秒的同步 CPU 路径，继续熔断。
5. `6a8ced1..364f3ae`：marker 角色/位置和历史 warning 歧义已关闭，重复正文降至约 31 ms；独立复审仍发现预算前 marker 正则约 12.827 秒、finding 聚合约 1.856 秒的 CPU Important，Task 6 保持阻塞。

CPU 生产修复已按补充计划 [22-publication-reconciliation-cpu-hardening-implementation-plan.md](./22-publication-reconciliation-cpu-hardening-implementation-plan.md) 实现：`3a5f60e` + `9c905ce` 在高成本处理前加入原始输入预算，`873ce7d` + `33b3393` 以单向线性 scanner 替换 marker 正则，Task 1/2 的 scoped re-review 均已批准且为 `0 open findings`。以 prerequisite `c99195a` 为基线的 fresh 验证为 Task 6 聚焦矩阵 `235/235 pass`（`235 pass / 0 fail`）、维护范围 `330/330 pass`（`330 pass / 0 fail`），platform、nine1bot、opencode 三处 typecheck 全部通过。初始 Task 3 验证/文档提交的 2 个状态 finding 已由 `3f5126009963f79e8e23c56ec45783a591522001` 修复，其 scoped re-review verdict 为 `Approved`、`0 open findings`。

broad whole-batch review 后续发现 comment 预算快照和低文本高基数 finding 聚合两个 CPU Important；`7a733c6df0a19be40c2e3168baeac972641570d8` 通过单次输入快照和 plan build 前固定 500 findings 上限关闭二者。修复后 focused `201 pass / 0 fail`、维护范围 `337 pass / 0 fail`，三处 typecheck 与 diff check 通过；scoped final re-review verdict 为 `Ready to proceed to original Task7: Yes`，Critical、Important、Minor 均为 0。

据此 CPU blocker 正式解除，Task 6 完成。`c99195a` 仅隔离 permission reply 测试的 autonomous 配置并证明 pending/reply 生命周期，不是 CPU 生产修复；该前置提交自身已通过独立复审。外部 GitLab 人工联调仍待后续执行；Task 7、Task 8、Task 9 的范围和顺序不变，下一步从 Task 7 开始。

---

### Task 7: 收紧 CI 请求配额和最终输出上限（已完成：`b0c3bf8..d18e213`）

**Files:**
- Modify: `packages/nine1bot/src/review/gitlab-ci-inspector.ts`
- Test: `packages/nine1bot/src/review/gitlab-ci-inspector.test.ts`

**Interfaces:**
- Changes: `targetForRun()` 拒绝超过 128 字符或包含空白的 `headSha`
- Changes: `boundListToolOutput()` 可返回 `ci_tool_output_limit_exceeded`
- Guarantees: 超出 job log 次数后不访问 pipeline、MR、jobs 或 trace endpoint

- [x] **Step 1: 写 40,000 字符 head SHA 和最终输出防线测试**

断言 tool 返回小型失败 DTO、最终成功 DTO 序列化严格 `< 32 KiB`、fetch 调用数为 0；恰好 32 KiB 也必须失败。

- [x] **Step 2: 写重复无效 job ID 配额测试**

`maxJobLogs=2` 时第三次调用直接返回 `ci_job_log_limit_reached`，所有 GitLab endpoint 计数不再增加。

- [x] **Step 3: 运行 RED**

Run: `bun test packages/nine1bot/src/review/gitlab-ci-inspector.test.ts`

- [x] **Step 4: token 成功解析后、首次 GitLab 请求前 reserve**

移除 trace wrapper 内的迟到 reserve。无 pipeline、无 job 和 ID 不匹配都保留本次消耗。

- [x] **Step 5: 加入 target 与最终 JSON 字节防线**

```ts
if (headSha.length > 128 || /\s/.test(headSha)) return undefined
if (toolOutputBytes(next) >= MAX_TOOL_OUTPUT_BYTES) {
  return failure('list', 'ci_tool_output_limit_exceeded')
}
```

- [x] **Step 6: 运行 GREEN 与 OpenCode tool 回归并提交**

Run: `bun test packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts`

```powershell
git add packages/nine1bot/src/review/gitlab-ci-inspector.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts
git commit -m "fix(gitlab): enforce CI request and output budgets"
```

---

### Task 8: 按完整 attempt 链裁剪 run store（已完成：`6d08086..54c3be6`）

**Files:**
- Modify: `packages/nine1bot/src/review/run-store.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`

**Interfaces:**
- Changes: `prune()` 按 `triggerKey` 组成完整链并以链为裁剪单位
- Guarantees: 任一保留记录的 `retryOf` 和 `rootRunId` 都指向 store 内记录

- [x] **Step 1: 写容量边界 retry 父记录失败测试**

limit=2 时先创建旧 rejection 与无关 run，再创建 retry；retry、父记录和 root 可达，无关旧链被删除。

- [x] **Step 2: 写单链超过软限制仍完整的测试**

limit=2、三次 attempt 时保留整链且无悬空；增加更新的独立链时只删除完整旧链。

- [x] **Step 3: 运行 RED**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts`

- [x] **Step 4: 按完整 trigger group 实施裁剪**

```ts
const groups = groupRunsByTriggerKey([...runs.values()])
groups.sort((a, b) => compareNewestFirst(a.latest, b.latest))
for (const group of groups) {
  if (keep.size === 0 || keep.size + group.records.length <= limit) {
    for (const run of group.records) keep.add(run.id)
  }
}
```

单个最新 group 超过 limit 时完整保留；其他 group 只整组保留或整组删除。

- [x] **Step 5: 运行 GREEN 并提交**

```powershell
git add packages/nine1bot/src/review/run-store.ts packages/nine1bot/src/review/gitlab-controller.test.ts
git commit -m "fix(gitlab): preserve complete review attempt chains"
```

#### 完成记录

`6d08086` 建立按完整 `triggerKey` group 裁剪，`54c3be6` 补齐已持久化旧记录的 lineage repair。每次 persistence save 进入 `prune()` 后先 repair，再执行 under-limit early return：连续的 retained suffix 以最早保留记录重新 root，并只链接仍保留的前驱；存在 gap、branch、cycle、cross-trigger 或 root 不一致的 malformed group 则保守地拆为 self-rooted、无 `retryOf` 的独立记录。

repair 只改 `rootRunId` 与 `retryOf`；ID、`triggerKey`、attempt number、时间戳/排序和其他字段保持原值。缺失祖先不重建、不合成，也不为 malformed group 推断关系。

---

### Task 9: 全量验证、文档收口与推送（已完成并由 Plan 23 继续收口）

**Files:**
- Modify: `packages/platform-gitlab/docs/review-implementation/14-live-integration-test-checklist.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/20-review-follow-up-hardening-design.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/README.md`

- [x] **Step 1: 运行全部聚焦测试**

```powershell
bun test packages/platform-gitlab/test packages/nine1bot/src/review web/test/gitlab-project-profile.test.ts opencode/packages/opencode/test/permission/next.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts --timeout 30000
```

- [x] **Step 2: 运行根测试、根 typecheck、OpenCode typecheck 与 Web build**

```powershell
bun run ci:test --timeout 30000
bun run ci:typecheck
bun run --cwd opencode/packages/opencode typecheck
bun run build:web
```

- [x] **Step 3: 运行 diff 和敏感信息检查**

```powershell
git diff --check
git status --short
git diff --name-only origin/main...HEAD
rg -n "glpat-|PRIVATE-TOKEN|Authorization:\\s*Bearer|password\\s*[:=]" packages opencode web -g '!*.test.ts' -g '!docs/**'
```

扫描只允许字段名和稳定示例，不允许真实凭证。

- [x] **Step 4: 更新文档状态与联调清单**

记录每个 Batch 的提交 SHA、测试数量和 HEAD 零发布、并发发布、部分恢复、stale binding retry 场景。外部 GitLab 未执行的项目明确写成“待人工联调”。

- [x] **Step 5: 对 `origin/main...HEAD` 做最终代码审查**

复查权限可执行性、token/日志边界、HEAD 锁定、publication claim/checkpoint、marker 分页上限、旧异步写入、run store 关系和 Web 无损保存。

- [x] **Step 6: 提交文档并推送**

```powershell
git add -f packages/platform-gitlab/docs/review-implementation/14-live-integration-test-checklist.md packages/platform-gitlab/docs/review-implementation/20-review-follow-up-hardening-design.md packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md packages/platform-gitlab/docs/review-implementation/README.md
git commit -m "docs(gitlab): record follow-up hardening verification"
git push origin HEAD:feat/gitlab-review-workflow-v2
```

`cf86409` 是上述初始验证文档 commit，并已通过普通 fast-forward push 到 `origin/feat/gitlab-review-workflow-v2`。随后由 `6dc1c7d`、`1c291de`、`ca7c3ff`、`509eb44` 关闭独立 Task 9 review 的问题，完成复审并普通推送；后续新发现的架构性遗留转由 Plan 23 继续收口。

---

## 计划自检

- 八类发现分别由 Task 1 至 Task 8 覆盖。
- Task 5 先稳定 platform publisher 协议，Task 6 再接入 run store，依赖方向单一。
- Task 3 在上下文构建前和发布前各校验一次 HEAD，覆盖 webhook 延迟和长时间 Review。
- Task 4 在 session 创建前把绑定错误转为配置型拒绝。
- Task 7 同时限制输入、请求次数和最终序列化输出。
- Task 8 把记录上限定义为跨 trigger 链软限制，优先保证审计引用完整；严格归档不在本轮范围内。
- 每个生产修改都有先失败测试、目标命令和独立提交点。

## 任务完成记录

2026-08-15 在 `54c3be6` fresh 运行：聚焦测试 `350 pass / 0 fail / 1217 expect()`（9 files），根测试 `554 pass / 0 fail / 2040 expect()`（59 files），根 typecheck、OpenCode typecheck、Web production build 均 exit 0。`git diff --check` 为 exit 0；敏感信息扫描只命中允许的稳定字段名和脱敏规则，没有凭证值。

自动化回归覆盖：Task 3 的 HEAD 缺失/变更零发布，Task 6 的并发 publication claim、checkpoint 与 partial recovery，Task 4 的 stale binding 显式 retry，Task 7 的请求配额和最终成功 DTO 严格 `< 32 KiB`，以及 Task 8 的持久化 attempt-chain repair。`origin/main...HEAD` 自审已复查权限可执行性、token/日志边界、HEAD 锁定、marker 分页上限、旧异步写入和 Web 无损保存；未发现生产代码问题，已修复文档末尾空行。

外部 self-managed GitLab 的 webhook、CI、Notes/Discussions 真实发布与恢复动作本批次均为 **待人工联调**；自动化测试不构成 live-integration 证据。

`cf86409` 已完成初始文档提交与非强制推送。其独立 Task 9 review 产生的问题由 `6dc1c7d`、`1c291de`、`ca7c3ff`、`509eb44` 修复、复审并推送；更晚发现的 specialist 资源快照、逐 POST HEAD 校验、claim 前完整预算和 profile 逐表示校验问题统一转入 Plan 23，并在那里记录最终验证结果。
