# Task 3 Implementation Report

Status: DONE

## Commit Boundary

- Required Task 2 dependency: `783efcfeeaf2294658d94059eec5efbb5dd9fc3e`
- Task 3 implementation: `7fc88d05c327b5ca9cdbeeb8207c47682fbcab74` (`fix(gitlab): preflight complete publication plans`)
- Review fix round 1 subject: `test(gitlab): cover encoded publication preflight`
- Review fix round 1 SHA: the commit containing this report; its exact SHA is recorded in the final handoff because a commit cannot embed its own content-derived SHA.

## Result

Task 3 prepares one deeply frozen GitLab review publication plan immediately after raw stage parsing. The controller passes the same plan through reconciliation, publication, and completion. Every possible outbound publication body is rendered and encoded before token resolution, initial HEAD verification, payload hashing, claim acquisition, reconciliation, or other GitLab access.

The parsed stage result remains the payload-hash source. The prepared plan is not part of hash calculation.

## Scoped Review Fix Round 1

Review verdict: APPROVE, with no Critical or Important findings and one Minor test-depth gap. The gap was controller and management-route coverage for a real publication that passes raw, aggregate, and rendered budgets but exceeds the encoded outbound form budget.

No production behavior changed in this round. Only the controller test, management route test, and this report changed.

### Fixture validation

The fixture uses 60 distinct findings. Each has a unique near-4,096-code-unit file path containing repeated two-byte Unicode characters. Summary-only MR publication renders each path in both its file-group heading and finding location. This remains a real public publication path with `review.inlineComments=false`.

The first probe retained inline comments. Invalid-position warnings repeated every long file path and produced `732,690` rendered code units and `1,451,970` rendered UTF-8 bytes. That probe exceeded the rendered limits and was rejected before any test edit because it did not isolate encoded overflow.

The accepted probe measured:

- Raw snapshot: `240,147` code units and `479,907` UTF-8 bytes, within `256,000` and `512,000`.
- Largest aggregate body: `1` code unit and `1` UTF-8 byte, within `256,000` and `512,000`.
- Final rendered summary with markers: `488,416` code units and `967,936` UTF-8 bytes, within `512,000` and `1,024,000`.
- Actual `URLSearchParams.toString()` form: `2,889,075` UTF-8 bytes, above `2,000,000`.

The tests independently assert each budget relationship, then invoke public `prepareGitLabReviewPublicationPlan()`, the real controller publication entry, and the real management route. They do not mock the plan builder or synthesize an error.

### Added coverage

- First controller publication returns the exact `gitlab_review_publication_input_too_large` result with zero secret reads, zero claim calls, zero GitLab requests, and no publication object.
- Existing partial resume returns the same stable result with zero secret reads, claims, or GitLab requests and preserves the complete prior publication/checkpoint object.
- Management publication returns HTTP 413 and the stable error with zero claim calls, zero GitLab requests, and no publication object.

### Fix-round verification

Focused behavior tests:

```powershell
bun test packages/nine1bot/src/review/gitlab-controller.test.ts -t "encoded form expansion" --timeout 30000
bun test opencode/packages/opencode/test/server/webhooks-status.test.ts -t "form encoding expands" --timeout 30000
```

Results:

- Controller: `2 pass`, `0 fail`, `97 filtered`, `29 expect() calls`.
- Management route: `1 pass`, `0 fail`, `24 filtered`, `14 expect() calls`.

Affected-file regression:

```powershell
bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
```

Result: exit `0`; `124 pass`, `0 fail`, `612 expect() calls`; 124 tests across 2 files in 5.68 seconds.

Task 3 complete regression:

```powershell
bun test packages/platform-gitlab/test packages/nine1bot/src/review opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
```

Result: exit `0`; `297 pass`, `0 fail`, `1286 expect() calls`; 297 tests across 5 files in 7.28 seconds.

Typechecks:

- `bun run --cwd packages/platform-gitlab typecheck`: `tsc --noEmit`, exit `0`.
- `bun run --cwd packages/nine1bot typecheck`: `tsc --project tsconfig.check.json`, exit `0`.
- `bun run --cwd opencode/packages/opencode typecheck`: `tsgo --noEmit`, exit `0`.

Pre-stage checks:

- `git diff --check`: exit `0`; only existing LF-to-CRLF working-copy warnings were emitted.
- Tracked implementation diff: exactly two test files before this report update; no production files.
- Credential signature scan: clean.

## TDD Evidence

### Slice 1: Raw-valid aggregate expansion and immutable snapshot

Controller RED:

```powershell
bun test packages/nine1bot/src/review/gitlab-controller.test.ts --timeout 30000
```

Result: `95 pass`, `2 fail`, `491 expect() calls`, 97 tests.

- First publication returned `gitlab_api_publish_result_failed:gitlab_review_publication_input_too_large` instead of the stable domain error.
- Resumed publication reached GitLab and returned `gitlab_api_publish_result_failed:GitLab merge request metadata response is invalid`.
- The failures demonstrated late budget enforcement after claim/network work.

