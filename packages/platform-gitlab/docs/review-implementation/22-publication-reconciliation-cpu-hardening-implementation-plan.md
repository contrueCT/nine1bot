# GitLab Review 发布对账 CPU 加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GitLab 远端评论对账进入 marker 解析、finding 聚合或历史评论重建之前建立确定性的工作上限，并移除会被未闭合 marker 前缀放大的正则扫描路径。

**Architecture:** `reconcileGitLabReviewPublicationMarkers()` 首先对原始 review 文本和去重后的远端评论正文执行 O(n) 前置计量，超限统一抛出脱敏的兼容性错误。通过前置计量后，marker 提取改为单向线性扫描；历史兼容层继续保留现有 256,000 code-unit 预算、精确 renderer round-trip 和角色校验。controller 仍把兼容性错误转换为当前 claim 的 `partial` 状态，且不得发出任何 GitLab POST。

**Tech Stack:** TypeScript、Bun test、GitLab REST API v4、Nine1Bot ReviewRun publication 状态机。

## Global Constraints

- 不引入 MCP、第三方 parser、worker thread、数据库或新的模型网络能力。
- `GitLabReviewPublicationCompatibilityError` 的对外错误值保持 `gitlab_review_publication_legacy_ambiguous`，不得包含远端正文、marker、finding、token 或 warning 细节。
- 远端评论前置预算按 notes 与 discussions 合并后的原始正文精确去重，唯一正文总量上限固定为 256,000 UTF-16 code units；重复正文不得重复计费。
- review 内容前置预算上限固定为 256,000 UTF-16 code units，计入 `runId`、`summary`、全部 warnings，以及每个 finding 的 `id`、`title`、`body`、`category`、`file`、`source` 和 `suggestion.replacement`。
- 两个前置预算必须在 `buildGitLabReviewPublicationPlan()`、`aggregateReviewFindings()`、marker 扫描、正文换行归一化和 renderer 调用之前完成；达到上限后立即停止读取后续元素。
- marker 扫描必须是单向 O(n)，每个正文字符只参与常数次比较；不得使用回溯正则，也不得从每个未闭合前缀重新扫描剩余正文。
- 保持现有 marker 安全语义：只确认完整、规范、位于末尾 marker block 且角色正确的 marker；同 run 的未知完整 marker、嵌入 marker、错误角色和错误顺序继续拒绝。
- 找不到可信远端发布状态或输入超限时继续使用现有恢复语义：当前 claim 进入 `partial`、checkpoint 不增加、GitLab POST 数为 0，并允许相同 payload 后续显式恢复。
- 保持 500 条重复的 31,250-code-unit 历史正文可去重处理，保持 500 条普通 current-format DTO 可对账。
- 所有生产代码修改严格执行 RED、GREEN、REFACTOR；每个任务独立提交。
- 不修改或提交 `.idea/` 与 `nine1bot.iml`。

## 实施与复审状态（2026-08-11）

- Task 1 已完成：实现提交 `3a5f60e`，scoped 修复提交 `9c905ce`；联合验证 `192 pass / 0 fail`，platform typecheck 通过，独立 scoped re-review 为 `0 open findings`。
- Task 2 已完成：实现提交 `873ce7d`，回归工作量校准提交 `33b3393`；platform 测试 `134 pass / 0 fail`，platform typecheck 通过，独立 scoped re-review 为 `0 open findings`。
- Task 3 prerequisite 为 `c99195a`（`test(opencode): isolate permission reply tests`）：它只隔离 permission reply 测试的 autonomous 配置并补强 pending/reply 断言，不是 CPU 生产修复。prerequisite 验证为 permission `63 pass / 0 fail`、platform-agent-source `10 pass / 0 fail`、OpenCode typecheck 通过，独立复审为 `0 findings`。
- Task 3 已完成：以 `c99195af2504041853844e295ab2082726a5b28f` 为 fresh 基线，Task 6 聚焦矩阵 `235/235 pass`（`235 pass / 0 fail`），维护范围 `330/330 pass`（`330 pass / 0 fail`），platform、nine1bot、opencode 三处 typecheck 均通过；diff/status/敏感信息扫描也已完成。
- 初始 Task 3 验证/文档提交为 `1e1602e443cb20a626e254fadd585b25d1dbcdb6`（`docs(gitlab): close publication reconciliation cpu hardening`）。独立 reviewer 对该提交给出的 2 个 Important 文档状态 finding 已由状态修复提交 `3f5126009963f79e8e23c56ec45783a591522001`（`docs(gitlab): correct cpu hardening review status`）关闭；`task-3-rereview-1.md` 的 scoped re-review verdict 为 `Approved`，`0 open findings`。
- broad whole-batch review 发现 comment 预算快照和低文本高基数 finding 聚合两个 Important；最终修复提交 `7a733c6df0a19be40c2e3168baeac972641570d8` 为全部对账输入建立单次快照，并在 plan build 前加入固定 500 findings 上限。修复后 focused 为 `201 pass / 0 fail`、维护范围为 `337 pass / 0 fail`，三处 typecheck 和 diff check 均通过；`final-rereview.md` verdict 为 `Ready to proceed to original Task7: Yes`，Critical、Important、Minor 均为 0。
- 外部 GitLab 人工联调仍未执行，原计划 Task 7、Task 8、Task 9 的范围与顺序不变，下一步从 Task 7 开始。

