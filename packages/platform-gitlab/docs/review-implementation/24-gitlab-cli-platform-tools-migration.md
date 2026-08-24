# GitLab CLI 平台工具迁移与后续计划

> 文档日期：2026-08-21
>
> 目标分支：`feat/gitlab-review-workflow-v2`
>
> 路线：`glab` 作为底层执行器，skill 固定流程，wrapper tool 固定边界，context pipeline 控制注入；不建设 MCP，不允许模型裸跑 CLI。

## 1. 决策结论

本轮不整体合并 `feat/gitlab-cli-capabilities`，而是基于 `main` 已落地的平台注册能力做选择性迁移。

采用的能力：

| 能力 | 落地方式 |
| --- | --- |
| GitLab CLI 状态探测 | 平台状态卡和 `gitlab_cli_status` wrapper |
| 项目、MR、commit 目标解析 | 页面上下文加 `gitlab_cli_resolve_target` |
| 仓库概览 | 受预算限制的项目快照、根目录和重要文件预览 |
| MR/commit review | 摘要优先、按需读取受限 diff |
| 评论回写 | 仅允许 note 和 MR inline discussion；dry-run 与真实写入分离 |
| 流程约束 | GitLab assistant 与五份 CLI 引导 skill |
| 工具注册 | `PlatformAdapterContribution.runtime.tools` 注册，`registeredTools` 按页面模板注入 |

明确不迁移的能力：

| 不迁移项 | 原因 |
| --- | --- |
| 旧的内置工具扫描器 | `main` 已提供统一平台注册机制，重复扫描会形成两套来源和生命周期 |
| webhook 的 CLI 发布后端 | 自动 Review 已有经过加固的 Token REST 发布、HEAD 校验、对账和 attempt 恢复，不应换回本地 CLI 状态 |
| 任意 `glab`/shell 执行 | 参数、输出、权限和上下文都无法稳定收口 |
| MCP server | 能力只供本项目使用，当前平台工具协议已经覆盖注册、权限、可用性和生命周期 |
| 全仓索引或全量 diff 注入 | 容易污染上下文并导致输出、时延和成本失控 |

## 2. 架构边界

### 2.1 交互式 GitLab 页面会话

```text
浏览器 GitLab repo/file/MR/commit 页面
  -> 标准 page context
  -> GitLab template
  -> registeredTools + guided skills
  -> platform.gitlab.assistant
  -> 受控 CLI client
  -> glab api --hostname <target-host>
  -> GitLab API
```

该链路面向用户在 Web 对话栏发出的自然语言请求，例如“审查当前 MR”“看看这个 commit 的风险”“检查这个仓库的工程健康度”。模型只看到结构化 wrapper 参数与受限结果，不看到认证配置或底层任意命令入口。

### 2.2 自动 webhook Review

```text
GitLab webhook
  -> project profile
  -> frozen ReviewRun / attempt
  -> context pipeline
  -> platform.gitlab.pm-coordinator + specialists
  -> gitlab_ci_inspect（按需）
  -> 原有受限 REST 发布链路
```

自动 Review 与交互式 CLI 会话隔离：

- PM 和 specialist agents 不获得任何 `gitlab_cli_*` 工具。
- 自动 Review 仍使用冻结的项目、MR、HEAD、diff 和项目上下文。
- CI 仍只接受与冻结 MR 可信关联的 pipeline；找不到可信 CI 时输出诊断并继续 Review。
- 发布仍使用既有 Token REST 链路，不受本机 `glab` 登录状态影响。

## 3. 工具矩阵

