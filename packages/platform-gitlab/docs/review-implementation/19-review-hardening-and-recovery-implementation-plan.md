# GitLab Review 安全加固与可恢复执行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 GitLab Review 已确认的八项安全与稳定性问题，可信支持 source、merged-results 和 merge-train CI，并让配置型拒绝在修复后通过新 attempt 显式恢复。

**Architecture:** `platform-gitlab` 负责受限 GitLab REST、运行时 DTO、CI 可信校验、日志脱敏和配置诊断；`nine1bot` 负责 run attempt、session/generation 隔离和重试恢复；OpenCode 负责显式工具可见性与 monitor 生命周期；Web 负责无损 profile 编辑。所有 CI 证据继续按需读取，失败只返回有界诊断，不阻断 Review 发布。

**Tech Stack:** TypeScript、Bun test、Vue 3、OpenCode ToolRegistry/SessionPrompt、Nine1Bot ReviewRun 文件存储、GitLab REST API v4。

## Global Constraints

- 不引入 MCP，不允许模型运行 GitLab CLI、`curl`、`webfetch`、shell 或任意未显式授权工具。
- `PRIVATE-TOKEN` 只能发送到初始 GitLab authority，同 authority 重定向最多 3 次。
- pipeline 候选最多 50 条，job 最多返回 100 条，CI list 最多 32 KiB。
- 每个 run 最多读取 10 份 job log，默认 3 份；单份最多 16 KiB，默认 8 KiB。
- CI 不可用、无可信 pipeline 或日志不可读均不阻断 Review 发布。
- 重试创建新 attempt，原 run 不覆盖；异步更新必须同时匹配 run、session 和 generation。
- 每项行为修改使用 TDD：先运行目标失败测试，再做最小实现，再跑对应层回归。
- 每个任务独立提交，不修改或提交无关的 `.idea/` 与 `nine1bot.iml`。

---

## 文件结构

### 新建文件

- `opencode/packages/opencode/src/tool/selection.ts`：纯函数形式的显式工具可见性规则。
- `web/src/lib/gitlab-project-profile-document.ts`：保留原始 profile 条目和逐条诊断的编辑文档模型。

### 重点修改文件

- `packages/platform-gitlab/src/review/api-client.ts`：手动安全重定向、AbortSignal、MR/pipeline/commit 元数据读取和响应投影。
- `packages/platform-gitlab/src/review/ci-inspector.ts`：可信 pipeline 选择、有界 job DTO 和日志脱敏。
- `packages/platform-gitlab/src/review/settings.ts`：原始 profile 配置诊断和服务端硬上限。
- `packages/platform-gitlab/src/review/diff-slicer.ts`：hunk 状态内的增删行分类。
- `packages/platform-gitlab/src/runtime.ts`：无可用 profile 时的 degraded 状态和保存校验。
- `packages/nine1bot/src/review/run-store.ts`：attempt 关系、generation 和条件更新。
- `packages/nine1bot/src/review/gitlab-controller.ts`：配置拒绝分类、重试重建和新 attempt。
- `packages/nine1bot/src/review/gitlab-ci-inspector.ts`：活动 attempt 校验、AbortSignal 和 stale 写入保护。
- `opencode/packages/opencode/src/session/prompt.ts`：显式 opt-in 工具过滤。
- `opencode/packages/opencode/src/server/routes/automated-controller.ts`：monitor 先订阅后发送。
- `opencode/packages/opencode/src/server/routes/webhooks.ts`：GitLab 自动化 allowlist 和新 attempt retry。
- `web/src/components/PlatformManager.vue`：profile 诊断展示与错误时阻止保存。

---

### Task 1: GitLab API 安全重定向与 Abort 传播

**Files:**
- Modify: `packages/platform-gitlab/src/review/api-client.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`

**Interfaces:**
- Produces: `GitLabRequestOptions = { signal?: AbortSignal }`
- Produces: `GitLabApiRedirectError`，其 `code` 为 `gitlab_redirect_invalid`、`gitlab_redirect_cross_authority` 或 `gitlab_redirect_limit_exceeded`
- Keeps: 所有现有调用在不传 options 时兼容

- [x] **Step 1: 写跨 authority token 泄漏失败测试**

使用两个本地 Bun server。server A 返回 302 到 server B，两个 server 都记录 `PRIVATE-TOKEN`。断言调用失败且 B 从未收到请求：

