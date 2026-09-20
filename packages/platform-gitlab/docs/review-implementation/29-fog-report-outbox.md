# FOG MR 综合报告：实现与运维

## 交付范围

FOG 是服务端出站集成，不是模型工具，也不是 MCP。当前接入 GitLab MR 的结构化 closed 审查结果发布链路，支持正常、需要关注、blocked 和 failed 审查结论。commit 审查、尚未产出结构化结果的运行时异常，以及定时默认分支扫描不在本次生产范围。

默认关闭。没有配置 FOG 的既有服务不会创建队列、查询额外 CI 或发送请求。本次没有部署到现有测试服务器，没有向真实 FOG 发送数据。

## 工作流程

1. GitLab 发布已完成权限、HEAD 和结果验证后，在第一次评论写入前，把审查结果快照写入独立 SQLite outbox。数据库只保存业务快照，不保存 GitLab 或 FOG Token。
2. 评论发布及 ReviewRun 终态落盘成功后，持久化确认标志。队列失败只在 ReviewRun warnings 留下 `fog_capture_failed`，不能阻断 GitLab 评论。
3. 服务启动即恢复队列，之后每 60 秒扫描一次；每批最多 5 份报告，进程内串行。SQLite 租约避免多个 worker 同时处理同一记录，租约为 120 秒。
4. 后台读取当前 GitLab 平台配置并重新检查启用状态、项目范围、档案和 API 地址。使用受限 API 客户端查询真实项目名称、MR 标题和分支、可信关联的 CI。
5. 仅 `success` 或 `failed` 且 pipeline SHA 与审查 SHA 相等、具备 `head_sha_exact` 证据时生成综合报告。无 CI、运行中、取消、跳过或不同 SHA 均暂缓发送。MR 换 HEAD 不会把新代码的 CI 附到旧审查。
6. 首次发送前持久化请求体和 UUID 幂等键。后续重试复用相同请求体、发生时间、目的地址和幂等键，不重新生成标题、结论或 CI 结果。
7. 只有 HTTP 200 且响应包含 `accepted: true`、非空 `workItemId` 和 `reportId` 时记为 `sent`。

## 协议与证据

- `projectKey` 使用 GitLab 完整项目路径，绝不使用 Nine1Bot 会话目录作为仓库身份。
- 标题使用实际 GitLab 项目名称和 MR 标题。`occurredAt` 固定北京时间。
- finding 严重程度映射为 high/medium/low/info；行号只接受已在冻结 diff 中验证的新侧行号。无法验证、仅有删除侧行号时省略 `line`。
- `testsRun` 仅列出有开始时间且达到 success/failed 的实际 job，明确列出其状态；不根据 job 名字推断执行了哪些测试用例。
- 无 job 明细、未执行、非最终 job、allow-failure、查询截断、审查遗漏及后续检查事项都会保留为未覆盖证据。不能因为 pipeline 为 success 就声称测试充分。
- AI 发现、CI 失败或未覆盖证据会影响综合状态；AI 自身 blocked/failed 不会被成功 CI 覆盖。

## 配置

通过 Nine1Bot 服务进程环境配置，修改环境后重启服务。推荐使用 Token 文件，不在 GitLab 项目上下文、提示词或普通配置文档中填写凭证。

```ini
FOG_REPORTS_ENABLED=true
FOG_AGENT_REPORT_URL=http://10.21.32.45:8001/api/v1/agent-reports
FOG_ALLOW_INSECURE_HTTP=true
FOG_AGENT_REPORT_TOKEN_FILE=/etc/nine1bot/fog-agent-report-token
```

接口文档指定 HTTP，因此本示例显式允许明文内网传输。默认仅允许 HTTPS；不要将 HTTP 配置用于非可信网络。文件中仅放 Token 本身，由服务账号读取，建议权限 `0600`。Token 文件每次处理时重新读取，修正 Token 后可显式重试。也支持 `FOG_AGENT_REPORT_TOKEN` 环境变量，配置文件路径优先。

