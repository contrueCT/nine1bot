# Opt-in real Chrome regression

This suite exercises the production `BridgeServer`, direct bot CDP transport, and
**the built unpacked Nine1Bot MV3 extension installed in a real Chrome process**.
It uses a deterministic local HTML fixture and does not invoke an LLM, a paid API,
a remote website, or a user's browser/profile.

It is separate from the existing synthetic browser tests. The default workspace
`ci:test` discovers the entry point but skips the real suite. A skip, a passing
harness unit test, a typecheck, or an extension build is **not** a real-browser pass.

## Prerequisites

- Bun 1.4.2 for this real-Chrome fixture and installed workspace dependencies
  (ordinary project CI remains on Bun 1.3.14)
- An existing Chrome for Testing binary, supplied as an absolute `CHROME_PATH`
- A non-root account with working Chrome sandbox support
- Permission to run Chrome and access loopback HTTP/WebSocket endpoints in the
  selected execution environment
- TCP port 4096 free on `127.0.0.1`

Use the full Chrome for Testing binary, not `chrome-headless-shell` or a user's
regular Chrome. Chrome for Testing continues to support loading unpacked
extensions using `--load-extension`; branded Chrome removed this command-line
capability starting with Chrome 137. See the [Chromium announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY)
and [Chrome extension end-to-end testing documentation](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing).

Modern headless Chrome runs the same browser implementation, including extensions.
The harness explicitly uses `--headless=new`; it does not emulate `chrome.*` APIs.

If the environment blocks localhost or Chrome, stop and record the prerequisite
failure. Do not disable the sandbox, security policies, certificates, site
isolation, or an installed blocking policy. Do not tunnel or change routes to
work around an access denial. Run this suite only in an independently authorized
environment where those prerequisites are available.

## Local command

From the repository root:

```sh
bun install
bun run --cwd packages/browser-extension build
packages/browser-mcp-server/node_modules/.bin/tsc --project packages/browser-mcp-server/test/real-chrome/tsconfig.json
RUN_REAL_CHROME=1 \
  CHROME_PATH=/absolute/path/to/chrome-for-testing/chrome \
  REAL_CHROME_ARTIFACTS=/tmp/nine1bot-real-chrome-artifacts \
  bun test packages/browser-mcp-server/test/real-chrome/real-chrome.test.ts
```

The suite fails if explicitly enabled without its prerequisites. It does not
silently skip an unavailable Chrome binary or unloaded extension. Run it alone;
it owns the production relay's module-level singleton during the test.

Synthetic harness checks (no Chrome launch):

```sh
bun test packages/browser-mcp-server/test/real-chrome/harness.test.ts
```

## Isolation and cleanup

Each run creates two distinct disposable profiles using `mkdtemp`, and starts
only its own Chrome children. CDP uses ephemeral loopback ports discovered from
the corresponding profile's `DevToolsActivePort` file. No existing browser is
attached, stopped, or modified. There is no process-name/global kill command.
Profiles are removed after the owned process exits, including failure cleanup.
Cleanup awaits each owned resource with a 15-second deadline, attempts remaining
resources after any failure, and records and throws all failures. A passing run
requires both browser/profile disposal and HTTP/WebSocket server shutdown; a
cleanup timeout is never treated as a pass.

The fixture/relay binds `127.0.0.1:4096` **before the extension starts** because
4096 is the real extension's initial server origin. If another listener owns it,
the run fails without launching the extension. This prevents accidental pairing
with a running Nine1Bot instance. No server-origin patch or fake extension
bootstrap is used.

The test launcher uses only a disposable profile, local CDP, normal first-run
suppression, a fixed viewport, modern headless mode, and the actual unpacked
extension path. It deliberately does not call the production Chrome launcher,
whose launch flags are outside this suite's assertions. Bot automation still
runs through the production bridge and CDP implementation. Extension automation
runs through the actual relay and Chrome extension APIs.

## Covered behavior

Both channels exercise:

- Real tab creation and observable page load
- Snapshot and stable-target element lookup
- Form fill followed by an actual input-dispatched submit-button click
- Scrolling an offscreen target into view and clicking it
- Full-page PNG capture, including a height assertion beyond the viewport
- Navigation, back, forward, and reload with observable URL assertions

Additional lifecycle checks:

- An absent extension yields an explicit user-channel error while bot CDP works
- Bot new-tab URLs preserve encoded query values
- Bot closed targets reject commands without breaking a surviving tab
- Installed MV3 service worker, extension manifest identity, relay hello, actual
  supported tools, server origin, and paired server instance are verified
- An extension tool deadline rejects promptly and a later command succeeds
- Removing a real Chrome tab cancels its in-flight extension command
- Disconnecting the actual relay WebSocket rejects pending work, then the
  installed extension reconnects and executes a new command without reload
- Terminating the owned bot process rejects in-flight CDP work, reports bot
  unavailable, and leaves the independent extension channel usable

The service worker CDP connection is used only to verify extension identity and
remove a tab for fault injection. Interaction under test always uses the
production bridge. No fake Chrome API, simulated relay client, or replacement
page interaction implementation counts as real-browser evidence.

## Evidence and CI

`.github/workflows/browser-real-chrome.yml` runs on pull requests touching its
browser/config/launcher path filters, and can also be dispatched manually. PR
runs check out the exact PR head SHA, with `github.sha` used for manual dispatch.
It installs Chrome for Testing stable using `browser-actions/setup-chrome@v2`,
builds the extension, typechecks the harness, and runs the opt-in test. It is not a required check by default and
does not run on every pull request. Chrome stable is intentionally a moving
compatibility target; each run records the exact browser version and GitHub
artifact name contains the tested commit SHA.

The action's v1 `stable` channel installs branded Chrome, despite the workflow
step's name. The [v2 migration](https://github.com/browser-actions/setup-chrome/releases/tag/v2.0.0)
changes channel installs to Chrome for Testing. Before opening the fixture or
launching either browser, the runner records `CHROME_PATH --version` and requires
the full `Google Chrome for Testing` brand. A regular Chrome installation fails
with a prerequisite diagnostic rather than timing out waiting for an extension
that its command-line interface cannot load.

Only this workflow uses Bun 1.4.2. Bun 1.3.14 has an [upstream WebSocket shutdown
bug](https://github.com/oven-sh/bun/issues/36223): a server-initiated socket close
leaves the server's connection count nonzero and `await server.stop(true)` never
resolves. The required relay disconnect/reconnect check triggers that bug. The
workflow explicitly runs the socket-cleanup regression before Chrome starts:

```sh
RUN_BROWSER_RUNTIME_CHECKS=1 bun test packages/browser-mcp-server/test/real-chrome/server-cleanup.test.ts
```

This runtime-only check opens no browser. It fails on Bun 1.3.14 and passes on
the fixture's pinned Bun 1.4.2. Ordinary CI skips it explicitly while retaining
the synthetic cleanup-helper tests. The real-Chrome integration itself is never
skipped or weakened because of a runtime cleanup failure. Project manifests and
the ordinary CI runtime pin are unchanged.

Artifacts include `evidence.json` with each completed step's pass/fail status,
the exact Bun version/revision, browser version responses, extension hello,
final runtime status, fixture-only screenshots, and bounded Chrome stderr.
The workflow also saves test stdout.
An interrupted run or one without `passed: true` is not a pass. Profile databases,
cookies, login state, and arbitrary user pages are never uploaded.

## Limits and current verification status

The initial implementation was validated with synthetic harness tests,
typechecking, and an extension build. **The real Chrome suite was not executed
in its development cloud environment**, where localhost browser access had been
blocked. A passing opt-in run on an authorized runner is still needed before
claiming real Chrome compatibility for this change.

This is a browser integration suite, not full application end-to-end coverage.
It does not test the web chat's edit/delete confirmations, IME input, search
modal keyboard behavior, refreshed drafts, live model responses, sign-in,
Chrome Web Store installation, permission prompts, the production Chrome
launcher, or other browsers/operating systems. Keep the corresponding unit,
component, protocol, and manual checks; this suite supplements them.
