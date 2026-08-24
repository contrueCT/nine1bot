# GitLab Review 实施文档索引

本目录保存 GitLab review 能力建设过程中的阶段产出和后续计划。两份初始总览仍保留在包根目录：

- [GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md](../../GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md)
- [GITLAB_REVIEW_ENGINEERING_SUMMARY.md](../../GITLAB_REVIEW_ENGINEERING_SUMMARY.md)

除上述历史总览外，后续不要再在 `packages/platform-gitlab/` 根目录新增阶段性设计文档。新增施工记录统一放在本目录，避免实现文件和阶段文档继续混在一起。

## 当前架构约束

- GitLab 专属能力放在 `packages/platform-gitlab`。
- GitLab agents、skills 通过 `PlatformAdapterContribution.runtime.sources` 暴露，wrapper tools 通过 `runtime.tools` 注册到 Platform Adapter Manager。
- Web 对话栏的交互任务通过 page context 或显式 URL 选择目标；自动 Review 通过 project profile 和冻结的 ReviewRun/attempt 关联项目、MR、源码版本和上下文。
- 模型只能调用显式注册且由页面模板声明的 wrapper tool，不向模型暴露 token、任意 `glab` 命令、`curl`、`webfetch`、shell 或通用网络能力。
- 交互式 GitLab 页面会话可使用 `runtime.tools` 注册的受控 CLI wrapper；自动 webhook Review 不声明、不注入这些 CLI 工具，只使用 ReviewRun 绑定的 `gitlab_ci_inspect`、`gitlab_repository_inspect` 和原有发布链路。
- skill 固定审查步骤，wrapper tool 固定能力边界，context pipeline 负责冻结、切片和按预算注入上下文。
- MCP 暂不作为本项目内部 GitLab 能力提供方式。

## 文档顺序

1. [01-platform-package-construction.md](./01-platform-package-construction.md)
   - GitLab 包内目录、agents、skills、webhook、API client、diff、inline、renderer。
2. [02-controller-runtime-integration.md](./02-controller-runtime-integration.md)
   - Nine1Bot Controller、Platform Manager、Runtime source、AgentRunSpec、Runtime event 接入边界。
3. [03-validation-and-dry-run.md](./03-validation-and-dry-run.md)
   - dry-run harness、fixtures、单元测试、集成测试和回归命令。
4. [04-current-state-and-next-plan.md](./04-current-state-and-next-plan.md)
   - 当前已完成实现、设计对比、剩余计划。
5. [05-progress-freeze-and-design-review.md](./05-progress-freeze-and-design-review.md)
   - 阶段冻结、真实测试要求、设计偏离 review。
6. [06-live-integration-progress-and-gap.md](./06-live-integration-progress-and-gap.md)
   - 真实集成进度、差距和风险。
7. [07-architecture-adjustment-2026-05-05.md](./07-architecture-adjustment-2026-05-05.md)
   - 当前平台架构调整记录。
8. [08-copilot-like-review-plan.md](./08-copilot-like-review-plan.md)
   - 类 Copilot review 体验方案。
9. [09-review-scope-phase1.md](./09-review-scope-phase1.md)
   - Review scope 第一阶段。
10. [10-group-hook-phase2.md](./10-group-hook-phase2.md)
   - Group hook 第二阶段。
11. [11-ignored-events-phase3.md](./11-ignored-events-phase3.md)
   - ignored events 第三阶段。
12. [12-gitlab-review-interview-guide.md](./12-gitlab-review-interview-guide.md)
   - GitLab review 项目讲解材料。
13. [13-ai-agent-intern-interview-notes.md](./13-ai-agent-intern-interview-notes.md)
   - AI agent 实习面试笔记。
14. [14-live-integration-test-checklist.md](./14-live-integration-test-checklist.md)
   - 无凭证的真实 GitLab 联调清单，覆盖 webhook、可信 CI、非阻断诊断和显式 retry。
15. [15-project-context-ci-and-context-pipeline-plan.md](./15-project-context-ci-and-context-pipeline-plan.md)
   - 项目档案、ReviewRun 项目归属、可降级 CI/CD 证据，以及受预算控制的长上下文切片计划。
16. [16-runtime-ci-on-demand-tool-design.md](./16-runtime-ci-on-demand-tool-design.md)
   - 自动 Review 会话按需查询 CI 的 wrapper tool 设计与上下文边界。
17. [17-runtime-ci-on-demand-tool-implementation-plan.md](./17-runtime-ci-on-demand-tool-implementation-plan.md)
   - 按需 CI 工具的实施批次、验证方式与提交记录。
18. [18-review-hardening-and-recovery-design.md](./18-review-hardening-and-recovery-design.md)
   - 安全重定向、工具白名单、可信流水线、attempt 恢复、竞态隔离和无损配置设计。
19. [19-review-hardening-and-recovery-implementation-plan.md](./19-review-hardening-and-recovery-implementation-plan.md)
   - 本轮安全与稳定性改进的任务清单、提交记录和验收结果。