可选 `FOG_OUTBOX_PATH` 指定数据库文件。默认使用 Nine1Bot data 目录下的 `fog/outbox.sqlite`，数据库权限 `0600`，新建专属目录权限 `0700`。更改数据库路径不是重试方法，会丢失该服务对原队列的可见性。

FOG Token 尚未提供时，可以完成本地测试。启用但缺少 Token 时，报告进入 `waiting_config`，不会尝试匿名投递。

## 管理接口

以下路径挂在现有管理路由，使用 Nine1Bot 的管理访问认证，不使用 FOG Bearer Token，也不是公开 webhook 路由。

```text
GET  /webhooks/gitlab/fog-reports?limit=100&offset=0
POST /webhooks/gitlab/fog-reports/:runId/retry
```

列表只返回 runId、幂等键、状态、稳定诊断、时间、发送次数及接收回执，不返回审查正文、源码、Token 或原始 HTTP 错误体。每页最多 100 条。

重试成功返回 202；功能关闭、记录不存在、已发送或仍被 worker 持有时返回 409。显式重试重置本轮自动重试计数，但不改变报告请求体或幂等键，也不能绕过目的地址及来源身份检查。

| 状态 | 含义与处理 |
| --- | --- |
| waiting_publication | 审查快照已保存，尚未确认 GitLab 发布；后台对账 |
| waiting_ci | 尚无符合本次 SHA 的最终 CI；后台继续有限查询 |
| waiting_config | 缺少凭证、平台停用或范围变更；修复配置后重试 |
| ready | 请求体已固定，等待投递 |
| retry | 瞬时网络错误、408、429 或 5xx；退避重试 |
| blocked | 鉴权/协议错误、来源身份不符、地址变化或重试耗尽；人工处理后显式重试 |
| sent | FOG 已明确接受，重复触发不会重发 |

请求超时 15 秒，CI 收集总预算 30 秒。自动发送最多 8 次，指数退避上限 1 小时。等待配置或等待 CI 不消费发送次数。禁止所有 HTTP 重定向；最大回执 16 KiB，最大报告/原始业务快照分别为 256 KiB。超限拒绝投递，不静默丢弃 findings。

## 恢复与容量边界

- 独立 outbox 不随 ReviewRun 历史裁剪删除，已确认发布的报告可在历史裁剪后继续发送。
- 如果进程在 GitLab 发布终态和 outbox 确认之间退出，后台通过 ReviewRun 的 generation 和 publication payloadHash 对账。若对应历史已不可用，则保留 `fog_publication_unconfirmed`，不猜测发布成功。
- 存储最多保留 1000 个报告，包括已发送记录，用于保持入队去重。达到上限时保留既有队列并明确报告新入队失败，GitLab 仍正常发布。需要容量管理；本版不提供自动删除或归档功能，避免删除幂等记录后误重发。
- 队列不可写或已满时未入队的审查，以及功能关闭时完成的历史审查，不会自动补发；不能把 `retry` 当成历史补录接口。
- 已绑定报告不会因环境地址变更而投向另一 FOG。修复为原目的地址后重试；没有自动迁移目的地的能力。
- 不要删除 outbox 来解决鉴权问题，也不要为同一报告手工生成新 UUID。

## 验证记录

本次验证包括协议映射、北京时间、SHA 与身份校验、密钥脱敏、队列持久化、并发租约、崩溃恢复、固定请求体重试、HTTP 错误与重定向、响应限制、worker 取消以及 GitLab 发布不受队列失败影响。

另有真实本地 HTTP 集成测试：使用受控 GitLab API 和 FOG 接收端，关闭并重新打开 outbox，验证失败 CI 报告被接受，管理 DTO 不暴露凭证或业务正文。它不是线上 FOG 联调证据。

实际测试命令与最终结果在 Plan 28 更新。真实 FOG 接收仍需服务器提供 Token 后部署验证；定时仓库扫描和自动 MR 事件过滤沿原计划后续处理。