---

## 文件结构

### 重点修改文件

- `packages/platform-gitlab/src/review/publication-reconciliation.ts`：前置预算、线性 marker 扫描和历史兼容预算。
- `packages/platform-gitlab/test/gitlab-review.test.ts`：平台层对抗性输入、marker 语义和性能回归。
- `packages/nine1bot/src/review/gitlab-controller.test.ts`：超限时 claim 状态、checkpoint 和零 POST 集成回归。

### 文档文件

- `packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md`：解除 Task 6 的 CPU 阻塞并记录补充批次。
- `packages/platform-gitlab/docs/review-implementation/22-publication-reconciliation-cpu-hardening-implementation-plan.md`：本批次计划与完成状态。
- `packages/platform-gitlab/docs/review-implementation/README.md`：加入本计划索引。

---

### Task 1: 在所有高成本处理前建立原始输入预算

**Files:**
- Modify: `packages/platform-gitlab/src/review/publication-reconciliation.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`

**Interfaces:**
- Produces: `assertReconciliationInputBudget(input): void`，模块内私有函数。
- Produces: `RECONCILIATION_COMMENT_CODE_UNIT_BUDGET = 256_000`。
- Produces: `RECONCILIATION_REVIEW_CODE_UNIT_BUDGET = 256_000`。
- Keeps: `reconcileGitLabReviewPublicationMarkers(...)` 的参数、返回值和公开错误类型不变。

- [x] **Step 1: 写 500 条唯一超长远端正文的失败测试**

在 `packages/platform-gitlab/test/gitlab-review.test.ts` 构造 500 条不同正文，每条恰好 31,250 code units，正文包含大量未闭合的 `<!-- nine1bot:gitlab-review-publication:` 前缀。正序和逆序都必须抛出 `gitlab_review_publication_legacy_ambiguous`，并在各自 1,000 ms 内结束。保留现有 500 条重复最大正文和 500 条普通 current-format DTO 测试作为兼容门槛。

```ts
const notes = Array.from({ length: 500 }, (_, id) => ({
  id,
  body: `${PUBLICATION_MARKER_PREFIX.repeat(760)}${id}`.padEnd(31_250, 'x'),
}))
for (const corpus of [notes, [...notes].reverse()]) {
  const startedAt = performance.now()
  expect(() => reconcileGitLabReviewPublicationMarkers({ ...input, notes: corpus }))
    .toThrow('gitlab_review_publication_legacy_ambiguous')
  expect(performance.now() - startedAt).toBeLessThan(1_000)
}
```

- [x] **Step 2: 写 finding 聚合前拒绝的失败测试**

构造 500 个聚合 key 相同、`body` 各不相同且每个为 31,250 code units 的 findings。调用必须在 1,000 ms 内抛出同一个脱敏错误。另加一个带抛错 getter 的尾部 finding：前面的正文已经超过预算后，不得读取该 getter，用于确定性证明计量会立即停止，且 `buildGitLabReviewPublicationPlan()` 没有先运行。

```ts
const unread = Object.defineProperty({
  title: 'unread', body: 'unread', severity: 'info',
}, 'source', {
  get() { throw new Error('preflight_did_not_stop') },
}) as ReviewFinding
expect(() => reconcileGitLabReviewPublicationMarkers({
  ...input,
  findings: [...oversizedPrefix, unread],
})).toThrow('gitlab_review_publication_legacy_ambiguous')
```

