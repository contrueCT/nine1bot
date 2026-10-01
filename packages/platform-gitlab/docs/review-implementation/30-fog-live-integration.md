# FOG 真实联调记录

日期：2026-09-20。

## 部署与安全配置

- 用户已提供真实 FOG Token，并授权调试。本文不记录凭证内容。
- FOG 实现提交 `e6e5bb0` 已通过 Git bundle 快进部署到测试服务器；保留既有配置和其他未跟踪文件。
- 测试服务为 `http://10.21.76.49:4096/`，systemd unit 为 `nine1bot.service`。
- Token 保存于服务账号的 `.config/nine1bot/fog-agent-report-token`，权限 `0600`，未放入仓库、提示词、命令参数或普通日志。
- 新增独立 systemd override `30-fog.conf`，设置报告开关、文档约定的 HTTP 接收地址、显式内网 HTTP 许可和 Token 文件路径。不改动其他 override。
- 重启后管理接口返回 `enabled: true`、`configured: true`。服务器到 FOG 的 TCP 连接可达；这两项不能单独作为接收成功证据。
- 服务器 Linux 环境 FOG 专项测试为 55 pass、0 fail。

## 真实报告样本

目标为 `topview-studio/restructure-archive-system-backend`（project `57`），MR `!4`。

原审查 `review_mu8c34c9_f` 已成功发布。一次性联调探针从原会话提取 closed 结果，使用产品解析器重新计算摘要，并与原 ReviewRun 的 publication payloadHash 对账。该步骤不调用模型、不修改已有评论，也不提供通用历史补发接口。

随后发现 MR 当前 HEAD 已由 `11cdeebba554244ca3cb3f9367b83da106f2eaeb` 变化为 `46b19535c661b00546f08eeef360bd368c41786f`。探针因此拒绝旧结果入队，未向 FOG 发送旧结果或虚构报告。

已通过真实 GitLab 评论 `264` 触发当前 HEAD 的一次新审查：

- ReviewRun：`review_mu9anns3_l`。
- 会话：`ses_f4301b78effec9TakG5LKm1qWU`。
- 当前关联 CI：pipeline `456`，核查时最终状态 `failed`，与新 HEAD SHA 一致。
- GitLab 范围仍为仅 project `57`；MR 自动事件仍关闭，手动 mention webhook 保持开启。

## 验收进度

- 已完成：部署、配置读取、秘密文件权限、Linux 专项测试、真实 webhook 触发。
- 已完成：旧审查与当前 HEAD 不一致时拒绝错误关联，旧样本未入队。
- 已完成：新审查成功发布到 GitLab，后台生成并持久化真实报告，自动向 FOG 发起投递。
- 未通过：FOG 返回 HTTP 400，未取得有效接收回执。队列状态为 `blocked`，诊断为 `fog_http_400`。

## 接收端阻塞与恢复

FOG 的真实响应为：`项目不存在或未启用: topview-studio/restructure-archive-system-backend；GitLab 主机不允许自动注册: 10.21.76.81`。

报告使用实际配置的 GitLab 内网实例地址，projectKey 为上述完整仓库路径，externalKey 为 `gitlab:mr:4`，状态为 `needs_attention`。没有为通过校验而改写来源、CI 或项目标识。使用原始持久化请求体和相同幂等键复核，仍得到相同业务拒绝；未取得 workItemId/reportId。

需要 FOG 管理方注册并启用该项目，或按其策略授权实际 GitLab 主机自动注册。不要单纯为了绕过限制伪造 source URL。

接收端配置修复后，通过已认证的 Nine1Bot 管理接口 `POST /webhooks/gitlab/fog-reports/review_mu9anns3_l/retry` 显式重试。保留原始请求体和幂等键，不需要重新触发模型或发布 GitLab 评论。随后查询报告状态，只有 `sent` 且存在有效回执才算接收验收通过。

GitLab MR 自动事件未因本次 FOG 联调而开启。

## 公开地址修复与验收通过

同日确认 FOG 自动注册白名单仅接受公开 GitLab 域名。提交 `ded8540` 已部署到测试服务，并增加独立 `31-fog-public.conf`：API origin 保持 `http://10.21.76.81:8929`，公开 origin 为 `https://gitlab.topviewclub.cn`。原 Token 文件和 FOG 目的地址未改动。

使用真实 GitLab API 核对公开域名的项目 ID、完整路径、MR IID 和 HEAD SHA 后，显式调用运维修复函数。原失败记录和请求体保持不变，新建关联投递 `review_mu9anns3_l:public-url`，使用新的幂等键。仅修改 MR URL、pipeline URL 和幂等键；审查正文、发生时间、CI 和 revision 保持原值，未调用模型、未重复发布 GitLab 评论。

后台首次投递即成功：

- 状态：`sent`，诊断为空，attempts 为 `1`。
- workItemId：`work_01M2YK36DRDB48FVDDJ2W8J4KV`。
- reportId：`report_01M2YK36E5G68Y1XNMSDD835BJ`。
- 原记录仍为 `blocked / fog_http_400`，由 `parentRunId` 保留关联，不再需要重试原记录。

验证：本地及服务器 Linux FOG 专项测试各 59 pass；完整 review/GitLab/CI 合约回归 484 pass、0 fail；Nine1Bot 类型检查通过。至此该 MR 的真实 FOG 接收验收通过。