Prepared-plan API RED:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts --timeout 30000
```

Result: `125 pass`, `1 fail`, `439 expect() calls`.

- Expected `prepareGitLabReviewPublicationPlan` to be exported; received `undefined`.

GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts --timeout 30000
```

Result: `223 pass`, `0 fail`, `951 expect() calls`.

The fixture uses 500 same-key findings and the canonical `\n\n` aggregate separator. Raw input is exactly within the 256,000 code-unit snapshot budget, while aggregate expansion exceeds its limit. First and resumed publication both return `gitlab_review_publication_input_too_large` with zero secret reads, claims, or GitLab requests. The resumed case preserves its prior publication object exactly.

### Slice 2: Rendered and encoded exact boundaries

RED:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts --timeout 30000
```

Result: `126 pass`, `3 fail`, `456 expect() calls`, 129 tests.

- Two failures showed the shared encoder was absent.
- The real discussion 400 fallback body still contained arbitrary GitLab response text (`position is invalid`).

During GREEN implementation, the checkpoint regression isolated a direct-publisher compatibility defect: callers supplied the run ID through `publication.runId`, while the new entry plan initially read only top-level `runId`. The focused checkpoint test observed summary and inline POSTs without marker checkpoints. Plan preparation was corrected to use `input.runId ?? input.publication?.runId`.

Focused checkpoint GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "awaits the summary checkpoint" --timeout 30000
```

Result: `1 pass`, `0 fail`, `128 filtered`, `3 expect() calls`.

Slice GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts --timeout 30000
```

Result: `129 pass`, `0 fail`, `485 expect() calls`.

Verified boundaries:

- Aggregate code units and UTF-8 bytes accept the exact limit and reject limit plus one.
- Rendered body code units accept 512,000 and reject 512,001.
- Rendered body UTF-8 bytes accept 1,024,000 and reject 1,024,001.
- Actual `URLSearchParams.toString()` UTF-8 bytes accept 2,000,000 and reject 2,000,001.
- Form cases include ASCII, Chinese text, emoji, newlines, commit-note `note`, MR-note `body`, and nested discussion position fields.
- Summary, summary fallback, inline discussion, and deterministic inline-400 fallback all store encoded byte results from the shared encoder.
- GitLab 400 response detail remains bounded to returned warnings and is absent from the preflighted fallback body.

### Slice 3: Prepared reconciliation and completion

RED:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "reconciles current markers from a prepared plan" --timeout 30000
```

Result: `0 pass`, `1 fail`, `129 filtered`.

- Failure: `prepared reconciliation read summary`.
- Accessor traps demonstrated reconciliation still read raw publication fields.

Focused GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "reconciles current markers from a prepared plan" --timeout 30000
```

Result: `1 pass`, `0 fail`, `129 filtered`, `3 expect() calls`.

Combined GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts packages/nine1bot/src/review/gitlab-controller.test.ts --timeout 30000
```

Result: `227 pass`, `0 fail`, `989 expect() calls`.

Prepared reconciliation now consumes the frozen finding snapshot, base warnings, publication layout, and marker catalog. Current prepared paths do not aggregate findings or render outbound operations again. Historical marker and body reconstruction remains available for bounded legacy compatibility.

### Slice 4: Management HTTP 413

The route integration initially passed because Slice 1 had already established the required ordering. A controlled regression moved plan preparation behind the initial HEAD request to prove the route test detects ordering violations.

Controlled RED:

```powershell
bun test opencode/packages/opencode/test/server/webhooks-status.test.ts -t "returns domain 413" --timeout 30000
```

Result: `0 pass`, `1 fail`, `23 filtered`, `5 expect() calls`.

- Expected zero GitLab requests; observed one MR metadata `GET`.

Restored GREEN:

```powershell
bun test opencode/packages/opencode/test/server/webhooks-status.test.ts -t "returns domain 413" --timeout 30000
```

Result: `1 pass`, `0 fail`, `23 filtered`, `6 expect() calls`.

The domain route test sends a management request within the 2,000,000-byte transport limit whose canonical aggregation exceeds the publication budget. It receives HTTP 413 with the exact stable error, zero claim calls, zero GitLab requests, and no publication object. The existing transport-level 413 test remains unchanged and passing.

### Slice 5: Deep API guard