```ts
await expect(client.getMergeRequestPipelines(3, 2)).rejects.toMatchObject({
  code: 'gitlab_redirect_cross_authority',
})
expect(secondServerHeaders).toEqual([])
```

- [x] **Step 2: 写同 authority、循环重定向和 abort 测试**

覆盖相对 `Location`、同 host 绝对 URL、第四次跳转、调用前 abort 和跳转期间 abort。AbortSignal 必须到达每次 fetch。

- [x] **Step 3: 运行测试并确认失败**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "redirect|AbortSignal"`

Expected: 跨 authority 请求实际到达第二个 server，或新 error/options 尚不存在。

- [x] **Step 4: 实现手动重定向**

```ts
export type GitLabRequestOptions = { signal?: AbortSignal }

export class GitLabApiRedirectError extends Error {
  constructor(readonly code: GitLabApiRedirectErrorCode) {
    super(code)
    this.name = 'GitLabApiRedirectError'
  }
}
```

`withRequest()` 设置 `redirect: 'manual'`，解析 301、302、303、307、308，仅跟随相同标准化 authority，最多 3 次。错误不得包含 token 或完整重定向 URL。

- [x] **Step 5: 给读取接口增加可选 options**

```ts
getMergeRequestPipelines(projectId, mrIid, options: GitLabRequestOptions = {})
getPipelineJobs(projectId, pipelineId, options: GitLabRequestOptions = {})
getJobTrace(projectId, jobId, maxBytes?, options: GitLabRequestOptions = {})
```

把 `options.signal` 合并进现有 timeout controller。

- [x] **Step 6: 运行平台层回归**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts`

Run: `bun run --cwd packages/platform-gitlab typecheck`

Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add packages/platform-gitlab/src/review/api-client.ts packages/platform-gitlab/test/gitlab-review.test.ts
git commit -m "fix(gitlab): contain token-bearing redirects"
```

---

### Task 2: CI DTO、输出硬上限与日志脱敏

**Files:**
- Modify: `packages/platform-gitlab/src/review/api-client.ts`
- Modify: `packages/platform-gitlab/src/review/ci-inspector.ts`
- Modify: `packages/nine1bot/src/review/gitlab-ci-inspector.ts`
- Modify: `opencode/packages/opencode/src/tool/gitlab-ci-inspect.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`
- Test: `packages/nine1bot/src/review/gitlab-ci-inspector.test.ts`
- Test: `opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts`

**Interfaces:**
- Produces: `GitLabCiPipeline` 和 `GitLabCiJob` 运行时 DTO
- Produces: `GitLabCiListResult.truncated`、`totalJobs`、`returnedJobs`
- Produces: `clampGitLabCiLimits(profile)`，硬上限为 10 logs、16 KiB/log

- [x] **Step 1: 写原始字段泄漏与 list 超限失败测试**

API fixture 注入 `runner`、`user`、`commit`、`variables` 和额外嵌套字段，构造 101 个大 job。断言 tool JSON 不包含这些字段、最多 100 个 job、序列化不超过 32 KiB，并包含 `ci_jobs_truncated`。

- [x] **Step 2: 写服务端硬上限失败测试**

配置 `maxJobLogs: 1_000_000_000`、`maxJobLogBytes: 1_000_000_000`，断言有效值仍分别为 10 和 16_384。

- [x] **Step 3: 写日志秘密样本失败测试**

```ts
const trace = [
  'PASSWORD=correct horse battery staple',
  'DATABASE_URL=postgres://user:password@db/app',
  'AWS_SECRET_ACCESS_KEY=AKIAEXAMPLEVALUE',
  'eyJhbGciOiJIUzI1NiJ9.payload.signature',
  '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
].join('\n')
expect(sanitizeGitLabCiTrace(trace)).not.toMatch(/battery|password@|AKIAEXAMPLE|payload|PRIVATE KEY/)
```

- [x] **Step 4: 运行目标测试并确认失败**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts -t "projects CI DTO|bounds CI list|sanitizes CI trace|hard CI limits"`

- [x] **Step 5: 实现运行时投影和有界 list**

API client 对 pipeline/job 建立新对象，只复制文档允许字段。`ci-inspector.ts` 再投影成 camelCase tool DTO；稳定排序后先按 100 条截断，再按 32 KiB 预算逐条装入。

```ts
export type GitLabCiListResult = {
  pipeline?: GitLabCiPipeline
  jobs: GitLabCiJob[]
  diagnostics: string[]
  truncated: boolean
  totalJobs: number
  returnedJobs: number
}
```