20. [20-review-follow-up-hardening-design.md](./20-review-follow-up-hardening-design.md)
   - 分支二次审查后的权限、脱敏、HEAD 一致性、绑定恢复、发布幂等、资源限制和 attempt 链完整性设计。
21. [21-review-follow-up-hardening-implementation-plan.md](./21-review-follow-up-hardening-implementation-plan.md)
   - 二次审查加固的 TDD 实施任务、接口、回归命令和提交边界；Task 1--9 及 follow-up 修复均已完成，后续遗留由 Plan 23 收口。
22. [22-publication-reconciliation-cpu-hardening-implementation-plan.md](./22-publication-reconciliation-cpu-hardening-implementation-plan.md)
   - 发布对账的前置输入预算、线性 marker 扫描、独立复审与 Task 6 CPU blocker 解除记录。
23. [23-final-review-residual-hardening-implementation-plan.md](./23-final-review-residual-hardening-implementation-plan.md)
   - 最终复审遗留的 specialist 资源快照、逐 POST HEAD 校验、claim 前完整发布预算和项目档案逐表示无损校验实施与收口记录。
24. [24-gitlab-cli-platform-tools-migration.md](./24-gitlab-cli-platform-tools-migration.md)
   - 基于平台注册机制选择性迁移 GitLab CLI wrapper、引导 skill、页面映射、权限边界、稳定性措施和后续真实联调计划。
25. [25-pr52-review-follow-up-fixes.md](./25-pr52-review-follow-up-fixes.md)
   - PR #52 最新 review 的 allowlist、CLI/host 边界、冻结仓库 wrapper、ReviewRun 原子状态机、可信运行时工具和竞态修复记录。

## 当前交付目标

当前交付包含两条隔离的内部 wrapper 路线：

```text
交互式 GitLab 页面
  -> page context + GitLab template
  -> registeredTools + guided skills
  -> platform.gitlab.assistant
  -> bounded CLI wrappers
  -> glab api

自动 webhook Review
  -> GitLab project profile
  -> frozen ReviewRun attempt + context pipeline
  -> allowlisted review agents and skill workflow
  -> bounded gitlab_ci_inspect REST wrapper (on demand)
  -> bounded gitlab_repository_inspect frozen Git wrapper (on demand)
  -> optional review publish
```

两条路线不共享模型工具权限：CLI wrapper 只进入交互式 GitLab 页面会话；自动 Review 的 PM 和 specialist agents 明确拒绝 CLI wrapper。两条路线都不采用 MCP，也不允许模型裸跑 CLI。

大 diff 由 context pipeline 按文件、风险和预算切片，Review finding 只能引用冻结 diff。CI 只作为补充上下文：仅接受与当前 MR/source HEAD 可证明关联的 source、detached、merged-result、merge-train 或 integrated pipeline；找不到可信 CI 时返回稳定诊断并继续 Review，绝不退化到项目最新流水线。CI list 最终成功 DTO 的严格序列化合同为 `< 32 KiB`。

配置型拒绝修复后必须调用显式 retry 接口创建新 attempt。发布前的明确瞬时 `load_changes` 失败可在 GitLab 重发同一 webhook 时创建关联 attempt；原 run、错误、时间和审计信息保持不变，旧异步请求不能覆盖新 attempt。

## 收口状态

二次审查加固 Task 1--8 已完成（`c6df20a..54c3be6`，含 Task 6 的 CPU 补充修复 `3a5f60e`、`9c905ce`、`873ce7d`、`33b3393`）。2026-08-15 fresh 自动化验证：聚焦 `350 pass / 0 fail / 1217 expect()`，根测试 `554 pass / 0 fail / 2040 expect()`，根与 OpenCode typecheck、Web build 均为 exit 0。自动化覆盖旧 HEAD 零发布、并发发布、部分恢复、stale binding retry、CI 配额/输出和 attempt 链修复。

真实 self-managed GitLab 的 webhook、可信 CI、远端 marker 对账与评论回写尚未在本批次执行，全部为 **待人工联调**；自动化测试不构成 live-integration 证据。

Plan 21 的首轮最终修复已形成 `6dc1c7d`、`1c291de`、`ca7c3ff`、`509eb44` 四个提交，并普通推送到 `origin/feat/gitlab-review-workflow-v2`。fresh 根测试为 `571 pass / 0 fail`，根与 OpenCode typecheck、Web build 均通过。后续 scoped 复审仍确认 4 组架构性遗留，已由 Plan 23 接管；在 Plan 23 的生产任务、独立复审和最终验证完成前，分支不宣称达到最终合并条件。

2026-08-23 的 PR #52 follow-up 又完成六个加固提交：`d54759d`、`ac70d87`、`4ae1f78`、`6f52b5a`、`a9067f1`、`305d3f8`。新增覆盖 CLI 可执行文件及仓库目录树信任、统一 host 策略、配置停用、ReviewRun claim/lease/terminal 原子性、自动 Review 工具实现 provenance、custom/MCP/plugin 隔离、monitor 取消和通用 Webhook 终态竞争；最终自动化与 live-integration 状态以 Plan 25 为准。
