# Task 4 Implementation Report

Status: DONE

## Commit Boundary

- Fixed base: `feac45e434f3eec7e59501e90227db2ba0dea679`
- Branch: `feat/gitlab-review-workflow`
- Commit subject: `fix(gitlab): validate project profile representations`
- Commit SHA: recorded in the final handoff because a commit cannot embed its own content-derived SHA.

## Result

Task 4 now validates every present GitLab project-profile representation independently. Missing properties remain absent configuration, while own properties containing `undefined`, `null`, or another invalid value produce a structured issue with `code`, `logicalField`, and the exact `sourceKey`. Runtime parsing selects only valid representations in canonical-first order; a valid canonical or alias never suppresses diagnostics from another invalid representation.

The Web editor consumes the same descriptor and selection implementation. Unrelated edits retain invalid canonical values, aliases, explicit nulls, unknown fields, and the existing root structure. Serialization validates the raw entries before canonicalization. Changing a logical field clears only that field's canonical and alias representations and writes one canonical value.

## TDD Evidence

Baseline focused matrix before test edits:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts web/test/gitlab-project-profile.test.ts web/test/use-settings-platforms.test.ts --timeout 30000
```

Result: exit `0`; `144 pass`, `0 fail`, `539 expect() calls`; 144 tests across 3 files.

RED after adding the Task 4 backend, Web, and complexity matrices:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts web/test/gitlab-project-profile.test.ts --timeout 30000
```

Result: exit `1`; `137 pass`, `12 fail`, `530 expect() calls`; 149 tests across 2 files.

The failures demonstrated:

- The shared descriptor, representation validator, selector, and deterministic truncation test interface did not exist.
- Backend errors lacked `sourceKey` suffixes and `??` selection dropped valid aliases behind invalid canonicals.
- Web validation missed invalid aliases behind valid canonicals, invalid identity canonicals made otherwise repairable entries non-editable, and explicit null/CI collisions did not block save with field diagnostics.
- The old context truncation test still relied on elapsed wall-clock time.

Initial two-file GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts web/test/gitlab-project-profile.test.ts --timeout 30000
```

Result: exit `0`; `149 pass`, `0 fail`, `701 expect() calls`; 149 tests across 2 files.

The CI repair test was then strengthened to repair `maxJobLogs` and `maxJobLogBytes` separately. It proves that repairing one logical CI field preserves the other field's raw invalid alias and continues blocking serialization until that second field is repaired.

## Shared Interfaces

- `validateGitLabReviewProjectProfileRepresentations(entry)` returns one issue per invalid own-property representation.
- `selectGitLabReviewProjectProfileValue(entry, descriptor)` skips invalid values and selects the first valid canonical/alias representation.
- `gitLabReviewProjectProfileInputDescriptors` and its ordered list describe profile and nested CI source keys once for backend parsing, Web parsing, validation, raw repair, and canonicalization.
- `hasGitLabReviewProjectProfileRepresentation()` preserves the distinction between a missing required field and a present invalid field.
- `GitLabProjectProfileDiagnostic` now includes `field?: string`; representation diagnostics set it to the invalid source key.
- `truncateGitLabReviewContextBlock()` exposes the existing production truncation boundary for deterministic functional and complexity verification.
- `@nine1bot/platform-gitlab/review/project-profile-input` is a browser-safe package subpath, so Web does not import the Node-dependent review barrel.

## Representation Coverage

The shared descriptor covers:

- `id`, `host`, `projectId` / `project_id`, and `nine1botProjectID` / `nine1bot_project_id`.
- `pathWithNamespace` / `path_with_namespace`, `displayName` / `display_name`, and `enabled`.
- `reviewContextMarkdown`, `review_context_markdown`, `contextMarkdown`, and `context_markdown`.
- `reviewFocus` / `review_focus`, `includePathPrefixes` / `include_path_prefixes`, and `excludePathPatterns` / `exclude_path_patterns`.
- `maxContextBytes` / `max_context_bytes` and `maxFiles` / `max_files`.
- The `ci` object itself.
- `maxJobLogs`, `max_job_logs`, `maxFailedJobs`, and `max_failed_jobs`.
- `maxJobLogBytes` and `max_job_log_bytes`.

The tests cover valid-canonical/invalid-alias, invalid-canonical/valid-alias, and explicit-null collisions across identity, binding, strings, lists, numeric limits, and CI. Every one of the four context keys independently accepts 64,000 UTF-16 code units and rejects 64,001.

## Deterministic Complexity Evidence

The former `elapsedMs < 750` assertion was removed. The replacement spies on `TextEncoder.prototype.encode` and `String.prototype.codePointAt` while calling the production helper directly.

- Large ASCII and large multibyte truncations use at most two encoder calls, independent of input size.
- Code-point reads are bounded by input code units plus a fixed marker allowance.
- The implementation performs one forward code-point loop and does not encode prefixes, use `Array.from`, or repeatedly slice/join inside the loop.
- Functional assertions cover ASCII, Chinese plus emoji, a tiny budget, a complete marker when it fits, a deterministically truncated marker when it does not, UTF-8 byte limits, and intact surrogate pairs without replacement characters.

## Compatibility Decisions

- Existing backend error prefixes remain unchanged and compatible with `startsWith(...)`; representation errors append `:<sourceKey>` after the existing profile identifier.
- A completely missing required property retains its prior unsuffixed missing-field error. A present invalid property gets the structured source-key error, avoiding duplicate diagnostics.
- Runtime values remain canonical-first, but only among valid representations.
- Valid legacy aliases continue to parse and canonicalize on a successful save.
- Invalid list elements now invalidate that representation rather than being silently filtered; valid aliases can still supply the runtime value.
- Web serialization validates raw entries before canonicalization. Invalid raw data and unknown fields survive unrelated edit/render cycles unchanged in value and structure.
- CI fields are repaired independently. Changing one limit does not delete aliases for the other limit.
- The top-level settings-patch `null` clearing path was not changed; profile-entry null validation applies only inside `review.projects[]`.
- Non-array/invalid Web roots and unknown profile or CI extension fields retain their existing behavior.

## Final Verification

Required focused matrix:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts web/test/gitlab-project-profile.test.ts web/test/use-settings-platforms.test.ts --timeout 30000
```

