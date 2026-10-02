# Browser lifecycle and reference interaction regression checks

Automated checks (synthetic fixtures only):

```sh
bun test packages/browser-extension/test packages/browser-mcp-server/test
bun run --cwd packages/browser-extension typecheck
bun run --cwd packages/browser-mcp-server typecheck
bun run --cwd packages/browser-extension build
```

The relay tests load the real extension module in isolated subprocesses with fake Chrome APIs, sockets, and timers. They cover blank/empty groups, managed-target validation, stale socket callbacks, delayed bootstrap completion, reconnect pairing refresh, command cancellation and reused IDs. The integrated bridge-to-relay fixtures also cover restricted-page bootstrap errors versus native CDP navigation, selected-tab dialogs and full-page screenshots, plus cancellation between debugger attachment/metrics and the next page command. Geometry tests execute the real generated scripts against a synthetic DOM, and exercise both bridge channels (a fake CDP WebSocket transport for bot mode). Launch tests use small local shell fixtures, never an installed browser; they cover early exit, spawn errors, noisy stderr, hanging fetches, repeated stop, already-exited children and graceful-termination failure.

Manual checks, when an authorized real browser is available:

1. Open the extension side panel from a new-tab or about:blank tab. List tabs, create another tab, then navigate the original tab to a normal test page. Repeat with an empty managed group. Check that content actions against restricted pages fail, and unrelated tabs remain untouched.
2. On a long test page, take a snapshot and click a reference below the fold in both user-browser and bot-browser modes. It should scroll instantly and click the element's current position. Repeat after the target is hidden or removed; no mouse input should be sent to stale coordinates.
3. Switch the configured relay origin while the old connection is closing or bootstrap is pending. Only the new relay should remain active. A command begun on the old relay must not reply on, cancel, or remove a command on the new relay, even when IDs are reused.
4. Start a Chrome executable that exits before exposing CDP (for example, a disposable test wrapper). The failure should promptly report the exit/error and a bounded stderr tail. A hung startup must time out and terminate only the child it launched. Existing browser processes, security flags and profile paths must remain unchanged.

Limits: synthetic DOM tests do not verify actual browser layout, clipping ancestors, overlays or painting timing. Real browser UI testing is a separate stage; it must not bypass browser access restrictions, install browsers, or use personal profiles without authorization.

## Stacked changes and tab-group compatibility

This batch is stacked on the browser protocol repair. CI runs for pull requests into feature branches as well as main, so the lifecycle diff can be checked against its protocol dependency before either is merged. Push-to-main triggers, release automation and workflow permissions are unchanged.

The baseline tab-group manager has one active group ID; this batch preserves that model and does not assume per-window recovery is available. [PR #51](https://github.com/contrueCT/nine1bot/pull/51) is separate work on per-window group recovery/resynchronization and overlaps relay target attachment, detachment and group lookup. Its changes are not included here. When integrating either branch across the other, reconcile those areas explicitly, rerun managed-group and reconnect tests, and manually check activation across browser windows. Connection-generation safety alone does not add per-window group recovery.
