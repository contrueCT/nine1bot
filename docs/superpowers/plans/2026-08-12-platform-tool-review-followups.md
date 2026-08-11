# 平台工具 PR 评审 Follow-up 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **执行方式：** 用户已指定由主 Agent 在当前会话内实现、验证、提交并推送，不使用子代理编写代码。

**Goal:** 修复 PR #53 中两个 P3 follow-up：删除 session 时释放 resolver 的按 session 去重状态，并让 `registeredTools` capability 反映平台注册工具在当前 runtime 配置下是否能被装配。

**Architecture:** `RuntimeResourceResolver` 提供幂等的 session 生命周期清理入口，由 `Session.remove()` 在删除事件发布前同步调用。Capabilities endpoint 和 controller `AgentRunSpec` 都读取同一个 `resourceResolverEnabled` 有效值，并用它设置 `registeredTools`。

**Tech Stack:** TypeScript、Bun test、Zod、Hono、OpenCode `Instance.state()`。

## Global Constraints

- 只修改 PR #53 已有的平台注册工具功能及其设计、测试，不回复或关闭 GitHub comment。
- 所有测试都先在旧实现上观察到预期失败，再写最小生产代码。
- 复用现有 linked worktree `C:\code\nine1bot-platform-tool-registration`，不影响另一个 Nine1Bot worktree。
- 提交信息不包含 AI 协作者信息。

---

### Task 1: 清理已删除 Session 的 Resolver 去重状态

**Files:**
- Modify: `opencode/packages/opencode/src/runtime/resource/resolver.ts`
- Modify: `opencode/packages/opencode/src/session/index.ts`
- Test: `opencode/packages/opencode/test/resource/resource-resolver.test.ts`

**Interfaces:**
- Consumes: `Session.remove(sessionID)` 的现有同步删除流程和 `Instance.state()` 返回的两个 `Map`。
- Produces: `RuntimeResourceResolver.clearSessionState(sessionID: string): void`，删除 resolution 去重键和所有 `${sessionID}:` tool failure 去重键。

- [x] **Step 1: 写入两个失败测试**

  两个测试分别创建真实 session，让相同 turn resolution 或相同 tool failure 的第二次发布被去重；删除 session 后，再次发布相同内容必须返回 `true`。拆分测试可以证明两个 Map 的回归保护都能在旧实现上独立失败。

- [x] **Step 2: 验证测试因旧状态未清理而失败**

  Run: `cd opencode/packages/opencode && bun test test/resource/resource-resolver.test.ts -t "clears resolution dedupe state when a session is deleted"`

  Run: `cd opencode/packages/opencode && bun test test/resource/resource-resolver.test.ts -t "clears tool failure dedupe state when a session is deleted"`

  Expected: 两项都 FAIL；`Session.remove()` 后再次发布的结果仍为 `false`。

- [x] **Step 3: 实现最小生命周期清理**

  ```ts
  export function clearSessionState(sessionID: string) {
    lastPublishedResolution().delete(sessionID)
    const failures = emittedToolFailures()
    const prefix = `${sessionID}:`
    for (const key of failures.keys()) {
      if (key.startsWith(prefix)) failures.delete(key)
    }
  }
  ```

  `Session.remove()` 在 session 持久记录删除成功后，用 `finally` 保证 profile 和 runtime context 清理结束时调用该函数，再发布 `Session.Event.Deleted`。这样后续清理异常不会让已删除 session 的 resolver 状态继续留在内存中，并且删除事件前没有异步等待重新扩大竞态窗口。

- [x] **Step 4: 验证单项与 resolver 文件全部通过**

  Run: `cd opencode/packages/opencode && bun test test/resource/resource-resolver.test.ts`

  Expected: 该文件全部通过，且新增测试能同时保护两个 Map 的清理行为。

---

### Task 2: 对齐 Registered Tools 的有效 Capability