- [x] **Step 6: 实现分层脱敏和限制 clamp**

按 ANSI、PEM block、Authorization、credential URL、secret assignment、JWT-like、access-key pattern 顺序替换。截断基于脱敏后的 UTF-8，同时用原始/脱敏长度决定 `truncated`。

- [x] **Step 7: 让 tool 始终返回自有截断元数据并传递 abort**

依赖签名调整为：

```ts
inspect(sessionId: string, request: GitLabCiSessionRequest, signal: AbortSignal): Promise<GitLabCiToolOutput>
```

list 和 log 都设置 `metadata.truncated`，但 output 必须已经在服务端受限，不产生完整输出文件。

- [x] **Step 8: 运行三层回归并提交**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts`

Run: `bun run --cwd packages/platform-gitlab typecheck`

```bash
git add packages/platform-gitlab/src/review/api-client.ts packages/platform-gitlab/src/review/ci-inspector.ts packages/nine1bot/src/review/gitlab-ci-inspector.ts opencode/packages/opencode/src/tool/gitlab-ci-inspect.ts packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts
git commit -m "fix(gitlab): bound CI evidence output"
```

---

### Task 3: 自动 Review 工具真正 deny-by-default

**Files:**
- Create: `opencode/packages/opencode/src/tool/selection.ts`
- Modify: `opencode/packages/opencode/src/tool/tool.ts`
- Modify: `opencode/packages/opencode/src/tool/registry.ts`
- Modify: `opencode/packages/opencode/src/session/prompt.ts`
- Modify: `opencode/packages/opencode/src/server/routes/webhooks.ts`
- Modify: `packages/platform-gitlab/agents/review/pm-coordinator.agent.md`
- Modify: `packages/platform-gitlab/agents/review/developer.agent.md`
- Modify: `packages/platform-gitlab/agents/review/frontend-designer.agent.md`
- Modify: `packages/platform-gitlab/agents/review/risk-qa.agent.md`
- Modify: `packages/platform-gitlab/agents/review/security-agent.agent.md`
- Modify: `packages/platform-gitlab/agents/review/spec-writer.agent.md`
- Modify: `packages/platform-gitlab/agents/review/tech-architect.agent.md`
- Test: `opencode/packages/opencode/test/tool/registry.test.ts`
- Test: `opencode/packages/opencode/test/server/webhooks-status.test.ts`
- Test: `opencode/packages/opencode/test/agent/platform-agent-source.test.ts`

**Interfaces:**
- Produces: `Tool.Info.requireExplicitEnable?: boolean`
- Produces: `toolSelectionAllows(tool, requestedTools)`
- Keeps: 普通工具未声明 opt-in 时保持现有行为

- [x] **Step 1: 写实际工具表失败测试**

断言普通 session 未显式启用时不暴露 `gitlab_ci_inspect`；MR Review PM 只可见 `gitlab_ci_inspect` 和 `task`；commit Review 不可见 CI；specialist agent 的所有 registry 工具均被 deny。

- [x] **Step 2: 运行测试并确认失败**

Run: `bun test opencode/packages/opencode/test/tool/registry.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts`

- [x] **Step 3: 实现显式 opt-in 工具元数据**

```ts
export function toolSelectionAllows(
  tool: { id: string; requireExplicitEnable?: boolean },
  requested: Record<string, boolean> | undefined,
) {
  if (requested?.[tool.id] === false) return false
  if (tool.requireExplicitEnable) return requested?.[tool.id] === true
  return requested?.['*'] !== false
}
```

`GitLabCiInspectTool` 标记 `requireExplicitEnable: true`；`SessionPrompt.resolveTools` 在初始化和加入模型工具表前调用该函数。

- [x] **Step 4: 收紧 PM 和 specialist 权限**

PM frontmatter 以 `"*": deny` 开始，再只允许 `gitlab_ci_inspect` 和 `task: platform.gitlab.*`。所有 specialist 使用 `"*": deny`。MR runtime tools 返回 `{ '*': false, task: true, gitlab_ci_inspect: true }`，commit 返回 `{ '*': false, task: true, gitlab_ci_inspect: false }`。

- [x] **Step 5: 运行 OpenCode 测试与类型检查并提交**

Run: `bun test opencode/packages/opencode/test/tool/registry.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts`

Run: `bun run --cwd opencode/packages/opencode typecheck`

```bash
git add opencode/packages/opencode/src/tool/selection.ts opencode/packages/opencode/src/tool/tool.ts opencode/packages/opencode/src/tool/registry.ts opencode/packages/opencode/src/session/prompt.ts opencode/packages/opencode/src/server/routes/webhooks.ts opencode/packages/opencode/test/tool/registry.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts packages/platform-gitlab/agents/review
git commit -m "fix(gitlab): isolate automated review tools"
```

---

### Task 4: 修复 diff 中 `+++` 与 `---` 源码行映射

**Files:**
- Modify: `packages/platform-gitlab/src/review/diff-slicer.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`

**Interfaces:**
- Keeps: 现有 slice/render API 不变
- Produces: hunk 内首字符驱动的 old/new line map

- [x] **Step 1: 写双向失败测试**

构造包含 `+ ++counter` 对应 unified diff `+++counter`、以及删除源码 `--value` 对应 `---value` 的两个 hunk。断言该行分别只有 `newLine` 或 `oldLine`，后续 context 行行号不偏移。

- [x] **Step 2: 运行测试并确认失败**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "maps source lines beginning with plus|maps source lines beginning with minus"`