Result: exit `0`; `151 pass`, `0 fail`, `710 expect() calls`; 151 tests across 3 files.

Typechecks:

- `bun run --cwd packages/platform-gitlab typecheck`: `tsc --noEmit`, exit `0`.
- `bun run --cwd web typecheck`: `vue-tsc -b`, exit `0`.

Web build:

- `bun run build:web`: exit `0`; Vite transformed 1,866 modules and completed the production build in 41.20 seconds.

Repository checks:

- `git diff --check`: exit `0`; only existing Windows LF-to-CRLF working-copy warnings were emitted.
- `.idea/` and `nine1bot.iml` remain untracked and outside the stage allowlist.
- No Task 3 production code or test region was changed.

## Files Changed

- `.superpowers/sdd/23-final-review-residual-hardening-implementation-plan/task-4-report.md`
- `packages/platform-gitlab/package.json`
- `packages/platform-gitlab/src/review/context-builder.ts`
- `packages/platform-gitlab/src/review/index.ts`
- `packages/platform-gitlab/src/review/project-profile-input.ts`
- `packages/platform-gitlab/src/review/settings.ts`
- `packages/platform-gitlab/test/gitlab-review.test.ts`
- `web/src/lib/gitlab-project-profile-document.ts`
- `web/src/lib/gitlab-project-profiles.ts`
- `web/test/gitlab-project-profile.test.ts`

## Self-review and Concerns

- Descriptor inventory matches every representation named by the Task 4 brief, including all four context keys and all six CI limit keys.
- Backend and Web do not maintain separate alias/validation descriptors.
- Raw updates preserve unchanged representations and extension fields; successful canonicalization happens only after a clean raw validation pass.
- The truncation loop is forward-only and its complexity assertions do not depend on machine speed.
- No known correctness blocker remains.
- Vite still reports its existing warning for a minified chunk larger than 500 kB. The build succeeds, and Task 4 does not alter chunking policy.

## Scoped Review Fix Round 1

The independent scoped review found no Critical issue, one Important test-evidence gap, and one Minor UI diagnostic issue.

- Important: the multibyte fixture did not require an emoji to survive truncation, so it could not kill a `codeUnits = 1` surrogate-splitting mutant.
- Minor: multiple invalid aliases shared the same Vue key and the visible diagnostic omitted `sourceKey`.

The fix adds an exact `markerBytes + 4` emoji boundary. A controlled `codeUnits = 1` mutant failed with `0 pass / 1 fail / 16 assertions`; the restored production algorithm passed with `1 pass / 0 fail / 25 assertions`. The assertion requires a complete emoji, rejects isolated high and low surrogates and replacement characters, and verifies a fatal UTF-8 round trip.

GitLab profile diagnostic keys and labels now come from the same exported Web document helpers used by `PlatformManager.vue`. A real three-alias CI validation fixture proves unique keys and visible `max_job_logs`, `maxFailedJobs`, and `max_failed_jobs` source fields without adding a DOM-only test dependency.

Post-fix verification:

- Task 4 focused matrix: `152 pass / 0 fail / 724 assertions`.
- Platform GitLab plus Web test suites: `258 pass / 0 fail / 1054 assertions`.
- Platform GitLab typecheck: exit 0.
- Web typecheck: exit 0.
- Web production build: exit 0; 1,866 modules transformed.
- `git diff --check`: exit 0.
