# Browser lifecycle and reference interaction regression checks

Automated checks (synthetic fixtures only):

```sh
bun test packages/browser-extension/test packages/browser-mcp-server/test
bun run --cwd packages/browser-extension typecheck
bun run --cwd packages/browser-mcp-server typecheck
bun run --cwd packages/browser-extension build
```

The relay tests load the real extension module in isolated subprocesses with fake Chrome APIs, sockets, and timers. They cover blank/empty groups, managed-target validation, stale socket callbacks, delayed bootstrap completion, reconnect pairing refresh, command cancellation and reused IDs. Commands are registered before asynchronous target resolution; real computer inputs and native CDP commands revalidate cancellation, connection ownership, managed-group membership and page restrictions before dispatch after awaits. Regression cases include stop during debugger attachment, stop between input events, group departure before Chrome delivers an update event, native timeout, and superseding a reconnect backoff with a failing manual attempt. The integrated bridge-to-relay fixtures also cover restricted-page bootstrap errors versus native CDP navigation, selected-tab dialogs and full-page screenshots, plus cancellation between debugger attachment/metrics and the next page command. Geometry tests execute the real generated scripts against a synthetic DOM, and exercise both bridge channels (a fake CDP WebSocket transport for bot mode). Launch tests use small local shell fixtures, never an installed browser; they cover early exit, spawn errors, noisy stderr, hanging fetches, repeated stop, already-exited children and graceful-termination failure.

Manual checks, when an authorized real browser is available:

1. Open the extension side panel from a new-tab or about:blank tab. List tabs, create another tab, then navigate the original tab to a normal test page. Repeat with an empty managed group. Check that content actions against restricted pages fail, and unrelated tabs remain untouched.
2. On a long test page, take a snapshot and click a reference below the fold in both user-browser and bot-browser modes. It should scroll instantly and click the element's current position. Repeat after the target is hidden or removed; no mouse input should be sent to stale coordinates.
3. Switch the configured relay origin while the old connection is closing or bootstrap is pending. Only the new relay should remain active. A command begun on the old relay must not reply on, cancel, or remove a command on the new relay, even when IDs are reused.
4. Start a Chrome executable that exits before exposing CDP (for example, a disposable test wrapper). The failure should promptly report the exit/error and a bounded stderr tail. A hung startup must time out and terminate only the child it launched. Existing browser processes, security flags and profile paths must remain unchanged.

Cancellation prevents additional page operations at the checked boundaries; it cannot undo a command Chrome has already accepted. If this command successfully pressed a button or key, it attempts only the corresponding release while it still owns the same connected, managed target. Cleanup sends no pointer move and uses mouse clickCount 0; it is skipped if the tab leaves the group, the connection changes, or a newer press of that same button/key takes ownership. Read-only commands do not take input ownership; pending competing presses are awaited for at most one second before cleanup is abandoned. Active-group revisions invalidate commands/cleanup even if the group changes during a Chrome lookup. UI state reporting is detached from command settlement and version-guarded so it cannot delay a cancel/timeout reply or overwrite newer activity. Mouse/key release can itself invoke page handlers, so this is bounded best-effort cleanup, not a rollback of accepted input. Tests pause before dispatch, between press/release and during drag to verify these boundaries.

Limits: synthetic DOM tests do not verify actual browser layout, clipping ancestors, overlays or painting timing. Real browser UI testing is a separate stage; it must not bypass browser access restrictions, install browsers, or use personal profiles without authorization.

## Stacked changes and tab-group compatibility

This batch is stacked on the browser protocol repair. CI runs for pull requests into feature branches as well as main, so the lifecycle diff can be checked against its protocol dependency before either is merged. Push-to-main triggers, release automation and workflow permissions are unchanged.

The baseline tab-group manager has one active group ID; this batch preserves that model and does not assume per-window recovery is available. [PR #51](https://github.com/contrueCT/nine1bot/pull/51) is separate work on per-window group recovery/resynchronization and overlaps relay target attachment, detachment and group lookup. Its changes are not included here. When integrating either branch across the other, reconcile those areas explicitly, rerun managed-group and reconnect tests, and manually check activation across browser windows. Connection-generation safety alone does not add per-window group recovery.