**Files:**
- Modify: `opencode/packages/opencode/src/server/routes/nine1bot-agent.ts`
- Modify: `opencode/packages/opencode/src/runtime/controller/agent-run-compiler.ts`
- Test: `opencode/packages/opencode/test/server/nine1bot-agent.test.ts`
- Test: `opencode/packages/opencode/test/controller/controller-agent-run-compiler.test.ts`
- Modify: `docs/superpowers/specs/2026-08-10-platform-tool-registration-design.md`

**Interfaces:**
- Consumes: `RuntimeFeatureFlags.resourceResolverEnabled(): Promise<boolean>`。
- Produces: capabilities endpoint 的 `server.registeredTools` 和每轮 `AgentRunSpec.capabilities.server.registeredTools`，两者都等于当前 resolver 有效值。

- [x] **Step 1: 写入两个失败测试**

  在临时配置中设置 `runtime.resourceResolver.enabled=false`。Capabilities endpoint 必须同时返回 `resourceResolver: false` 和 `registeredTools: false`；controller compiler 生成的 `AgentRunSpec` 也必须返回 `registeredTools: false`。

- [x] **Step 2: 验证旧实现错误地返回 `true`**

  Run: `cd opencode/packages/opencode && bun test test/server/nine1bot-agent.test.ts -t "does not advertise registered tools when the resource resolver is disabled"`

  Run: `cd opencode/packages/opencode && bun test test/controller/controller-agent-run-compiler.test.ts -t "does not advertise registered tools when the resource resolver is disabled"`

  Expected: 两项都 FAIL，实际值为 `true`。

- [x] **Step 3: 复用同一次 feature flag 读取**

  Endpoint 先读取 `resourceResolverEnabled`，再赋给 `resourceResolver` 和 `registeredTools`。Compiler 在组装 capabilities 前读取该值，并通过 `capabilitiesFrom()` 的 flags 参数设置 `registeredTools`。

- [x] **Step 4: 验证两个 capability 测试文件全部通过**

  Run: `cd opencode/packages/opencode && bun test test/server/nine1bot-agent.test.ts`

  Run: `cd opencode/packages/opencode && bun test test/controller/controller-agent-run-compiler.test.ts`

  Expected: 两个文件全部通过，默认启用配置仍返回 `registeredTools: true`。

---

### Task 3: 联合验证、提交与推送

**Files:**
- Verify: all files changed by Task 1 and Task 2

**Interfaces:**
- Consumes: 两项修复和对应回归测试。
- Produces: 一个不含无关文件的 Conventional Commit，并推送到 `origin/task/platform-tool-registration`。

- [x] **Step 1: 运行相关测试与类型检查**

  ```powershell
  cd opencode/packages/opencode
  bun test test/resource/resource-resolver.test.ts
  bun test test/server/nine1bot-agent.test.ts
  bun test test/controller/controller-agent-run-compiler.test.ts
  bun run typecheck
  ```

- [x] **Step 2: 检查补丁质量和提交范围**

  Run: `git diff --check`

  Run: `git status --short`

  Run: `git diff --stat`

- [ ] **Step 3: 提交并推送**

  ```powershell
  git add docs/superpowers/specs/2026-08-10-platform-tool-registration-design.md docs/superpowers/plans/2026-08-12-platform-tool-review-followups.md opencode/packages/opencode/src/runtime/resource/resolver.ts opencode/packages/opencode/src/session/index.ts opencode/packages/opencode/src/server/routes/nine1bot-agent.ts opencode/packages/opencode/src/runtime/controller/agent-run-compiler.ts opencode/packages/opencode/test/resource/resource-resolver.test.ts opencode/packages/opencode/test/server/nine1bot-agent.test.ts opencode/packages/opencode/test/controller/controller-agent-run-compiler.test.ts
  git commit -m "fix: address platform tool review follow-ups"
  git push origin task/platform-tool-registration
  ```

- [ ] **Step 4: 核对远端和 PR 头部**

  Local `HEAD`、`origin/task/platform-tool-registration` 和 PR #53 `headRefOid` 必须一致。只报告 comment 已由代码覆盖，不在 GitHub 上回复或关闭它。
