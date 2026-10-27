# Web browser regression

The suite mounts production Vue components through Vite and runs the real
DOMPurify, native Markdown Worker and xterm. HTTP terminal responses are local
fixtures with controllable delays. It uses no model credentials or inference.

Run the automated suite with an installed Chrome or Chromium:

```sh
RUN_WEB_BROWSER=1 CHROME_PATH=/path/to/chrome bun test web/test/browser-regression.test.ts
```

For a visible run, start `bun web/test/browser/fixture-server.ts` and open the
printed localhost URL. The page runs the same nine cases and displays a report.
The dedicated GitHub workflow executes the automated suite for web changes.
Ordinary Bun tests explicitly skip it when `RUN_WEB_BROWSER` is unset.

Coverage includes reset/live-output races, late screen responses, output batching,
viewer remounts without redundant buffer reads, retained-window trimming,
coherent screen recovery when a truncated raw ring loses persistent prompt/TUI state, actual
HTML sanitization on both render paths, and native Worker cancellation.

The Blob case exercises the native URL registry and fetch while stubbing only the
window host. It checks that loading keeps the URL readable and closing revokes it.
Actual popup navigation/reload remains a separate manual acceptance check; the
suite does not claim to verify that browser behavior.