- [x] **Step 3: 实现 hunk 状态解析**

只在 `outside-hunk` 识别文件头；进入 `@@` 后，按第一个字符推进 old/new counter，`\\ No newline at end of file` 不推进。

- [x] **Step 4: 运行平台回归并提交**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts`

```bash
git add packages/platform-gitlab/src/review/diff-slicer.ts packages/platform-gitlab/test/gitlab-review.test.ts
git commit -m "fix(gitlab): preserve prefixed diff line mapping"
```

---

### Task 5: Monitor 在首消息前订阅

**Files:**
- Modify: `opencode/packages/opencode/src/server/routes/automated-controller.ts`
- Test: `opencode/packages/opencode/test/server/automated-controller.test.ts`

**Interfaces:**
- Produces: `AutomatedRunMonitor = { finish(status, error?): Promise<void>; dispose(): void }`
- Keeps: `runAutomatedControllerSession()` 返回结构不变

- [x] **Step 1: 写快速 idle 与发送失败测试**

在 `sendMessage` 内同步发布当前 session 的 `session.idle`，断言 `onFinished` 收到一次 succeeded。再让 send 抛错，断言订阅与 timeout 被释放，`onFinished` 只调用一次。

- [x] **Step 2: 运行测试并确认失败**

Run: `bun test opencode/packages/opencode/test/server/automated-controller.test.ts`

- [x] **Step 3: 重排启动顺序并统一 finish**

顺序固定为 create session、`onSessionCreated`、`startAutomatedRunMonitor`、send message。monitor 的 `finish()` 幂等执行清理和 callback；`dispose()` 只清理，不伪造成功。

- [x] **Step 4: 运行 OpenCode 回归并提交**

Run: `bun test opencode/packages/opencode/test/server/automated-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`

```bash
git add opencode/packages/opencode/src/server/routes/automated-controller.ts opencode/packages/opencode/test/server/automated-controller.test.ts
git commit -m "fix(runtime): observe automated runs before send"
```

---

### Task 6: 后端 profile 原始诊断与健康状态

**Files:**
- Modify: `packages/platform-gitlab/src/review/settings.ts`
- Modify: `packages/platform-gitlab/src/runtime.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`
- Test: `packages/platform-gitlab/test/gitlab-platform.test.ts`

**Interfaces:**
- Produces: `parseGitLabReviewProjectProfiles(input): { profiles; errors }`
- Produces: `hasUsableGitLabReviewProjectProfile(settings): boolean`
- Keeps: `normalizeGitLabReviewSettings()` 返回 `GitLabReviewSettings`

- [x] **Step 1: 写 malformed 与全无效 profile 失败测试**

覆盖非数组、非对象、缺失 ID/projectId、非法 host、重复 ID、重复 identity、非法 CI 数值，以及 Review 启用但没有 enabled+bound profile。每条错误包含 index 或 profile ID。

- [x] **Step 2: 写 runtime degraded 失败测试**

token 已配置但全部 profile 无效/禁用时，`getStatus` 必须为 degraded，`validateConfig` 必须给出 `review.projects` 错误。

- [x] **Step 3: 运行测试并确认失败**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/platform-gitlab/test/gitlab-platform.test.ts -t "profile diagnostics|usable project profile"`