- [x] **Step 3: 写 controller 零发布失败测试**

在 `packages/nine1bot/src/review/gitlab-controller.test.ts` 让 GET Notes 返回超出唯一正文预算的有界 corpus。断言：

```ts
expect(result).toMatchObject({
  published: false,
  error: 'gitlab_review_publication_legacy_ambiguous',
})
expect(postCalls).toHaveLength(0)
expect(ReviewRunStore.get(run.id)?.publication).toMatchObject({
  status: 'partial',
  completedMarkers: [],
})
```

- [x] **Step 4: 运行 RED**

Run:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts --timeout 30000
```

Expected: 新增对抗性测试因 marker 正则先运行或 finding 聚合先运行而超过 1,000 ms，getter 证明也会暴露错误的调用顺序。

- [x] **Step 5: 实施最小前置预算**

把预算调用放在 `reconcileGitLabReviewPublicationMarkers()` 第一条高成本语句之前：

```ts
assertReconciliationInputBudget(input)
const plan = buildGitLabReviewPublicationPlan({ runId: input.runId, findings: input.findings })
```

评论预算使用 notes 与 discussions 共用的 `Set<string>`，只累计首次出现的原始 `body.length`。review 预算按固定字段顺序累计字符串长度；每次加法后立即比较上限并抛出 `GitLabReviewPublicationCompatibilityError`。不得序列化整个输入，也不得为了计量复制正文。

- [x] **Step 6: 运行 GREEN、完整平台回归并提交**

Run:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts --timeout 30000
bun run --cwd packages/platform-gitlab typecheck
```

Commit:

```powershell
git add packages/platform-gitlab/src/review/publication-reconciliation.ts packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts
git commit -m "fix(gitlab): preflight publication reconciliation input"
```

---

### Task 2: 用确定性线性扫描器替换 marker 正则

**Files:**
- Modify: `packages/platform-gitlab/src/review/publication-reconciliation.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`

**Interfaces:**
- Produces: `scanPublicationMarkerCandidates(body, catalog)`，模块内私有线性扫描函数。
- Removes: `PUBLICATION_MARKER_PATTERN` 和基于 `String.matchAll()` 的扫描。
- Keeps: `extractMarkerBody()`、`validateMarkerBody()` 和 trailing marker block 的外部行为。

- [x] **Step 1: 写单正文未闭合前缀放大回归**

构造一个不超过 31,250 code units 的正文，同一行放入 760 个未闭合 marker 前缀，并在末尾放置一个终止符。测试重复执行该输入 20 次，总耗时必须小于 500 ms；结果必须与旧 parser 语义一致，不能把被前面未闭合候选吞入的尾部文本误认成规范 marker。

- [x] **Step 2: 写 marker 角色与位置矩阵回归**

对 summary、per-finding fallback、base-era fallback、inline 四类 marker 分别覆盖：正文中嵌入、末尾前有非空字符、同一行重复、note/discussion 错误角色、同 run 未知完整 marker。全部抛出脱敏错误。规范 summary note、fallback note、inline discussion 继续返回对应 marker。

- [x] **Step 3: 运行 RED**

