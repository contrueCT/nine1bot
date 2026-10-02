# Browser protocol behavior

Nine1Bot supports a page-scoped CDP channel to the server-side bot browser and a managed-tab channel through the user browser extension. Browser commands must return an error when the browser rejects the action; an empty success response is not a substitute for an unsupported operation.

## Dialogs

`browser_dialog` now requires `tabId`, obtained from `browser_status`, in addition to `action` (`accept` or `dismiss`) and optional `promptText`/`browser`. The HTTP endpoint `POST /browser/dialog?browser=bot|user` likewise requires `tabId` in its JSON body. Dialog commands go to that page, never the browser-level WebSocket or an arbitrary active tab. A missing target or absent dialog is an error.

## Screenshots

`fullPage: true` requests layout metrics and a screenshot clip covering the document, with capture beyond the viewport enabled. Both browser channels preserve this setting. If usable document bounds cannot be obtained, the request fails rather than silently returning a viewport image. The extension relay preserves PNG/JPEG format and JPEG quality when supplied through the bridge.

## File inputs

Automated upload is supported only in the bot browser, with an absolute path to a readable regular file on the bot browser host. The input ref must come from a current page snapshot. Missing files, unavailable targets, missing inputs and CDP errors are reported as failures.

User-browser upload is explicitly unsupported. A server path does not identify a file on the extension user's computer. Nine1Bot does not copy file contents across hosts or interpret server paths as user-computer paths. Select the file manually in the user browser, or explicitly use the bot browser with a file already available on its host.

## Navigation and errors

The extension forwards supported page commands through Chrome's debugger API, retaining wheel deltas and other CDP parameters. Reload, dialogs, DOM document/query operations and layout metrics use real protocol responses. Unsupported commands fail explicitly. Navigation `errorText`, extension tool `isError`, and malformed new-tab responses propagate to the caller. Bot new-tab creation uses Chromium's `PUT /json/new?<escaped-url>` format.

## Regression verification

Run these without a real browser or model credentials:

```sh
bun test packages/browser-extension/test packages/browser-mcp-server/test
bun test --cwd opencode/packages/opencode test/tool/browser-protocol.test.ts
bun run --cwd packages/browser-extension typecheck
bun run --cwd packages/browser-mcp-server typecheck
```

The automated tests use Chrome API mocks and a local fake CDP server. They verify command payloads, page targeting, error propagation, screenshot bounds, upload restrictions, HTTP validation and pending-command cleanup. They do not prove compatibility with every Chrome version or a live extension install.

For manual browser QA after deployment, use a disposable page with a long document, a file input, and alert/confirm/prompt controls. Verify scrolling; viewport versus full-page PNG/JPEG screenshots; reload; a dialog on a specifically selected tab; unreachable navigation; and bot upload to the chosen input. Check that closed or unmanaged targets, missing files, absent dialogs and unsupported user uploads return errors. Do not use personal files or real credentials for this check.