- [x] **Step 4: 分离解析与校验**

遍历原始数组时同时收集 errors；合法 profile 才进入运行时 `profiles`，但任何被跳过条目都有稳定诊断。对 `maxJobLogs` 和 `maxJobLogBytes` 同时报告非法值并使用安全默认值。

- [x] **Step 5: 接入 status 与 config validation**

Review enabled 时要求至少一个 enabled、identity 唯一、已绑定的 profile；否则 status 为 degraded，保存校验失败。

- [x] **Step 6: 运行平台包回归并提交**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/platform-gitlab/test/gitlab-platform.test.ts`

Run: `bun run --cwd packages/platform-gitlab typecheck`

```bash
git add packages/platform-gitlab/src/review/settings.ts packages/platform-gitlab/src/runtime.ts packages/platform-gitlab/test/gitlab-review.test.ts packages/platform-gitlab/test/gitlab-platform.test.ts
git commit -m "fix(gitlab): report invalid review profiles"
```

---

### Task 7: Web profile 无损编辑与错误阻止保存

**Files:**
- Create: `web/src/lib/gitlab-project-profile-document.ts`
- Modify: `web/src/lib/gitlab-project-profiles.ts`
- Modify: `web/src/components/PlatformManager.vue`
- Test: `web/test/gitlab-project-profile.test.ts`

**Interfaces:**
- Produces: `parseGitLabProjectProfileDocument(input): GitLabProjectProfileDocument`
- Produces: `validateGitLabProjectProfileDocument(document): GitLabProjectProfileDiagnostic[]`
- Produces: `serializeGitLabProjectProfileDocument(document)`，仅在 diagnostics 为空时成功

- [x] **Step 1: 写 parse-edit-save 数据保留失败测试**

输入 duplicate ID、duplicate identity、malformed object 和合法 profile 混合数组。断言 parse 后 entry 数量不变；修改合法项不删除其余条目；错误存在时 serialize 返回失败而不是缩水 JSON。

- [x] **Step 2: 写合法 round-trip 测试**

合法 profile 经 parse、edit、serialize、reload 后字段完全一致，legacy CI 字段只在无错误时迁移为 canonical 名称。

- [x] **Step 3: 运行测试并确认失败**

Run: `bun test web/test/gitlab-project-profile.test.ts`

- [x] **Step 4: 实现 document 模型并接入 UI**

document 保存原始 entries、可编辑合法 view 和 index 对应关系。`PlatformManager.vue` 显示逐条错误；错误存在时禁用保存动作并保留表单原始文本。

- [x] **Step 5: 运行 Web 测试、类型检查和构建并提交**

Run: `bun test web/test/gitlab-project-profile.test.ts`

Run: `bun run build:web`

```bash
git add web/src/lib/gitlab-project-profile-document.ts web/src/lib/gitlab-project-profiles.ts web/src/components/PlatformManager.vue web/test/gitlab-project-profile.test.ts
git commit -m "fix(web): preserve invalid GitLab profiles"
```

---

### Task 8: ReviewRun attempt 与条件更新模型

**Files:**
- Modify: `packages/nine1bot/src/review/run-store.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`

**Interfaces:**
- Produces: `ReviewRunRecord.rootRunId`、`attempt`、`retryOf`、`triggerKey`、`generation`、`rejectionKind`、`recoverable`
- Produces: `ReviewRunStore.findLatestByTriggerKey(triggerKey)`
- Produces: `ReviewRunStore.updateIfCurrent(identity, patch)`
- Produces: `ReviewRunStore.createRetryAttempt(previous, input)`

- [x] **Step 1: 写新记录、旧记录兼容和 attempt 链失败测试**

首个 run 自动得到 `rootRunId === id`、`attempt === 1` 和非空 generation。加载旧 store 文件时补齐兼容默认值。连续重试得到 attempt 2/3，并保持 `retryOf` 链。

- [x] **Step 2: 写条件更新与并发创建失败测试**

旧 session、旧 generation 或非最新 attempt 的 `updateIfCurrent` 返回 false 且不修改记录；同一 latest attempt 只能成功创建一个 retry。

- [x] **Step 3: 运行测试并确认失败**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts -t "attempt|generation|conditional review update"`

- [x] **Step 4: 实现模型与 store 原子边界**

```ts
export type ReviewRunIdentity = {
  runId: string
  sessionId?: string
  generation: string
}
```

