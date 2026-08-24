---
name: platform.gitlab.gitlab-assisted-workflow
description: Use when a GitLab page or user request needs guided target resolution, project inspection, MR review, commit review, repository health review, or controlled publishing.
---

# GitLab Assisted Workflow

Use this workflow as the routing entry point for GitLab tasks. Keep the task scoped to the current GitLab target or the target explicitly named by the user.

## Classify the request

Classify the user request into one of these task types:

1. `mr-review`: review a merge request diff.
2. `commit-review`: review a single commit diff.
3. `repository-health`: inspect repository structure, configuration, and likely engineering risks.
4. `project-explain`: explain project metadata or structure.
5. `publish-note`: publish a review summary or note back to GitLab.
6. `setup-diagnosis`: explain GitLab CLI or platform configuration status.

If the target is ambiguous, resolve it from the current GitLab page context first, then from explicit URLs or identifiers in the user message. Every network read or write requires an explicit host. If the target remains ambiguous or hostless, ask for the missing host, project, MR IID, commit SHA, or URL.

## Context collection rules

- For MR review, first collect MR metadata and the default diff summary. Call the diff wrapper again with `includeDiff: true` only after the target is confirmed and raw diff is required for the review.
- For commit review, first collect the default commit diff summary. Call the diff wrapper again with `includeDiff: true` only after the target is confirmed and raw diff is required for the review.
- For repository health review, collect only the repository health context: README, root tree, CI/build/dependency manifests, and important file previews within budget.
- Do not broaden an MR or commit review into a repository-wide review unless the user explicitly asks for that broader task.
- Do not treat repository health review as a full audit.

## Execution boundaries

Use GitLab CLI wrapper capabilities when available. Do not run free-form `glab` commands through shell tools to bypass missing wrapper capabilities. If a needed wrapper capability is unavailable, report the capability gap and the exact information needed.

Write actions require explicit user intent and permission confirmation. Returning a report in chat does not require publishing to GitLab.

For `publish-note`, first render the note body in the response or run the publish wrapper with `dryRun: true`. Only call the non-dry-run publish wrapper after the user explicitly asks to publish, and rely on the runtime permission prompt for the final write gate.

## Output requirements

Always include:

- `target`: project path and MR IID or commit SHA when applicable.
- `scope`: what was inspected.
- `coverage`: what context was included and what was skipped.
- `result`: the findings, explanation, or requested action result.
- `nextActions`: concrete follow-ups when useful.

When the context is blocked, truncated, unavailable, or unauthenticated, say so directly and do not invent findings.
