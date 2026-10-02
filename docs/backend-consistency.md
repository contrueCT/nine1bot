# 对话与配置的一致性

配置保存由 `JsonFile` 在进程内按规范化文件路径串行化。先解析和校验，再用临时文件替换；Nine1Bot 持久文件与运行文件一起更新，第二个文件写入失败时回滚第一个文件。该机制不提供多个独立服务进程之间的文件锁，也不构成跨文件的断电事务。

Web 保存配置会更新真正参与加载的 Nine1Bot 配置源。独立 OpenCode 使用项目 `opencode.jsonc` / `opencode.json`，项目配置被禁用时使用指定的 `OPENCODE_CONFIG`。自定义供应商只修改原始配置，不把某个项目的有效配置反写到全局。配置版本用于使 Agent 缓存失效；已有会话有意冻结的 profile snapshot 仍按其原有语义保留。

MCP 新增/删除会持久保存，连接/断开是运行状态操作。删除使用无 `type` 的 `{ "enabled": false }` 覆盖标记，防止继承配置在重启后恢复该服务器。热更新按 Instance 维护状态，使用 JSONC 解析和校验；解析失败保留当前连接。外部文件修改按原有 30 秒检查周期生效，管理接口保存后立即同步当前 Instance。

会话的运行锁按 session ID 唯一，不再随目录字符串分裂。目录先规范化；同项目其他目录发起的会话请求会进入会话自己的工作目录，统一执行、取消和事件流。空会话可在同项目内改目录；跨项目需要新建会话。运行中删除返回 409，用户先停止并等待任务结束后再删除。失败不会清除前端会话和草稿。

Controller/Web 使用 `requestID` 作为客户端幂等标识，由服务端生成用于消息排序的 `messageID`，客户端时钟和旧草稿的创建时间不会影响轮次顺序。`requestID` 必须匹配 `req_[A-Za-z0-9_-]{1,124}`，不能与 `messageID` 同时提供。旧客户端的 `messageID` 仍受支持，点号等合法文件名字符可以保留，路径分隔符和 NUL 不可用于消息标识；两个标识都未提供时才按新请求处理。

新请求的指纹取自经过协议校验、尚未富化或编译的原始内容。已接受的相同请求会在重新读取页面元数据、应用服务端提示词或编译之前返回原轮次结果。相同标识对应的原始内容变化，或跨会话复用，返回明确的请求冲突 409，不作为会话忙碌处理。

Controller 在异步会话目录路由和回执查询之前注册轻量取消记录；已接受请求直接重放，不占运行锁。新请求在页面上下文富化和编译之前取得可取消的会话运行锁，准备完成后将同一个锁交给消息接纳及执行流程。Stop 会取消准备中的请求，并在异步准备返回后阻止消息保存；并发发送的相同标识和内容共享结果，不会在 Stop 后排队自动重启。准备失败会释放运行锁，用户可以显式重试；HTTP 连接断开不等同于 Stop。完整消息保存后即使收到取消，也会先保留 accepted 回执，后续重试仅核对原接纳结果。

接纳过程在同一请求锁内先持久化服务端消息 ID 的 `reserved` 映射，再保存消息和 parts，最后写入 `accepted` 回执。回执、反向映射和会话索引采用同目录临时文件、完整写入检查、文件同步和原子替换；损坏的回执保留并阻止后续重试，不能把损坏当成记录不存在。这里不承诺多个独立服务进程的互斥或跨文件断电事务。

如果保存失败时尚未产生消息或 parts，原请求可安全重试。已有部分内容落盘但未完成接纳时，返回 `REQUEST_INCOMPLETE`，保留原请求供检查，不能仅凭历史中出现 user 消息认定发送成功。用户明确清理未完成消息后，可以重试原请求。删除已接受消息或最后一个 part 会保留无正文的幂等回执，原标识只能重放接纳结果，不能重新执行；删除整会话则通过会话索引清理全部相关回执，旧会话目标的重试返回 404，不创建新消息。新会话的新操作应使用新 `requestID`。

历史消息接口失败时保留当前显示内容，并继续应用成功取得的会话运行状态；已明确接纳的重放不需要再次 POST 来恢复历史。页面保留历史同步错误，重试历史加载只执行读取，过期快照不能覆盖新会话或新一轮恢复。

从 `opencode/packages/opencode` 运行针对性回归：

```sh
bun test test/server/config-regressions.test.ts test/server/config-transaction.test.ts
bun test test/server/mcp-config-regressions.test.ts
bun test test/server/session-lifecycle-regressions.test.ts test/session/run-lease.test.ts test/session/busy.test.ts
bun test test/session/request-replay.test.ts test/server/controller-admission.test.ts
bun test test/server/nine1bot-agent.test.ts
```

既有 `config/config.test.ts` 会尝试安装插件依赖，离线或隔离验证时可设置 `OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL=true`。配置源、项目目录和运行文件需要使用不同路径，才能覆盖实际启动布局。
