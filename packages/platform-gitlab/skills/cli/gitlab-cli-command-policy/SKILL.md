---
name: platform.gitlab.gitlab-cli-command-policy
description: Use whenever GitLab CLI-backed capabilities are available so model behavior stays within wrapper tools, context budgets, and publishing permission boundaries.
---

# GitLab CLI Command Policy

GitLab CLI is a backend execution detail. Do not expose it as a free-form command surface.

## Allowed behavior

- Use declared GitLab wrapper capabilities for status, target resolution, project snapshots, MR snapshots, bounded diffs, commit diffs, repository health context, and controlled publishing.
- Prefer structured wrapper outputs over raw command output.
- Preserve `coverage`, `skipped`, and `truncated` fields in reasoning and final summaries.
- Keep target identity stable: host, project path, MR IID, commit SHA, ref, and file path.
- Use dry-run for publishing previews when the user has not explicitly confirmed the write.

## Disallowed behavior

- Do not run arbitrary `glab` commands via shell tools for GitLab workflows.
- Do not fetch full repository contents unless a wrapper capability explicitly returns a bounded context.
- Do not paste full diffs, full repository trees, full file contents, tokens, auth config, or raw CLI diagnostics into long-term context.
- Do not publish comments, discussions, hook changes, or settings changes without explicit user intent and permission.
- Do not include full note bodies in command summaries or diagnostic output after publishing.

## Failure behavior

If GitLab CLI is missing, unauthenticated, or cannot resolve the target:

1. Report the exact missing prerequisite.
2. Keep the response scoped to diagnosis or next setup steps.
3. Do not fall back to uncontrolled shell commands.

If wrapper output is truncated or skipped:

1. Use only the included evidence.
2. State the skipped context.
3. Suggest a narrower follow-up if needed.