| Tool ID | 页面 | 行为 | 权限 |
| --- | --- | --- | --- |
| `gitlab_cli_status` | 所有 GitLab 页面 | 检查安装和登录状态 | 只读、直接允许 |
| `gitlab_cli_resolve_target` | 所有 GitLab 页面 | 从 URL、页面或文本解析目标 | 本地解析、直接允许 |
| `gitlab_cli_project_snapshot` | repo/file | 读取受限项目元数据 | 目标级 `gitlab_cli_read` 确认 |
| `gitlab_cli_mr_snapshot` | MR | 读取受限 MR 元数据 | 目标级 `gitlab_cli_read` 确认 |
| `gitlab_cli_mr_diff` | MR | 先摘要、再按需读取受限 diff | 目标级 `gitlab_cli_read` 确认 |
| `gitlab_cli_commit_diff` | commit | 先摘要、再按需读取受限 diff | 目标级 `gitlab_cli_read` 确认 |
| `gitlab_cli_repository_health_context` | repo/file | 读取根目录和重要文件预览 | 目标级 `gitlab_cli_read` 确认 |
| `gitlab_cli_publish_review_note` | MR/commit | dry-run 或发布 note | preview 允许；真实发布单独确认 |
| `gitlab_cli_publish_review_discussion` | MR | dry-run 或发布 inline discussion | preview 允许；真实发布单独确认 |

页面只声明当前工作流需要的工具。repo/file 不获得 MR 写工具，commit 不获得 MR discussion 工具，普通非 GitLab 会话不注入这些工具。

## 4. 上下文与长 diff 策略

仓库概览和代码审查都采用渐进加载：

1. 先确认 host、project、MR IID 或 commit SHA。
2. MR 先读取元数据和不带原始 diff 的清单摘要。
3. commit 先读取不带原始 diff 的清单摘要。
4. 只有目标和范围确认后，才使用 `includeDiff: true` 获取受限原始 diff。
5. 仓库健康检查只读取根目录、README、CI、依赖、构建和运行配置等重要文件预览。
6. 输出必须保留 `coverage`、`skipped` 和 `truncated`，不得把局部证据描述成完整审查。

当前硬限制包括：

| 项目 | 限制 |
| --- | --- |
| 单次 CLI 原始输出 | 4 MiB |
| 本地 diff 候选 | 最多 48 个 |
| 返回 diff 文件 | 最多 24 个 |
| 返回 diff 内容 | 最多 32 KiB UTF-8 |
| 仓库根目录 | 最多 60 项 |
| 重要文件 | wrapper 最多 24 个，默认 8 个 |
| 重要文件总预览 | wrapper 最多 24 KiB UTF-8，默认 16 KiB |
| 发布正文 | 最多 20 KiB UTF-8 |

GitLab 自身报告 `overflow` 时会明确增加未知遗漏项，不会把本地已返回文件误报为完整覆盖。

## 5. 安全与稳定性保证

### 5.1 命令边界

- 使用 `execFile('glab', args)`，不拼接 shell 命令。
- API endpoint、method 和可选 `--hostname` 由 wrapper 固定。
- 写入正文通过 `glab api --input -` 从 stdin 传递，不进入 argv、命令摘要或日志。
- 输入采用严格 JSON Schema，顶层拒绝额外字段。
- host、project path、MR IID、commit SHA、行号、文件路径和正文字节数均再次做运行时校验。
- 所有网络读写目标必须显式包含 host，不能依赖当前工作目录的 Git remote 选择实例。
- 配置了 `allowedHosts` 时，目标必须显式带 host 且命中白名单。

### 5.2 权限边界

- Agent 默认 `"*": deny`。
- 读取按 host/project/MR/commit 形成目标级 `gitlab_cli_read` 权限确认。
- dry-run preview 不访问 CLI，可直接生成受限预览。
- 真实 note/discussion 发布使用各自工具权限并再次询问。
- 写入超时、取消、输出过大、命令失败或响应无法解析时返回 `gitlab-cli-write-outcome-uncertain`，禁止自动重试，避免重复评论。

### 5.3 输出与失败边界

- 所有 CLI 输出先受原始字节上限保护，再解析 JSON。
- 描述、文件内容和错误诊断按 UTF-8 预算截断；路径、SHA、ID 等身份字段超限时整项省略，不生成截断后的假身份。
- 根目录截到 60 项或存在无法安全表示的条目时返回 `rootTreeTruncated: true`。
- 错误和状态文本经过 GitLab secret sanitizer，不回传 Token 或认证细节。
- AbortSignal 和超时传到每次 CLI 调用；取消不会被仓库文件预览降级为普通跳过。
- 状态探测按工作目录缓存，平台状态卡另有短时缓存，避免工具目录和配置页反复阻塞。