所有 store 操作在单次同步 load/mutate/save 中完成；`create()` 在生成 ID 后填充 rootRunId。文件 `version` 升级并兼容 version 1。

- [x] **Step 5: 运行 Nine1Bot 回归并提交**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts`

```bash
git add packages/nine1bot/src/review/run-store.ts packages/nine1bot/src/review/gitlab-controller.test.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts
git commit -m "feat(gitlab): model review attempts explicitly"
```

---

### Task 9: 配置拒绝显式恢复为新 attempt

**Files:**
- Modify: `packages/nine1bot/src/review/gitlab-controller.ts`
- Modify: `opencode/packages/opencode/src/server/routes/webhooks.ts`
- Test: `packages/nine1bot/src/review/gitlab-controller.test.ts`
- Test: `opencode/packages/opencode/test/server/webhooks-status.test.ts`

**Interfaces:**
- Produces: `retryGitLabReviewAttempt(input): Promise<GitLabReviewWebhookResult>`
- Produces: `isRecoverableGitLabReviewRejection(error): boolean`
- Removes: 原地修改同一 run 的 `gitLabReviewRetryPatch`

- [x] **Step 1: 写配置修复后 retry 失败测试**

先以 `project_profile_missing` 创建 rejected run，再提供修复后的 profile 调用 retry。断言返回新 runId、`attempt: 2`、`retryOf` 指向原 run，重新请求 MR changes 并生成新 context；原 run 仍为 rejected。

- [x] **Step 2: 写不可恢复、仍未修复和并发 retry 测试**

payload/auth/policy 拒绝返回 409/400；配置仍无效不创建 attempt；两个并发请求只有一个创建 attempt 2；活动或已发布 latest attempt 返回 409。

- [x] **Step 3: 运行测试并确认失败**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts -t "retry.*attempt|recoverable rejection"`

- [x] **Step 4: 提取 trigger-based context rebuild**

把 webhook 已解析后的 profile resolve、changes load 和 context build 抽为可由首次 webhook与 retry 共享的函数。retry 只复用冻结 trigger identity，不复用旧 project snapshot/context。

- [x] **Step 5: 路由启动新 run**

OpenCode retry endpoint 调用 `retryGitLabReviewAttempt`，然后把新 run/context 传给 `startGitLabReviewRuntimeRun`。响应同时返回 `runId`、`retryOf` 和 `attempt`。

- [x] **Step 6: 运行 controller/runtime 回归并提交**

Run: `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`

```bash
git add packages/nine1bot/src/review/gitlab-controller.ts opencode/packages/opencode/src/server/routes/webhooks.ts packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts
git commit -m "feat(gitlab): retry rejected reviews as attempts"
```

---

### Task 10: 可信选择 source、merged-results 与 merge-train CI

**Files:**
- Modify: `packages/platform-gitlab/src/review/api-client.ts`
- Modify: `packages/platform-gitlab/src/review/ci-inspector.ts`
- Modify: `packages/platform-gitlab/src/review/index.ts`
- Test: `packages/platform-gitlab/test/gitlab-review.test.ts`

**Interfaces:**
- Produces: `getMergeRequest(projectId, mrIid, options)`
- Produces: `getPipeline(projectId, pipelineId, options)`
- Produces: `getCommit(projectId, sha, options)`
- Produces: `selectTrustedGitLabCiPipeline(input): Promise<GitLabCiPipelineSelection>`
- Produces: `GitLabCiPipeline.kind = 'source' | 'detached' | 'merged_result' | 'merge_train' | 'integrated'`

- [x] **Step 1: 写候选矩阵失败测试**

表驱动覆盖：source SHA 精确匹配、detached MR pipeline、merged result 临时提交父节点包含 head、merge train 临时提交包含 head、旧 head、来自错误 MR 的伪候选、ref 看似正确但父节点不含 head、commit metadata 404。

- [x] **Step 2: 写选择优先级和 50 条上限测试**

同一 MR 同时有 source 与 integrated pipeline 时优先 integrated；同层 ID 最大优先；只读取前 50 个受控候选；不得请求项目 latest pipelines endpoint。