RED:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "rejects an oversized direct" --timeout 30000
```

Result: `0 pass`, `2 fail`, `130 filtered`, `2 expect() calls`.

- Oversized direct `createNote` and `createDiscussion` promises resolved and reached fetch.

GREEN:

```powershell
bun test packages/platform-gitlab/test/gitlab-review.test.ts -t "rejects an oversized direct" --timeout 30000
```

Result: `2 pass`, `0 fail`, `130 filtered`, `4 expect() calls`.

Both API methods now construct and recheck their actual forms with the same pure encoder used by preflight. Oversized direct calls throw `GitLabReviewPublicationBudgetError` before fetch.

## Final Verification

Post-format required regression:

```powershell
bun test packages/platform-gitlab/test packages/nine1bot/src/review opencode/packages/opencode/test/server/webhooks-status.test.ts --timeout 30000
```

Initial Task 3 commit result: exit `0`; `294 pass`, `0 fail`, `1243 expect() calls`; 294 tests across 5 files in 11.75 seconds. The current post-review result is recorded in Scoped Review Fix Round 1 above.

Typechecks:

```powershell
bun run --cwd packages/platform-gitlab typecheck
bun run --cwd packages/nine1bot typecheck
bun run --cwd opencode/packages/opencode typecheck
```

Results:

- `packages/platform-gitlab`: `tsc --noEmit`, exit `0`.
- `packages/nine1bot`: `tsc --project tsconfig.check.json`, exit `0`.
- `opencode/packages/opencode`: `tsgo --noEmit`, exit `0`.

Repository checks:

- `git diff --check`: exit `0`; only Git's existing LF-to-CRLF working-copy warnings were emitted.
- Tracked diff allowlist: exact match, 8 files.
- Credential signature scan: clean. Broad token/secret matches were test-only placeholders and secret-read counters.
- `.idea/` and `nine1bot.iml` remained untracked and outside the staged scope.

## Files and Interfaces Changed

- `packages/platform-gitlab/src/review/publication-budget.ts`
  - Adds `maxOutboundFormBytes`.
  - Adds `GitLabReviewPublicationFormInput`, `GitLabReviewEncodedPublicationForm`, and `encodeGitLabReviewPublicationForm()`.
- `packages/platform-gitlab/src/review/publisher.ts`
  - Adds `prepareGitLabReviewPublicationPlan()` and deeply readonly prepared operation types.
  - Allows `publishGitLabReviewResult()` and `isGitLabReviewPublicationComplete()` to consume the prepared plan.
  - Keeps synchronous defensive preparation for direct callers without a plan.
- `packages/platform-gitlab/src/review/publication-reconciliation.ts`
  - Allows `reconcileGitLabReviewPublicationMarkers()` to consume the prepared plan and marker catalog.
- `packages/platform-gitlab/src/review/api-client.ts`
  - Routes note and discussion forms through the shared encoder before request dispatch.
- `packages/nine1bot/src/review/gitlab-controller.ts`
  - Prepares the plan before token resolution, initial HEAD GET, payload hashing, claim, and reconciliation.
  - Threads one plan through reconciliation, head-guarded publication, and completion.
- `packages/platform-gitlab/test/gitlab-review.test.ts`
  - Adds immutable plan, exact boundary, deterministic fallback, prepared reconciliation, and deep API guard coverage.
- `packages/nine1bot/src/review/gitlab-controller.test.ts`
  - Adds first and resumed aggregate-expansion ordering coverage.
- `opencode/packages/opencode/test/server/webhooks-status.test.ts`
  - Adds domain HTTP 413 integration coverage.

`packages/platform-gitlab/src/review/index.ts` already exported publication budget and publisher modules, so no edit was needed. The webhook route already mapped the stable publication budget error to HTTP 413, so no route source edit was needed.

## Compatibility Decisions

- Canonical duplicate aggregation remains the existing `\n\n` behavior. No `Duplicates:` label was introduced.
- Payload hashes remain derived from `reviewStageResultHash(parsed)`.
- Controller publication writes continue through Task 2's `headGuardedPublicationClient`; no parallel write boundary was added.
- Existing current markers, legacy summary subsets, legacy run-level fallbacks, partial resume, claim ownership, payload mismatch, and commit publication behavior remain covered by the full regression suite.
- A real discussion POST 400 still triggers a note fallback. The note body is deterministic and preflighted; bounded GitLab response detail is returned only as a warning.
- Existing partial publication ownership and checkpoints remain unchanged when preflight fails.

## Self-review

- Aggregation occurs once while preparing the controller plan. Reconciliation and completion consume frozen prepared findings and markers.
- Every publisher POST body has a prepared encoded-byte result, and every API note/discussion POST receives the shared deep guard.
- Summary, inline, resumed summary fallback, and inline-400 fallback publication all use stored plan bodies.
- Finding objects, suggestions, duplicate findings, source arrays, operation arrays, positions, warning arrays, markers, and marker catalogs are copied and frozen.
- Plan preparation precedes all secret reads, GitLab access, claims, and reconciliation.
- Task 2 HEAD and ownership checks remain the controller's sole publication write boundary.
- No unrelated tracked files or credentials are present in the diff.

## Residual Risk and Concerns

- No known correctness blocker remains.
- Historical legacy reconciliation intentionally renders bounded compatibility candidates to recognize exact older comment bodies. It does not regenerate current outbound publication operations, and the legacy compatibility regression set passes.
- Exact outbound size behavior follows the runtime's standards-compliant `URLSearchParams.toString()` representation. Preflight and dispatch use the same implementation, preventing encoder drift inside this codebase.
- LF-to-CRLF warnings reflect the existing Windows working-tree configuration and do not produce `git diff --check` failures.