## 6. 用户配置与使用

### 6.1 运行 Nine1Bot 的机器

1. 安装 GitLab CLI `glab`，认证方式参见 [GitLab CLI authentication](https://docs.gitlab.com/cli/authentication/)。
2. 在运行 Nine1Bot 的同一用户环境完成登录：

```powershell
glab auth login
```

Self-Managed GitLab 可显式指定实例：

```powershell
glab auth login --hostname <gitlab-host>
```

认证凭证应通过交互流程、stdin 或受保护的凭证存储提供，不要把 Token 放进提示词、仓库文件或共享命令参数。

### 6.2 Nine1Bot 配置页

1. 启用 GitLab 平台。
2. 在 `Allowed GitLab hosts` 中填写允许提供页面上下文和 CLI wrapper 访问的 `host` 或 `host:port`；留空表示不额外限制 host，但每次网络调用仍必须携带明确 host。
3. 刷新平台状态，确认 GitLab CLI 卡片显示 `authenticated: <host>`。
4. 打开浏览器插件设置，确认当前会话允许使用平台推荐的 Agent、skills 和 registered tools。

交互式 CLI workflow 不要求配置 webhook、Review project profile 或 Nine1Bot 中的 GitLab API Token。上述配置仍是自动 webhook Review 的必需项，不能互相替代。

### 6.3 对话入口

打开 GitLab 仓库、MR 或 commit 页面后，可在 Web 对话栏直接描述：

```text
检查当前仓库的工程健康度，重点看 CI 和依赖风险。
Review 当前 MR，先告诉我覆盖范围，不要发布评论。
审查当前 commit，按严重级别列出可定位的问题。
先预览要发布到当前 MR 的总结，确认后再发布。
```

所有真实发布都应在用户表达明确写入意图后发生，并通过运行时权限确认。

## 7. 已完成 Batch

| Batch | 状态 | 产出 |
| --- | --- | --- |
| A：分支与架构对齐 | 已完成 | 拉取并合并最新 `main`，采用 `runtime.tools` 与 `registeredTools` |
| B：CLI 核心 | 已完成 | 固定 `glab api` 调用、目标解析、状态检测、快照、diff、仓库上下文和写入 |
| C：安全与预算 | 已完成 | 白名单、严格 Schema、stdin 写入、脱敏、超时/取消、UTF-8 预算和不确定写入诊断 |
| D：平台接入 | 已完成 | GitLab template 工具映射、commit 页面、交互 Agent、权限隔离和 CLI skills |
| E：配置引导 | 已完成 | 平台 CLI 状态卡、Web 安装/登录/使用引导 |
| F：自动化验证 | 已完成 | 聚焦测试 125 项、根级测试 700 项、OpenCode Runtime 测试 192 + 1 项均通过；根级/OpenCode/平台/Web typecheck 与 Web 构建通过 |

## 8. 后续计划

### Batch G：真实 CLI 联调

在隔离的 Self-Managed GitLab 测试项目执行并记录：

1. `glab` 未安装、未登录、已登录三种状态卡。
2. `allowedHosts` 命中和拒绝。
3. repo 项目快照与仓库健康上下文。
4. MR 元数据、摘要 diff、按需原始 diff。
5. commit 摘要 diff 与按需原始 diff。
6. note/discussion dry-run 不产生远端写入。
7. 用户确认后的单次真实发布，以及超时场景下不自动重试。
8. 自动 webhook Review 回归，确认 PM 会话看不到 CLI wrapper。

### Batch H：上线观察

1. 记录 wrapper 成功率、超时、输出截断和权限拒绝的稳定诊断计数，不记录正文和凭证。
2. 观察大 MR 的覆盖率与二次按需读取频率，再决定是否需要更细的路径级 wrapper。
3. 只有出现明确、重复的工作流缺口时才新增工具；不开放通用 API、raw CLI 或 MCP。

## 9. 当前验收结论

代码迁移、页面映射、权限隔离、完整自动化回归和 Web 构建已经完成。真实 Self-Managed GitLab 的 CLI 读取与评论回写尚未在本批次执行，因此当前只可声明“自动化验证通过”，不能声明“真实联调通过”。