- [x] **Step 3: 运行测试并确认失败**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "trusted GitLab CI pipeline|integrated pipeline"`

- [x] **Step 4: 实现元数据 DTO 与候选校验**

MR pipelines 列表和同次 MR 详情 `head_pipeline` 合并去重。SHA 等于 `diff_refs.head_sha` 直接可信；临时 SHA 必须同时满足当前 MR endpoint 归属、`source === 'merge_request_event'`、commit `parent_ids` 包含 head。ref/事件类型仅分类，不单独建立信任。

- [x] **Step 5: 返回稳定非阻断诊断**

无候选为 `ci_pipeline_not_found_for_current_mr`；有候选但无可信结果为 `ci_pipeline_unverified_for_current_head`；元数据请求失败为 `ci_pipeline_metadata_unavailable:<ErrorName>`。

- [x] **Step 6: 运行平台层回归并提交**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts`

Run: `bun run --cwd packages/platform-gitlab typecheck`

```bash
git add packages/platform-gitlab/src/review/api-client.ts packages/platform-gitlab/src/review/ci-inspector.ts packages/platform-gitlab/src/review/index.ts packages/platform-gitlab/test/gitlab-review.test.ts
git commit -m "feat(gitlab): verify MR pipeline provenance"
```

---

### Task 11: CI 查询生命周期与 stale attempt 隔离

**Files:**
- Modify: `packages/nine1bot/src/review/gitlab-ci-inspector.ts`
- Modify: `opencode/packages/opencode/src/tool/gitlab-ci-inspect.ts`
- Test: `packages/nine1bot/src/review/gitlab-ci-inspector.test.ts`
- Test: `opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts`

**Interfaces:**
- Consumes: Task 8 `ReviewRunStore.updateIfCurrent`
- Consumes: Task 10 `selectTrustedGitLabCiPipeline`
- Produces: `ci_review_attempt_stale`、`ci_review_run_not_active`、`ci_request_aborted`

- [x] **Step 1: 写 terminal run 与 abort 失败测试**

status 为 succeeded/failed/rejected/blocked 时不得发 fetch。查询中 abort 后返回 `ci_request_aborted`，不更新 queryCount、pipeline 或新 attempt。

- [x] **Step 2: 写 deferred fetch + retry 竞争失败测试**

旧 attempt 发起 list，fetch 尚未完成时创建 attempt 2 并绑定新 session；释放旧 fetch 后断言 attempt 2 无旧 pipeline/diagnostic，attempt 1 也不产生 terminal 后写入。

- [x] **Step 3: 写日志额度条件 reserve 测试**

真正发出 trace 前 stale 则不消耗额度；已经发出 trace 后 stale 保留旧 attempt 审计计数，但不能写入新 attempt。

- [x] **Step 4: 运行测试并确认失败**

Run: `bun test packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts -t "active attempt|stale attempt|aborted CI"`

- [x] **Step 5: 捕获 identity 并在每个 await 后条件校验**

查询开始保存 `{ runId, sessionId, generation }`。token resolve、pipeline list、commit metadata、jobs 和 trace 每次 await 后调用 store 条件判断；失败立即返回，不再持久化。

- [x] **Step 6: 贯穿 Tool.Context.abort 并规范错误**

wrapper 把 signal 传给 session inspector；AbortError 和 signal.reason 统一映射为 `ci_request_aborted`，公开结果不包含原始异常正文。

- [x] **Step 7: 运行 CI inspector 回归并提交**

Run: `bun test packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts`

```bash
git add packages/nine1bot/src/review/gitlab-ci-inspector.ts opencode/packages/opencode/src/tool/gitlab-ci-inspect.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts
git commit -m "fix(gitlab): isolate CI queries by review attempt"
```

---

## 已完成实施批次

| Batch | 范围 | 提交 | 状态 |
| --- | --- | --- | --- |
| 0 | 产品边界与实施计划 | `e282aaa`、`c507c7a` | 已完成 |
| 1 | Token 重定向隔离、CI DTO/日志有界化与脱敏 | `22afe29`、`0464eb4` | 已完成 |
| 2 | 自动 Review 工具白名单、diff 行号、monitor 时序 | `e83feeb`、`e6b807c`、`554fccd` | 已完成 |
| 3 | 后端 profile 诊断与前端无损编辑 | `00d2a72`、`a2ae986` | 已完成 |
| 4 | ReviewRun attempt 数据模型与配置型拒绝显式 retry | `9f1bf4e`、`113937a` | 已完成 |
| 5 | 可信 MR pipeline 选择与 CI 查询 attempt 隔离 | `bd22147`、`0f466b3` | 已完成 |
| 6 | 全量验证、分支 review 收口、文档同步与推送 | `cc88a9f`、`ba414b2`、状态回写（本提交） | 已完成 |

