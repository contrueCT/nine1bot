# Nine1Bot GitLab Platform Adapter

This package is the reference layout for third-party platform integrations.
Platform-specific parsing, page normalization, context blocks, template
contributions, and resource contributions belong here instead of in the
Nine1Bot Runtime core.

## Boundary

- Browser extension code should collect DOM facts and call this package.
- Web code may use browser-safe helpers from `@nine1bot/platform-gitlab/browser`.
- Nine1Bot product startup registers the runtime adapter from
  `@nine1bot/platform-gitlab/runtime`.
- OpenCode / Nine1Bot Runtime core must only depend on the generic platform
  adapter registry, not this package directly.

## Code Review Plugin

See the [implementation documentation index](./docs/review-implementation/README.md)
for the current architecture and the
[GitLab CLI platform tool migration](./docs/review-implementation/24-gitlab-cli-platform-tools-migration.md)
for the interactive workflow. GitLab webhook parsing, MR context loading,
review orchestration, and comment publishing stay inside this platform package
while only generic context/resource contributions are exposed to the controller
and runtime.

## GitLab CLI Assisted Workflows

Interactive GitLab page sessions can use declared wrapper tools backed by the
local `glab` installation. The model cannot run arbitrary CLI commands and does
not receive the GitLab token or auth configuration.

Supported entry points include bounded repository health inspection, merge
request review, commit review, and permission-gated review publishing. Install
`glab`, authenticate the host with `glab auth login`, configure `allowedHosts`
when host restriction is required, and verify the GitLab CLI card on the
platform status page.

Automatic webhook Review remains a separate workflow. It continues to use the
frozen ReviewRun/context pipeline and the bounded `gitlab_ci_inspect` REST tool;
it does not receive the interactive CLI wrappers.

## Adding Another Platform

Use this package as the copyable example:

1. Create `packages/platform-<name>`.
2. Keep pure URL/page parsing in the platform package.
3. Export browser-safe helpers separately from runtime adapter helpers.
4. Register the adapter from the Nine1Bot product layer.
5. Add tests in the platform package for parser, payload, templates, and
   resources.