Run:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts --timeout 30000
```

Expected: 性能回归在旧的 greedy marker 正则路径上失败；现有语义测试保持为 scanner 的不可回退基线。

- [x] **Step 4: 实施单向扫描**

从 `cursor` 开始用 `indexOf(PUBLICATION_MARKER_PREFIX, cursor)` 定位下一个候选起点，然后只向前扫描到本行第一个 `>`、`\r`、`\n` 或正文末尾：

```ts
while (cursor < body.length) {
  const start = body.indexOf(PUBLICATION_MARKER_PREFIX, cursor)
  if (start < 0) break
  let end = start + PUBLICATION_MARKER_PREFIX.length
  while (end < body.length && body[end] !== '>' && body[end] !== '\r' && body[end] !== '\n') {
    end += 1
  }
  if (body[end] === '>' && body[end - 1] === '-' && body[end - 2] === '-') {
    inspectCandidate(body.slice(start, end + 1), start, catalog)
  }
  cursor = end < body.length ? end + 1 : body.length
}
```

同一段中更晚出现的嵌套前缀不能触发从该位置到行尾的再次扫描。完整候选仍使用 `expectedMarkers` 和 `publicationMarkerRunId()` 判定；目标 run 的未知完整候选继续拒绝，其他 run 的候选继续忽略。最后继续由 `extractTrailingMarkerBlock()` 校验完整 marker block、空行分隔、顺序和精确位置。

- [x] **Step 5: 运行 GREEN、平台测试与 typecheck**

Run:

```powershell
bun test packages/platform-gitlab/test --timeout 30000
bun run --cwd packages/platform-gitlab typecheck
```

- [x] **Step 6: 检查复杂度和提交**

确认 scanner 没有在候选循环内对剩余全文调用 `matchAll()`、无界 `indexOf('-->')`、`slice(cursor)` 或新的 marker 正则。随后提交：

```powershell
git add packages/platform-gitlab/src/review/publication-reconciliation.ts packages/platform-gitlab/test/gitlab-review.test.ts
git commit -m "fix(gitlab): scan publication markers linearly"
```

---

### Task 3: 完整验证、独立复审并解除原 Task 6 阻塞

**Files:**
- Modify: `packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/22-publication-reconciliation-cpu-hardening-implementation-plan.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/README.md`

**Interfaces:**
- Guarantees: 原计划 Task 6 只有在本批次全量验证和独立复审均通过后才标记完成。
- Guarantees: 原计划 Task 7、Task 8、Task 9 的范围和顺序不变。

- [x] **Step 1: 运行 Task 6 聚焦矩阵**

```powershell
bun test packages/platform-gitlab/test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
```

必须覆盖 marker 角色/位置、历史 fallback/summary 精确恢复、claim ownership、partial resume、分页/重定向/响应上限、超限 corpus 零 POST 和 current-format 兼容。

- [x] **Step 2: 运行维护范围测试与三处 typecheck**

```powershell
bun test packages/platform-gitlab/test packages/nine1bot/src/review web/test/gitlab-project-profile.test.ts opencode/packages/opencode/test/permission/next.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts --timeout 30000
bun run --cwd packages/platform-gitlab typecheck
bun run --cwd packages/nine1bot typecheck
bun run --cwd opencode/packages/opencode typecheck
```

- [x] **Step 3: 运行静态与敏感信息检查**

```powershell
git diff --check
git status --short
rg -n "glpat-|PRIVATE-TOKEN|Authorization:\\s*Bearer|password\\s*[:=]" packages opencode web -g "!*.test.ts" -g "!docs/**"
```

扫描结果只允许稳定字段名或脱敏示例，不允许真实凭证、远端正文或测试密码进入提交。

- [x] **Step 4: 由独立 reviewer 审查本批次**

reviewer 必须复查：前置预算调用顺序、重复正文只计费一次、所有 finding 文本字段计费、达到预算立即停止、scanner 单向复杂度、marker 角色与位置语义、错误脱敏、claim partial 和零 POST。Critical 或 Important finding 必须修复并进行 scoped re-review。

初始提交 `1e1602e443cb20a626e254fadd585b25d1dbcdb6` 的 2 个文档状态 Important finding 已由 `3f5126009963f79e8e23c56ec45783a591522001` 修复；随后 scoped re-review verdict 为 `Approved`，`0 open findings`。

broad whole-batch review 随后提出 2 个 CPU Important，已由 `7a733c6df0a19be40c2e3168baeac972641570d8` 关闭；唯一一次 scoped final re-review 结论为 `Ready to proceed to original Task7: Yes`，`0 open findings`。

- [x] **Step 5: 更新文档状态并提交**

本文件已记录 Task 1 到 Task 3、broad review 最终修复的提交 SHA、测试数量和真实复审结论；原计划 Task 6 已记录本批次链接并依据通过的 scoped final re-review 解除 CPU blocker。README 索引已由初始文档提交加入，本轮状态最终化不改 README。

```powershell
git add packages/platform-gitlab/docs/review-implementation/21-review-follow-up-hardening-implementation-plan.md packages/platform-gitlab/docs/review-implementation/22-publication-reconciliation-cpu-hardening-implementation-plan.md packages/platform-gitlab/docs/review-implementation/README.md
git commit -m "docs(gitlab): close publication reconciliation cpu hardening"
```

- [x] **Step 6: 恢复原计划**

scoped final re-review 已通过且 broad review open findings 为 0，CPU blocker 已解除；回到 `21-review-follow-up-hardening-implementation-plan.md`，下一步从 Task 7“收紧 CI 请求配额和最终输出上限”开始。本批次未提前实现 Task 7、Task 8 或 Task 9，其范围和顺序保持不变。