实现期间保持每个风险独立提交，原有 rejected run 不原地修改，CI 不可用也不阻断 Review。真实隔离 GitLab 验收独立保留在联调清单中，不以单元测试替代。

### Task 12: 全量验证、文档同步和联调准备

**Files:**
- Modify: `packages/platform-gitlab/docs/review-implementation/18-review-hardening-and-recovery-design.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/19-review-hardening-and-recovery-implementation-plan.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/README.md`
- Modify: `packages/platform-gitlab/docs/review-implementation/14-live-integration-test-checklist.md`

**Interfaces:**
- Produces: 完成批次、提交、测试结果和真实 GitLab 联调步骤的中文记录

- [x] **Step 1: 运行定向测试集合**

Run: `bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/platform-gitlab/test/gitlab-platform.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts packages/nine1bot/src/review/gitlab-ci-inspector.test.ts web/test/gitlab-project-profile.test.ts opencode/packages/opencode/test/tool/gitlab-ci-inspect.test.ts opencode/packages/opencode/test/server/automated-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts opencode/packages/opencode/test/tool/registry.test.ts opencode/packages/opencode/test/agent/platform-agent-source.test.ts`

Expected: PASS。

Result: 最终使用 `--timeout 30000` 运行计划列出的 10 个测试文件，`192 pass / 0 fail / 682 expect()`。默认 5 秒下仅 OpenCode 临时目录安装插件用例超时；同一用例提高测试时限后通过，无断言失败。

- [x] **Step 2: 运行全量验证**

Run: `bun run ci:test`

Run: `bun run ci:typecheck`

Run: `bun run --cwd opencode/packages/opencode typecheck`

Run: `bun run build:web`

Run: `git diff --check`

Expected: 全部 PASS。

Result:

- `bun run ci:test -- --timeout 30000`：`459 pass / 0 fail / 1587 expect()`，共 59 个测试文件。
- 默认 5 秒 `bun run ci:test`：455 个通过，4 个既有 Feishu/access-auth 高开销用例超时；四个用例分别以 30 秒重跑均通过。
- `bun run ci:typecheck`：维护中的 platform、Nine1Bot、browser 与 Web 包全部通过。
- OpenCode package `bun run typecheck`：通过。
- `bun run build:web`：通过；仅保留既有 920.85 kB 主 chunk 提示。
- `git diff --check`：通过。

- [x] **Step 3: 做安全回归复验**

再次用两个本地 server 验证跨 authority 没有 token；用实际 ToolRegistry 记录 MR PM、commit PM、specialist 和普通 session 的工具 ID；确认 tool/session 文件不包含未截断 CI 输出。

Result: 上述三项均包含在定向 10 文件测试集中并通过，分别由本地双 server 重定向测试、真实 ToolRegistry/agent source 测试和 CI 输出持久化边界测试覆盖。

- [x] **Step 4: 更新文档状态**

在本计划标记完成 checkbox 和各 Batch commit；在设计文档记录实现差异；在联调 checklist 增加 source、merged-results/merge-train、配置拒绝后 retry 三条用例。

Result: 已更新设计实现差异、批次/提交表、无凭证联调清单与目录索引；真实 GitLab 验收仍按清单保留为合并前人工步骤。

- [x] **Step 5: 最终 review 与提交**

Run: `git status --short`

Run: `git diff origin/main...HEAD --check`

```bash
git add -f packages/platform-gitlab/docs/review-implementation/18-review-hardening-and-recovery-design.md packages/platform-gitlab/docs/review-implementation/19-review-hardening-and-recovery-implementation-plan.md packages/platform-gitlab/docs/review-implementation/README.md packages/platform-gitlab/docs/review-implementation/14-live-integration-test-checklist.md
git commit -m "docs(gitlab): record review hardening rollout"
```

Result: 分支级 `git diff origin/main...HEAD --check`、敏感信息扫描和最终 review 均通过；仅提交四份 GitLab Review 文档，不纳入本地 IDE 文件。

- [x] **Step 6: 推送当前 PR 分支**

Run: `git push origin HEAD:feat/gitlab-review-workflow-v2`

Expected: 远端 PR #52 更新成功。

Result: `git push origin HEAD:feat/gitlab-review-workflow-v2` 成功，PR #52 已包含实现、测试与无凭证联调清单；本步骤状态由随后的小型文档提交回写。
