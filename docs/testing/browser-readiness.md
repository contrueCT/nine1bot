# Browser settings and first-run readiness

Open Settings → 浏览器与就绪检查. This checklist reads existing persisted configuration and the current bridge status. It never launches Chrome, validates provider credentials, or makes a model/inference request. A selected model or existing executable is **not** proof that the model or Chrome works.

`browser.executablePath` is optional. Omit it for auto-detection; set an absolute executable filename on the **Nine1Bot server**, including spaces without shell quoting. Saving an empty UI field clears the override. The path is passed as a spawn filename, never evaluated as a shell command. Windows drive/UNC paths and POSIX absolute paths are supported. CDP ports must be integers 1–65535.

Browser settings apply after a service restart. The checklist compares the saved configuration with the current bridge where available, and labels the bot CDP channel and extension relay independently. A disconnected optional channel does not invalidate the other channel. A status failure is reported as unknown, never as success. Existing legacy-port and extension pairing diagnostics remain visible.

Startup diagnostics include next steps for missing executables, permissions, unavailable display, sandbox failures, profile locks, and CDP startup timeout. Sandbox failures require a supported non-root environment with a working sandbox, never a sandbox bypass. Do not remove active profile locks.

## Verification

Focused tests cover schema/path/port validation, read-only readiness, absence of fetch/model calls when reading config, no credential leakage, executable filesystem inspection, saved/runtime mismatch, unknown connection states, config routes, clear/reload persistence, and existing synthetic child lifecycle tests. Frontend API tests cover endpoint/payload and rejected saves; Vue typechecking and production build check component integration.

The lifecycle fixtures are synthetic processes, **not real Chrome**. This cloud environment previously returned `ERR_BLOCKED_BY_CLIENT` for local browser access; no flags, alternate browser routes, or sandbox disabling were used to bypass it. Actual UI interaction and real Chrome/extension execution have not been claimed here. See [real Chrome suite](real-chrome.md) for the separate opt-in integration harness and its own execution record.
