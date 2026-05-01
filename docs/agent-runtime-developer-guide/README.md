# Agent Runtime Developer Guide

这个目录是 Nine1Bot Agent Runtime 面向开发者的架构与接入指南，用于帮助开发新的 bot 接入点、平台深度适配、上下文注入、资源声明和 runtime event 消费。

## 阅读路径

如果只是理解整体架构，建议先读：

1. [Agent Runtime 与 Controller 总体设计](./01-runtime-controller-architecture.md)
2. [用户配置兼容与模板化设计](./02-user-config-template-compatibility.md)
3. [AgentRunSpec 字段详细说明](./03-agent-run-spec-fields.md)
4. [模板覆盖与叠加策略](./04-template-merge-overlay-strategy.md)

如果要开发新的接入点或平台适配，继续读：

5. [对话运行流程与上下文历史](./05-conversation-runtime-flow.md)
6. [运行时稳定性、能力协商与资源漂移](./06-runtime-stability-capability-drift.md)
7. [Context Pipeline 实现设计](./07-context-pipeline-implementation-design.md)
8. [Resource Resolver 实现设计](./08-resource-resolver-implementation-design.md)
9. [多平台适配层开发参考](./09-platform-adapter-development-guide.md)
10. [Controller API 与 Runtime Event 协议](./11-controller-api-runtime-events.md)

## 核心原则

- 新入口应通过 Controller API 接入 agent runtime，不直接拼接 prompt 或绕过 runtime。
- 会话创建时通过 template / sessionChoice 冻结 profileSnapshot。
- 每轮消息可以携带 page context / runtime override，但不能每轮切换 agent、MCP、skills 等 session 级能力。
- context 通过 context blocks 和 context events 进入 runtime，并由 context pipeline 编译。
- tools / MCP / skills 通过 resource resolver 解析，profileSnapshot 只声明资源身份，当前配置作为 live gate 控制实际可用性。
- 权限、交互、文件、图片、预览、资源失败等能力通过 runtime event envelope 表达。
- 第三方平台深度适配应放在 `packages/platform-*`，runtime core 只保留通用 registry / protocol / pipeline，不直接写 GitLab、Jira、GitHub 等平台语义。
- 平台适配的启用、禁用、状态展示和平台自有配置页由 Nine1Bot 产品层 Platform Adapter Manager 负责，Web 配置页应提供“多平台适配 > 具体平台”的可扩展入口。

## 不包含的内容

这个目录只保留开发新入口和平台适配所需的稳定架构文档，不包含以下内部实施记录：

- runtime 代码迁移计划
- session profile 持久化专项设计
- 阶段性测试矩阵
- Phase 0 timing baseline
- 性能基准记录

这些内部文档仍保留在 `docs/agent-runtime-design/`，用于维护者追溯重构过程和实现细节。
