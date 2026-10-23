# 聊天修复回归验证

在仓库根目录、依赖准备完成后执行：

```sh
bun run review-evidence/nine1bot-chat-review-repro.ts
bun run review-evidence/nine1bot-background-status-repro.ts
bun test web/test/session-live-state.test.ts web/test/use-parallel-sessions.test.ts web/test/app-global-session-events.test.ts web/test/composer-stop-lifecycle.test.ts web/test/session-send-reliability.test.ts
```

复现脚本现已加入修复后的断言，调用仓库实际模块并替换 API 和事件来源，不连接后端或模型。脚本通过相对源码导入和 `import.meta.url` 定位文件，可从其他工作目录运行。

- `BUSY_RETRY_EDIT`: 明确 busy 拒绝后 `submitted: false`，可以再次 POST（`posts: 2`）并编辑原文。未知发送结果仍保持只读回执，由正式测试覆盖。
- `QUESTION_AFTER_STALE_LIST`: 已回答问题保持为空。
- `PARTS_AFTER_REMOVE_EVENT`: 仅保留 `part-one`。
- `GLOBAL_IDLE`: 全局 idle 后 `stillRunning: false`。

正式测试额外覆盖当前会话保护、跨目录状态恢复、迟到快照、失效连接、HTTP 失败保留状态、本地回答后的迟到列表、删除事件与积压 delta，以及真实 InputBox 的重试/编辑按钮。
