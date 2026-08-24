---
name: platform.gitlab.gitlab-repository-health-workflow
description: Use for GitLab repository health or overview review based on bounded repository context, not full repository auditing.
---

# GitLab Repository Health Workflow

Repository health review is an overview and risk-routing workflow. It is not a full repository audit.

## Scope

Inspect only bounded repository context:

- README or project overview.
- Root tree.
- GitLab CI configuration when present.
- Dependency, build, runtime, and TypeScript configuration manifests when present.
- Important entry-point previews if the bounded context includes them.
- Recent MR summaries only when explicitly provided by a wrapper capability.

Do not read every file in the repository. Do not claim complete coverage.

## Review focus

Prioritize:

- Project structure and ownership boundaries.
- CI and release risks.
- Dependency and build risks.
- Authentication, authorization, token, secret, and data exposure hints.
- Testing and verification gaps.
- Areas that should receive follow-up MR or path-specific review.

## Output format

Return a concise structured report:

```text
Target: <project>
Scope: <context inspected>
Coverage: <included/skipped/truncated>

Summary:
- ...

Risks:
- [severity] [category] title
  Evidence: ...
  Recommendation: ...

Suggested follow-ups:
- ...
```

If the available context is too small for a useful assessment, stop after reporting the coverage gap and ask for a narrower path, ref, or MR target.
