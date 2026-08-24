import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { Hono } from "hono"
import { tmpdir } from "os"
import { join } from "path"
import { Instance } from "../../src/project/instance"
import { Webhook } from "../../src/webhook/webhook"
import { tmpdir as projectTmpdir } from "../fixture/fixture"
import {
  rejectGitLabReviewRuntimeConfiguration,
  reportGitLabReviewRunFailure,
} from "../../../../../packages/nine1bot/src/review/gitlab-controller"
import { ReviewRunStore } from "../../../../../packages/nine1bot/src/review/run-store"
import {
  aggregateReviewFindings,
  gitLabReviewFindingKey,
  gitLabReviewPublicationBudget,
  gitLabReviewPublicationMarker,
  parseReviewStageResult,
  prepareGitLabReviewPublicationPlan,
  renderReviewSummaryComment,
  type GitLabDiffManifest,
} from "../../../../../packages/platform-gitlab/src/review"
import {
  gitLabReviewPublishStatus,
  gitLabReviewCiNotQueriedPatch,
  gitLabReviewControllerResponsePatch,
  createWebhookPublicRoutes,
  gitLabReviewRuntimePatch,
  gitLabReviewRuntimeTools,
  gitLabReviewRuntimeFailure,
  gitLabReviewSessionCreatedPatch,
  gitLabReviewWebhookBodyLimit,
  publicGitLabReviewWebhookResult,
  publicGitLabReviewRun,
  resolveGitLabReviewRuntimeDirectory,
  startGitLabReviewRuntime,
  startGitLabReviewRuntimeRun,
  WebhookPublicRoutes,
  WebhookRoutes,
  webhookLocalOrigin,
} from "../../src/server/routes/webhooks"

describe("public GitLab webhook request limits", () => {
  test("rejects oversized JSON before validating missing or incorrect header tokens", async () => {
    const body = JSON.stringify({
      object_kind: "merge_request",
      padding: "x".repeat(gitLabReviewPublicationBudget.maxManagementRequestBytes),
    })
    const contentLength = new TextEncoder().encode(body).byteLength

    const cases = [
      { path: "/gitlab", token: undefined, declareLength: true },
      { path: "/gitlab", token: "incorrect-token", declareLength: false },
      { path: "/gitlab/incorrect-path-secret", token: undefined, declareLength: false },
    ] as const
    for (const { path, token, declareLength } of cases) {
      const response = await WebhookPublicRoutes().request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(declareLength ? { "content-length": String(contentLength) } : {}),
          ...(token ? { "x-gitlab-token": token } : {}),
        },
        body,
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        accepted: false,
        error: "gitlab_webhook_payload_too_large",
      })
    }

    const smallResponse = await WebhookPublicRoutes().request("http://localhost/gitlab", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "small",
    })
    expect(smallResponse.status).toBe(400)
    expect(await smallResponse.json()).toEqual({ accepted: false, error: "json_body_required" })
  })

  test("cancels declared oversized request streams before downstream work", async () => {
    let cancelled = false
    let downstream = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(gitLabReviewPublicationBudget.maxManagementRequestBytes + 1),
      },
      body,
      duplex: "half",
    } as any)
    const app = new Hono().post("/", gitLabReviewWebhookBodyLimit, (c) => {
      downstream = true
      return c.json({ accepted: true })
    })

    const response = await app.request(request)

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(downstream).toBe(false)
  })

  test("enforces the streaming boundary, rebuilds valid JSON, and releases failed readers", async () => {
    const maxBytes = gitLabReviewPublicationBudget.maxManagementRequestBytes
    const app = new Hono().post("/", gitLabReviewWebhookBodyLimit, async (c) => {
      const payload = await c.req.json<{ padding?: string; ok?: boolean }>()
      return c.json({ paddingLength: payload.padding?.length, ok: payload.ok })
    })
    const exactBody = exactSizeJsonBody(maxBytes)

    const exact = await app.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: exactBody,
    })
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(maxBytes)
    expect(exact.status).toBe(200)
    expect(await exact.json()).toEqual({ paddingLength: JSON.parse(exactBody).padding.length })

    const small = await app.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    })
    expect(small.status).toBe(200)
    expect(await small.json()).toEqual({ ok: true })

    let overflowCancelled = false
    const overflowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxBytes))
        controller.enqueue(new Uint8Array(1))
      },
      cancel() {
        overflowCancelled = true
      },
    })
    const overflowRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: overflowBody,
      duplex: "half",
    } as any)
    const overflow = await app.request(overflowRequest)
    expect(overflow.status).toBe(413)
    expect(overflowCancelled).toBe(true)
    expect(overflowRequest.body?.locked).toBe(false)

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream failed"))
      },
    })
    const failedRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: failedBody,
      duplex: "half",
    } as any)
    const failed = await app.request(failedRequest)
    expect(failed.status).toBe(400)
    expect(await failed.json()).toEqual({ accepted: false, error: "invalid_json_body" })
    expect(failedRequest.body?.locked).toBe(false)
  })
})

function exactSizeJsonBody(bytes: number) {
  const prefix = '{"padding":"'
  const suffix = '"}'
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`
}

describe("webhook status URL selection", () => {
  test("keeps a generic webhook run terminal when completion beats the controller response", async () => {
    await using project = await projectTmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const created = await Webhook.createSource({
          name: "Fast completion source",
          projectID: Instance.project.id,
          requestGuards: {
            dedupe: { enabled: false, ttlSeconds: 3600 },
            rateLimit: { enabled: false, maxRequests: 20, windowSeconds: 60 },
            cooldown: { enabled: false, seconds: 0 },
            replayProtection: { enabled: false, maxSkewSeconds: 300 },
          },
        })
        const app = createWebhookPublicRoutes({
          runner: async (input) => {
            const response = {
              accepted: true,
              sessionID: "session-fast-webhook",
              turnSnapshotId: "turn-fast-webhook",
              status: 202,
              response: { accepted: true, turnSnapshotId: "turn-fast-webhook" },
            } as any
            await input.onFinished?.({ status: "succeeded" })
            await input.onControllerResponse?.(response)
            return response
          },
        })

        const response = await app.request(
          `http://localhost/${created.source.id}/${created.secret}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ event: "push" }),
          },
        )

        expect(response.status).toBe(202)
        const [run] = await Webhook.listRuns({ sourceID: created.source.id })
        expect(run).toMatchObject({
          status: "succeeded",
          sessionID: "session-fast-webhook",
          turnSnapshotId: "turn-fast-webhook",
        })
        expect(run?.time.started).toBeNumber()
        expect(run?.time.finished).toBeNumber()
        expect(run!.time.finished!).toBeGreaterThanOrEqual(run!.time.started!)
      },
    })
  })

  test("does not move a terminal GitLab review run back to running", () => {
    const response = {
      accepted: true,
      turnSnapshotId: "turn_fast_completion",
    } as any
    const run = {
      id: "run_terminal",
      status: "succeeded",
      publishedAt: 42,
    } as any

    expect(gitLabReviewControllerResponsePatch(run, response)).toBeUndefined()
    expect(gitLabReviewControllerResponsePatch({ ...run, status: "failed", publishedAt: undefined }, response))
      .toBeUndefined()
    expect(gitLabReviewControllerResponsePatch({ ...run, status: "running", publishedAt: undefined }, response))
      .toEqual({ status: "running", turnSnapshotId: "turn_fast_completion" })
  })

  test("preserves a rejected GitLab review when publication refuses a stale MR head", () => {
    const rejected = {
      id: "run_rejected",
      status: "rejected",
      error: "gitlab_review_head_changed",
    } as any

    expect(gitLabReviewRuntimePatch(rejected, {
      status: "failed",
      error: "gitlab_review_head_changed",
    })).toBeUndefined()
  })

  test("preserves publication-owned states across late runtime callbacks", () => {
    const patch = { status: "failed" as const, error: "late_runtime_failure" }
    const run = {
      id: "run_publication",
      status: "failed",
      publication: {
        state: "partial",
        payloadHash: "payload-a",
        summaryMarker: "summary-marker",
        completedMarkers: ["summary-marker"],
        updatedAt: 42,
      },
    } as any

    expect(gitLabReviewRuntimePatch(run, patch)).toBeUndefined()
    expect(gitLabReviewRuntimePatch({
      ...run,
      status: "running",
      publication: { ...run.publication, state: "publishing", claimId: "claim-b", ownerId: "owner-b" },
    }, patch)).toBeUndefined()
    expect(gitLabReviewRuntimePatch({
      ...run,
      status: "succeeded",
      publication: { ...run.publication, state: "published" },
    }, patch)).toBeUndefined()
  })

  test("preserves publishing, partial, and published records through actual runtime callbacks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-publication-callbacks-"))
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const payloadHash = "a".repeat(64)

    try {
      for (const state of ["publishing", "partial", "published"] as const) {
        const run = ReviewRunStore.create({
          platform: "gitlab",
          status: state === "published" ? "succeeded" : state === "partial" ? "failed" : "running",
          error: state === "partial" ? "preserved_partial_error" : undefined,
          publishedAt: state === "published" ? 42 : undefined,
          trigger: {
            host: "gitlab.example.com",
            projectId: 123,
            objectType: "mr",
            objectIid: 10,
            headSha: `${state}-head`,
            mode: "webhook",
          },
          publication: {
            state,
            claimId: state === "publishing" ? `claim-${state}` : undefined,
            ownerId: state === "publishing" ? `owner-${state}` : undefined,
            payloadHash,
            startedAt: 10,
            updatedAt: 20,
            summaryMarker: `summary-${state}`,
            completedMarkers: [`marker-${state}`],
            error: state === "partial" ? "preserved_partial_error" : undefined,
          },
        })
        const beforeCallbacks = ReviewRunStore.get(run.id)

        await startGitLabReviewRuntimeRun({
          runId: run.id,
          idempotencyKey: `callback:${state}`,
          trigger: run.trigger as any,
          context: {
            project: { nine1botProjectID: "test-project" },
            diff: { files: [], skipped: [], blocked: false, stats: { fileCount: 0, includedFileCount: 0, skippedFileCount: 0, includedBytes: 0, truncated: false } },
            contextBlocks: [],
          },
        } as any, directory, {
          platforms: {},
          runner: async (input: any) => {
            await input.onSessionCreated({ sessionID: `late-session-${state}` })
            await input.onControllerResponse({ accepted: false, turnSnapshotId: `late-turn-${state}` })
            await input.onFinished({ status: "failed", error: `late-failure-${state}` })
            return { accepted: true, sessionID: `late-session-${state}`, status: 202, response: {} } as any
          },
        })

        expect(ReviewRunStore.get(run.id)).toEqual(beforeCallbacks)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("normalizes runtime failures without exposing exception text", () => {
    expect(gitLabReviewRuntimeFailure("runtime_start", new Error("PRIVATE-TOKEN=secret at C:\\private\\config")))
      .toBe("gitlab_review_runtime_start_failed")
    expect(gitLabReviewRuntimeFailure("runtime_finished", "provider response with private prompt"))
      .toBe("gitlab_review_runtime_finished_failed")
  })

  test("uses configured local URL when provided", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096/",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("strips repeated trailing slashes from configured local URL", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096///",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("replaces loopback browser origin with a reachable LAN IPv4", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      interfaces: {
        Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
        Ethernet: [{ address: "192.168.53.6", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("keeps non-loopback origins unchanged", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://192.168.53.6:4096",
      interfaces: {
        Ethernet: [{ address: "10.0.0.12", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("omits heavy GitLab review context from list records", () => {
    expect(publicGitLabReviewRun({
      id: "run_1",
      rootRunId: "run_1",
      attempt: 1,
      triggerKey: "trigger_1",
      generation: "generation_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      context: {
        diff: {
          files: [{ diff: "large diff" }],
        },
      },
      project: {
        id: "uftest",
        host: "gitlab.example.com",
        projectId: 3,
        nine1botProjectID: "project-uf",
        pathWithNamespace: "root/uftest",
        displayName: "UFtest",
        enabled: true,
        reviewContextMarkdown: "Internal review notes.",
        reviewFocus: ["auth"],
        includePathPrefixes: [],
        excludePathPatterns: [],
        ci: { maxJobLogs: 3, maxJobLogBytes: 8000 },
        source: "configured",
        matchedAt: 3,
      },
      ci: {
        pipeline: {
          id: 41,
          sha: "abc123",
          status: "failed",
          ref: "feature/review",
          web_url: "https://gitlab.example.com/root/uftest/-/pipelines/41",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
          trace: "must never reach the browser",
        },
        diagnostics: ["failed_jobs_detected"],
        trace: "must never reach the browser",
      },
      repository: {
        queryCount: 4,
        readCount: 2,
        searchCount: 2,
        outputBytes: 1024,
      },
    } as any)).toEqual({
      id: "run_1",
      rootRunId: "run_1",
      attempt: 1,
      triggerKey: "trigger_1",
      generation: "generation_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      project: {
        id: "uftest",
        host: "gitlab.example.com",
        projectId: 3,
        nine1botProjectID: "project-uf",
        pathWithNamespace: "root/uftest",
        displayName: "UFtest",
        enabled: true,
        source: "configured",
        matchedAt: 3,
      },
      ci: {
        pipeline: {
          id: 41,
          sha: "abc123",
          status: "failed",
          ref: "feature/review",
          web_url: "https://gitlab.example.com/root/uftest/-/pipelines/41",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
        },
        diagnostics: ["failed_jobs_detected"],
      },
    })
  })

  test("maps GitLab review publish failures to specific HTTP statuses", () => {
    expect(gitLabReviewPublishStatus("review_run_not_found")).toBe(404)
    expect(gitLabReviewPublishStatus("review_run_already_published")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_publish_in_progress")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_publish_payload_mismatch")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_publish_claim_lost")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_already_active")).toBe(409)
    expect(gitLabReviewPublishStatus("gitlab_api_publish_failed:403:Forbidden")).toBe(502)
    expect(gitLabReviewPublishStatus("invalid_stage_result")).toBe(400)
    expect(gitLabReviewPublishStatus("gitlab_review_publication_input_too_large")).toBe(413)
  })

  test("keeps GitLab API error bodies out of publication persistence and management responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-publication-api-error-redaction-"))
    const configPath = join(directory, "config.json")
    const secretsPath = join(directory, "secrets.json")
    const runStorePath = join(directory, "review-runs.json")
    const previousConfigPath = process.env.NINE1BOT_CONFIG_PATH
    const previousSecretsPath = process.env.NINE1BOT_PLATFORM_SECRETS_PATH
    const previousFetch = globalThis.fetch
    ReviewRunStore.setPathForTesting(runStorePath)
    ReviewRunStore.clearForTesting()
    const privateBody = [
      "Authorization: Bearer management-bearer-secret",
      "PRIVATE-TOKEN: glpat-management-private-token",
      "https://management-user:management-password@gitlab.internal/path?access_token=management-query-secret",
      "-----BEGIN PRIVATE KEY-----",
      "management-pem-secret",
      "-----END PRIVATE KEY-----",
      "DATABASE_URL=postgres://service:management-database-secret@db.internal/app",
      "internal-management-detail",
    ].join("\n")
    const createRun = (objectIid: number, headSha: string) => {
      const trigger = {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr" as const,
        objectIid,
        headSha,
        mode: "webhook" as const,
      }
      const diff = {
        files: [{
          oldPath: "src/app.ts",
          newPath: "src/app.ts",
          diff: "@@ -1,2 +1,3 @@\n context\n+changed\n",
          added: false,
          renamed: false,
          deleted: false,
          generated: false,
        }],
        skipped: [],
        blocked: false,
        diffRefs: { baseSha: "base", startSha: "start", headSha },
        stats: {
          fileCount: 1,
          includedFileCount: 1,
          skippedFileCount: 0,
          includedBytes: 42,
          truncated: false,
        },
      }
      return ReviewRunStore.create({
        platform: "gitlab",
        status: "running",
        trigger,
        context: {
          trigger,
          idempotencyKey: `management-api-error-${objectIid}`,
          diff,
          contextBlocks: [],
        },
      })
    }
    const fallbackRun = createRun(10, "management-fallback-head")
    const failedRun = createRun(11, "management-failed-head")
    const malformedRun = createRun(12, "management-malformed-head")
    const fallbackStageResult = {
      stage: "closed",
      status: "ok" as const,
      summary: "Review complete.",
      findings: [{
        title: "Changed line",
        body: "Inline body",
        severity: "major" as const,
        file: "src/app.ts",
        newLine: 2,
      }],
    }
    const failedStageResult = {
      ...fallbackStageResult,
      summary: "This publication will fail.",
    }
    const malformedStageResult = {
      ...fallbackStageResult,
      summary: "This publication receives malformed metadata.",
    }
    const fallbackNoteBodies: string[] = []

    try {
      await writeFile(configPath, JSON.stringify({
        platforms: {
          gitlab: {
            enabled: true,
            settings: {
              "review.enabled": true,
              "review.dryRun": false,
              "review.inlineComments": true,
              "review.baseUrl": "https://gitlab.example.com",
              "review.tokenSecretRef": { provider: "nine1bot-local", key: "gitlab-token" },
            },
          },
        },
      }))
      await writeFile(secretsPath, JSON.stringify({
        version: 1,
        secrets: { "gitlab-token": "token" },
      }))
      process.env.NINE1BOT_CONFIG_PATH = configPath
      process.env.NINE1BOT_PLATFORM_SECRETS_PATH = secretsPath
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? "GET"
        if (method === "GET" && url.endsWith("/api/v4/projects/123/merge_requests/10")) {
          return Response.json({
            diff_refs: { base_sha: "base", start_sha: "start", head_sha: "management-fallback-head" },
          })
        }
        if (method === "GET" && url.endsWith("/api/v4/projects/123/merge_requests/11")) {
          return Response.json({
            diff_refs: { base_sha: "base", start_sha: "start", head_sha: "management-failed-head" },
          })
        }
        if (method === "GET" && url.endsWith("/api/v4/projects/123/merge_requests/12")) {
          return new Response('{"x":UNLABELLED_MANAGEMENT_SECRET_4b1d}', { status: 200 })
        }
        if (method === "POST" && url.endsWith("/merge_requests/10/discussions")) {
          return new Response(JSON.stringify({ error: "position is invalid", detail: privateBody }), {
            status: 400,
            statusText: "Bad Request",
          })
        }
        if (method === "POST" && url.endsWith("/merge_requests/10/notes")) {
          if (init?.body instanceof URLSearchParams) fallbackNoteBodies.push(init.body.get("body") ?? "")
          return Response.json({ id: fallbackNoteBodies.length })
        }
        if (method === "POST" && url.endsWith("/merge_requests/11/notes")) {
          return new Response(privateBody, { status: 503, statusText: "Service Unavailable" })
        }
        throw new Error(`unexpected GitLab request: ${method} ${url}`)
      }) as typeof fetch

      const publish = async (runId: string, stageResult: unknown) => {
        const body = JSON.stringify({ stageResult })
        return await WebhookRoutes().request(`http://localhost/gitlab/runs/${runId}/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(new TextEncoder().encode(body).byteLength),
          },
          body,
        })
      }
      const fallbackResponse = await publish(fallbackRun.id, fallbackStageResult)
      const failedResponse = await publish(failedRun.id, failedStageResult)
      const malformedResponse = await publish(malformedRun.id, malformedStageResult)
      const fallbackManagementResponse = await WebhookRoutes().request(
        `http://localhost/gitlab/runs/${fallbackRun.id}`,
      )
      const failedManagementResponse = await WebhookRoutes().request(
        `http://localhost/gitlab/runs/${failedRun.id}`,
      )
      const malformedManagementResponse = await WebhookRoutes().request(
        `http://localhost/gitlab/runs/${malformedRun.id}`,
      )
      const fallbackResult = await fallbackResponse.json()
      const failedResult = await failedResponse.json()
      const malformedResult = await malformedResponse.json()
      const fallbackManagement = await fallbackManagementResponse.json()
      const failedManagement = await failedManagementResponse.json()
      const malformedManagement = await malformedManagementResponse.json()
      const persisted = await readFile(runStorePath, "utf8")

      expect(fallbackResponse.status).toBe(200)
      expect(fallbackResult).toMatchObject({
        published: true,
        runId: fallbackRun.id,
        inlinePosted: 0,
        fallbackPosted: 1,
        warnings: ["Inline fallback for src/app.ts: GitLab API returned 400: position is invalid."],
      })
      expect(ReviewRunStore.get(fallbackRun.id)).toMatchObject({
        status: "succeeded",
        warnings: ["Inline fallback for src/app.ts: GitLab API returned 400: position is invalid."],
      })
      expect(failedResponse.status).toBe(502)
      expect(failedResult).toEqual({
        published: false,
        runId: failedRun.id,
        error: "gitlab_api_publish_result_failed:503:Service Unavailable",
      })
      expect(ReviewRunStore.get(failedRun.id)).toMatchObject({
        status: "failed",
        error: "gitlab_api_publish_result_failed:503:Service Unavailable",
      })
      expect(malformedResponse.status).toBe(502)
      expect(malformedResult).toEqual({
        published: false,
        runId: malformedRun.id,
        error: "gitlab_api_publish_result_failed:gitlab_api_response_invalid_json",
      })
      expect(ReviewRunStore.get(malformedRun.id)).toMatchObject({
        status: "failed",
        error: "gitlab_api_publish_result_failed:gitlab_api_response_invalid_json",
      })

      const parsedFallback = parseReviewStageResult(fallbackStageResult, { runId: fallbackRun.id })
      const expectedPlan = prepareGitLabReviewPublicationPlan({
        runId: fallbackRun.id,
        objectType: "mr",
        manifest: (fallbackRun.context as any).diff,
        summary: parsedFallback.summary,
        findings: parsedFallback.findings,
        inlineComments: true,
        warnings: parsedFallback.nextActions,
      })
      expect(fallbackNoteBodies).toEqual([
        expectedPlan.summary.body,
        expectedPlan.inline[0]?.fallback.body,
      ])
      expect(fallbackNoteBodies[1]).not.toContain("position is invalid")

      const exposed = JSON.stringify({
        fallbackResult,
        failedResult,
        fallbackManagement,
        failedManagement,
        malformedResult,
        malformedManagement,
        persisted,
      })
      for (const secret of [
        "management-bearer-secret",
        "glpat-management-private-token",
        "management-user",
        "management-password",
        "management-query-secret",
        "management-pem-secret",
        "management-database-secret",
        "internal-management-detail",
        "UNLABELLED_MANAGEMENT_SECRET_4b1d",
      ]) {
        expect(exposed).not.toContain(secret)
      }
    } finally {
      globalThis.fetch = previousFetch
      if (previousConfigPath === undefined) delete process.env.NINE1BOT_CONFIG_PATH
      else process.env.NINE1BOT_CONFIG_PATH = previousConfigPath
      if (previousSecretsPath === undefined) delete process.env.NINE1BOT_PLATFORM_SECRETS_PATH
      else process.env.NINE1BOT_PLATFORM_SECRETS_PATH = previousSecretsPath
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("rejects an oversized GitLab publication request before JSON validation", async () => {
    const response = await WebhookRoutes().request(
      "http://localhost/gitlab/runs/not-used/publish",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(gitLabReviewPublicationBudget.maxManagementRequestBytes + 1),
        },
        body: JSON.stringify({ stageResult: {} }),
      },
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      published: false,
      runId: "not-used",
      error: "gitlab_review_publication_input_too_large",
    })
  })

  test("returns domain 413 before claim or GitLab access when a valid request expands during aggregation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-publication-domain-budget-"))
    const configPath = join(directory, "config.json")
    const secretsPath = join(directory, "secrets.json")
    const previousConfigPath = process.env.NINE1BOT_CONFIG_PATH
    const previousSecretsPath = process.env.NINE1BOT_PLATFORM_SECRETS_PATH
    const previousFetch = globalThis.fetch
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const headSha = "management-domain-budget-head"
    const trigger = {
      host: "gitlab.example.com",
      projectId: 123,
      objectType: "mr" as const,
      objectIid: 10,
      headSha,
      mode: "webhook" as const,
    }
    const run = ReviewRunStore.create({
      platform: "gitlab",
      status: "running",
      trigger,
      context: {
        trigger,
        idempotencyKey: "management-domain-budget",
        diff: {
          files: [{
            oldPath: "src/app.ts",
            newPath: "src/app.ts",
            diff: "@@ -1,2 +1,3 @@\n context\n+changed\n",
            added: false,
            renamed: false,
            deleted: false,
            generated: false,
          }],
          skipped: [],
          blocked: false,
          diffRefs: { baseSha: "base", startSha: "start", headSha },
          stats: {
            fileCount: 1,
            includedFileCount: 1,
            skippedFileCount: 0,
            includedBytes: 42,
            truncated: false,
          },
        },
        contextBlocks: [],
      },
    })
    const findingCount = gitLabReviewPublicationBudget.maxFindings
    const totalBodyCodeUnits = gitLabReviewPublicationBudget.maxTotalCodeUnits
      - run.id.length
      - "s".length
      - findingCount
    const baseBodyCodeUnits = Math.floor(totalBodyCodeUnits / findingCount)
    const longerBodyCount = totalBodyCodeUnits % findingCount
    const stageResult = {
      stage: "closed",
      status: "ok",
      summary: "",
      findings: Array.from({ length: findingCount }, (_, index) => {
        const bodyCodeUnits = baseBodyCodeUnits + (index < longerBodyCount ? 1 : 0)
        const label = index.toString().padStart(3, "0")
        return {
          title: "t",
          body: `${label}${"x".repeat(bodyCodeUnits - label.length)}`,
          severity: "info",
        }
      }),
    }
    const body = JSON.stringify({ stageResult })
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxManagementRequestBytes,
    )
    await writeFile(configPath, JSON.stringify({
      platforms: {
        gitlab: {
          enabled: true,
          settings: {
            "review.enabled": true,
            "review.dryRun": false,
            "review.inlineComments": true,
            "review.baseUrl": "https://gitlab.example.com",
            "review.tokenSecretRef": { provider: "nine1bot-local", key: "gitlab-token" },
          },
        },
      },
    }))
    await writeFile(secretsPath, JSON.stringify({
      version: 1,
      secrets: { "gitlab-token": "token" },
    }))
    process.env.NINE1BOT_CONFIG_PATH = configPath
    process.env.NINE1BOT_PLATFORM_SECRETS_PATH = secretsPath
    const gitLabRequests: string[] = []
    globalThis.fetch = (async (url) => {
      gitLabRequests.push(String(url))
      return Response.json({ diff_refs: { head_sha: headSha } })
    }) as typeof fetch
    const claimPublication = spyOn(ReviewRunStore, "claimPublication")

    try {
      const response = await WebhookRoutes().request(
        `http://localhost/gitlab/runs/${run.id}/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(new TextEncoder().encode(body).byteLength),
          },
          body,
        },
      )

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual({
        published: false,
        runId: run.id,
        error: "gitlab_review_publication_input_too_large",
      })
      expect(claimPublication).toHaveBeenCalledTimes(0)
      expect(gitLabRequests).toEqual([])
      expect(ReviewRunStore.get(run.id)?.publication).toBeUndefined()
    } finally {
      claimPublication.mockRestore()
      globalThis.fetch = previousFetch
      if (previousConfigPath === undefined) delete process.env.NINE1BOT_CONFIG_PATH
      else process.env.NINE1BOT_CONFIG_PATH = previousConfigPath
      if (previousSecretsPath === undefined) delete process.env.NINE1BOT_PLATFORM_SECRETS_PATH
      else process.env.NINE1BOT_PLATFORM_SECRETS_PATH = previousSecretsPath
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("returns domain 413 before downstream work when form encoding expands a valid publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-publication-encoded-budget-"))
    const configPath = join(directory, "config.json")
    const secretsPath = join(directory, "secrets.json")
    const previousConfigPath = process.env.NINE1BOT_CONFIG_PATH
    const previousSecretsPath = process.env.NINE1BOT_PLATFORM_SECRETS_PATH
    const previousFetch = globalThis.fetch
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const headSha = "management-encoded-budget-head"
    const trigger = {
      host: "gitlab.example.com",
      projectId: 123,
      objectType: "mr" as const,
      objectIid: 10,
      headSha,
      mode: "webhook" as const,
    }
    const manifest: GitLabDiffManifest = {
      files: [{
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        diff: "@@ -1,2 +1,3 @@\n context\n+changed\n",
        added: false,
        renamed: false,
        deleted: false,
        generated: false,
      }],
      skipped: [],
      blocked: false,
      diffRefs: { baseSha: "base", startSha: "start", headSha },
      stats: {
        fileCount: 1,
        includedFileCount: 1,
        skippedFileCount: 0,
        includedBytes: 42,
        truncated: false,
      },
    }
    const run = ReviewRunStore.create({
      platform: "gitlab",
      status: "running",
      trigger,
      context: {
        trigger,
        idempotencyKey: "management-encoded-budget",
        diff: manifest,
        contextBlocks: [],
      },
    })
    const stageResult = {
      stage: "closed",
      status: "ok" as const,
      summary: "",
      findings: Array.from({ length: 60 }, (_, index) => ({
        title: "t",
        body: "b",
        severity: "info" as const,
        file: `${index.toString().padStart(3, "0")}/${"\u00e9".repeat(3_996)}`,
      })),
    }
    const parsed = parseReviewStageResult(stageResult, { runId: run.id })
    const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
    const rawStrings = [
      run.id,
      parsed.stage,
      parsed.summary,
      ...parsed.findings.flatMap((finding) => [finding.title, finding.body, finding.file ?? ""]),
    ]
    expect(rawStrings.reduce((total, value) => total + value.length, 0)).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxTotalCodeUnits,
    )
    expect(rawStrings.reduce((total, value) => total + utf8Bytes(value), 0)).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxTotalUtf8Bytes,
    )
    const aggregated = aggregateReviewFindings(parsed.findings)
    expect(Math.max(...aggregated.map((finding) => finding.body.length))).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxAggregateBodyCodeUnits,
    )
    expect(Math.max(...aggregated.map((finding) => utf8Bytes(finding.body)))).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxAggregateBodyUtf8Bytes,
    )
    const markers = [
      gitLabReviewPublicationMarker({ runId: run.id, kind: "summary" }),
      ...aggregated.map((finding) => gitLabReviewPublicationMarker({
        runId: run.id,
        kind: "fallback",
        findingKey: gitLabReviewFindingKey(finding),
      })),
    ]
    const canonicalBody = renderReviewSummaryComment({
      summary: parsed.summary,
      findings: aggregated,
      manifest,
      warnings: parsed.nextActions,
    })
    const renderedBody = `${canonicalBody}\n\n${markers.join("\n")}`
    expect(renderedBody.length).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxRenderedBodyCodeUnits,
    )
    expect(utf8Bytes(renderedBody)).toBeLessThanOrEqual(
      gitLabReviewPublicationBudget.maxRenderedBodyUtf8Bytes,
    )
    expect(utf8Bytes(new URLSearchParams({ body: renderedBody }).toString())).toBeGreaterThan(
      gitLabReviewPublicationBudget.maxOutboundFormBytes,
    )
    expect(() => prepareGitLabReviewPublicationPlan({
      runId: run.id,
      objectType: "mr",
      manifest,
      summary: parsed.summary,
      findings: parsed.findings,
      inlineComments: false,
      warnings: parsed.nextActions,
    })).toThrow("gitlab_review_publication_input_too_large")

    const body = JSON.stringify({ stageResult })
    expect(utf8Bytes(body)).toBeLessThanOrEqual(gitLabReviewPublicationBudget.maxManagementRequestBytes)
    await writeFile(configPath, JSON.stringify({
      platforms: {
        gitlab: {
          enabled: true,
          settings: {
            "review.enabled": true,
            "review.dryRun": false,
            "review.inlineComments": false,
            "review.baseUrl": "https://gitlab.example.com",
            "review.tokenSecretRef": { provider: "nine1bot-local", key: "gitlab-token" },
          },
        },
      },
    }))
    await writeFile(secretsPath, JSON.stringify({
      version: 1,
      secrets: { "gitlab-token": "token" },
    }))
    process.env.NINE1BOT_CONFIG_PATH = configPath
    process.env.NINE1BOT_PLATFORM_SECRETS_PATH = secretsPath
    const gitLabRequests: string[] = []
    globalThis.fetch = (async (url) => {
      gitLabRequests.push(String(url))
      return Response.json({ diff_refs: { head_sha: headSha } })
    }) as typeof fetch
    const claimPublication = spyOn(ReviewRunStore, "claimPublication")

    try {
      const response = await WebhookRoutes().request(
        `http://localhost/gitlab/runs/${run.id}/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(utf8Bytes(body)),
          },
          body,
        },
      )

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual({
        published: false,
        runId: run.id,
        error: "gitlab_review_publication_input_too_large",
      })
      expect(claimPublication).toHaveBeenCalledTimes(0)
      expect(gitLabRequests).toEqual([])
      expect(ReviewRunStore.get(run.id)?.publication).toBeUndefined()
    } finally {
      claimPublication.mockRestore()
      globalThis.fetch = previousFetch
      if (previousConfigPath === undefined) delete process.env.NINE1BOT_CONFIG_PATH
      else process.env.NINE1BOT_CONFIG_PATH = previousConfigPath
      if (previousSecretsPath === undefined) delete process.env.NINE1BOT_PLATFORM_SECRETS_PATH
      else process.env.NINE1BOT_PLATFORM_SECRETS_PATH = previousSecretsPath
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("records a nonblocking diagnostic when runtime finishes without querying CI", () => {
    const patch = gitLabReviewCiNotQueriedPatch({
      id: "run_1",
      rootRunId: "run_1",
      attempt: 1,
      triggerKey: "trigger_1",
      generation: "generation_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      publishedAt: 3,
      warnings: ["existing warning"],
      trigger: { objectType: "mr" },
      ci: {
        pipeline: {
          id: 41,
          sha: "head",
          status: "success",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
        },
        diagnostics: ["existing_diagnostic"],
      },
    })

    expect(patch).toEqual({
      ci: {
        pipeline: {
          id: 41,
          sha: "head",
          status: "success",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
        },
        diagnostics: ["existing_diagnostic", "ci_not_queried"],
      },
    })
    expect(gitLabReviewCiNotQueriedPatch({
      id: "run_2",
      rootRunId: "run_2",
      attempt: 1,
      triggerKey: "trigger_2",
      generation: "generation_2",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      trigger: { objectType: "mr" },
      ci: { diagnostics: [], queryCount: 1 },
    })).toBeUndefined()
    expect(gitLabReviewCiNotQueriedPatch({
      id: "run_legacy_log",
      rootRunId: "run_legacy_log",
      attempt: 1,
      triggerKey: "trigger_legacy_log",
      generation: "generation_legacy_log",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      trigger: { objectType: "mr" },
      ci: { diagnostics: [], jobLogReadCount: 1 },
    })).toBeUndefined()
  })

  test("maps a lost publication claim directly to HTTP 409", () => {
    expect(gitLabReviewPublishStatus("review_run_publish_claim_lost")).toBe(409)
    expect(gitLabReviewPublishStatus("gitlab_review_publication_legacy_ambiguous")).toBe(409)
  })

  test("enables only bounded ReviewRun tools in the automated review message", () => {
    expect(gitLabReviewRuntimeTools("mr")).toEqual({
      "*": false,
      task: true,
      gitlab_ci_inspect: true,
      gitlab_repository_inspect: true,
    })
    expect(gitLabReviewRuntimeTools("commit")).toEqual({
      "*": false,
      task: true,
      gitlab_ci_inspect: false,
      gitlab_repository_inspect: true,
    })
  })

  test("binds a fresh review session before runtime message delivery", () => {
    expect(gitLabReviewSessionCreatedPatch("session_new", undefined)).toEqual({
      status: "running",
      sessionId: "session_new",
      turnSnapshotId: undefined,
      error: undefined,
      repository: {
        queryCount: 0,
        readCount: 0,
        searchCount: 0,
        outputBytes: 0,
        apiRequestCount: 0,
        fileFetchCount: 0,
        fetchedBytes: 0,
      },
    })
  })

  test("keeps a rejected review terminal across runtime callback races without posting a failure note", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-rejection-"))
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const rejected = ReviewRunStore.create({
      platform: "gitlab",
      status: "rejected",
      error: "gitlab_review_head_changed",
      rejectionKind: "policy",
      recoverable: false,
      trigger: {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr",
        objectIid: 10,
        headSha: "stale-head",
        mode: "webhook",
      },
    })

    expect(gitLabReviewSessionCreatedPatch("session_late", rejected)).toBeUndefined()
    expect(gitLabReviewControllerResponsePatch(rejected, {
      accepted: false,
      turnSnapshotId: "turn_late",
    })).toBeUndefined()
    expect(gitLabReviewRuntimePatch(rejected, {
      status: "failed",
      error: "gitlab_review_head_changed",
    })).toBeUndefined()

    const calls: Array<{ url: string; init?: RequestInit }> = []
    await expect(reportGitLabReviewRunFailure({
      runId: rejected.id,
      platforms: { gitlab: { enabled: true, settings: {
        "review.enabled": true,
        "review.dryRun": false,
        "review.baseUrl": "https://gitlab.example.com",
        "review.tokenSecretRef": { provider: "nine1bot-local", key: "gitlab-token" },
      } } },
      secrets: {
        async get() { return "token" },
        async set() {},
        async delete() {},
        async has() { return true },
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return Response.json({ id: 1 })
      }) as typeof fetch,
      phase: "runtime_finished",
      error: "gitlab_review_runtime_finished_failed",
    })).resolves.toMatchObject({ notified: false, error: "review_run_policy_rejected" })
    expect(calls.filter((call) => call.init?.method === "POST")).toEqual([])
    expect(ReviewRunStore.get(rejected.id)).toMatchObject({
      status: "rejected",
      error: "gitlab_review_head_changed",
      recoverable: false,
    })
    await rm(directory, { recursive: true, force: true })
  })

  test("does not post when the actual runtime finished callback arrives after policy rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-callback-"))
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let finishedCallbackCalls = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return Response.json({ id: 1 })
    }) as typeof fetch
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const run = ReviewRunStore.create({
      platform: "gitlab",
      status: "running",
      error: "before_rejection",
      trigger: {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr",
        objectIid: 10,
        headSha: "trigger-head",
        mode: "webhook",
      },
    })

    try {
      await startGitLabReviewRuntimeRun({
        runId: run.id,
        idempotencyKey: "gitlab:gitlab.example.com:123:mr:10:head_sha:trigger-head:auto:merge_request",
        trigger: run.trigger as any,
        context: {
          project: { nine1botProjectID: "test-project" },
          diff: { files: [], skipped: [], blocked: false, stats: { fileCount: 0, includedFileCount: 0, skippedFileCount: 0, includedBytes: 0, truncated: false } },
          contextBlocks: [],
        },
      } as any, directory, {
        platforms: {},
        runner: async (input: any) => {
          const onFinished = input.onFinished
          expect(onFinished).toBeDefined()
          ReviewRunStore.update(run.id, {
            status: "rejected",
            error: "gitlab_review_head_changed",
            rejectionKind: "policy",
            recoverable: false,
          })
          finishedCallbackCalls++
          await onFinished({ status: "failed", error: "late runtime failure" })
          return { accepted: true, sessionID: "session_late", status: 202, response: {} } as any
        },
      })

      expect(ReviewRunStore.get(run.id)).toMatchObject({
        status: "rejected",
        error: "gitlab_review_head_changed",
        recoverable: false,
      })
      expect(calls.filter((call) => call.init?.method === "POST")).toEqual([])
      expect(finishedCallbackCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("omits GitLab review context from the public webhook response", () => {
    expect(publicGitLabReviewWebhookResult({
      accepted: true,
      status: "accepted",
      idempotencyKey: "gitlab:mr:3:4:head",
      runId: "run_1",
      rootRunId: "run_0",
      attempt: 2,
      retryOf: "run_0",
      trigger: { host: "gitlab.example.com", projectId: 3, objectType: "mr", objectIid: 4, eventName: "note", mode: "mention" },
      warnings: [],
      context: {
        contextBlocks: [{ content: "FAILED secret trace" }],
        diff: { files: [{ diff: "private diff" }] },
      },
    } as any)).toEqual({
      accepted: true,
      status: "accepted",
      idempotencyKey: "gitlab:mr:3:4:head",
      runId: "run_1",
      rootRunId: "run_0",
      attempt: 2,
      retryOf: "run_0",
      trigger: { host: "gitlab.example.com", projectId: 3, objectType: "mr", objectIid: 4, eventName: "note", mode: "mention" },
      warnings: [],
    })
  })

  test("resolves GitLab review runtime directory from the bound Nine1Bot project", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-valid-binding-"))
    const requested: string[] = []
    try {
      const directory = await resolveGitLabReviewRuntimeDirectory(
        { nine1botProjectID: "project-uf" },
        async (projectID) => {
          requested.push(projectID)
          return { worktree: join(rootDirectory, "unused-worktree"), rootDirectory }
        },
      )

      expect(requested).toEqual(["project-uf"])
      expect(directory).toBe(rootDirectory)
    } finally {
      await rm(rootDirectory, { recursive: true, force: true })
    }
  })

  test("fails GitLab review runtime startup when its project binding is missing or stale", async () => {
    await expect(resolveGitLabReviewRuntimeDirectory(undefined, async () => {
      throw new Error("must not resolve")
    })).rejects.toThrow("project_binding_missing")

    await expect(resolveGitLabReviewRuntimeDirectory(
      { nine1botProjectID: "deleted-project" },
      async () => {
        throw new Error("not found")
      },
    )).rejects.toThrow("project_binding_missing")
  })

  test("keeps a stale runtime project binding recoverable without creating a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-stale-binding-"))
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const run = ReviewRunStore.create({
      platform: "gitlab",
      status: "running",
      trigger: {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr",
        objectIid: 10,
        headSha: "stale-binding-head",
        mode: "webhook",
      },
    })
    let sessionsCreated = 0

    try {
      const rejected = await startGitLabReviewRuntime({
        runId: run.id,
        idempotencyKey: "gitlab:gitlab.example.com:123:mr:10:head_sha:stale-binding-head:auto:merge_request",
        trigger: run.trigger as any,
        context: {
          project: { nine1botProjectID: "deleted-project" },
          diff: { files: [], skipped: [], blocked: false, stats: { fileCount: 0, includedFileCount: 0, skippedFileCount: 0, includedBytes: 0, truncated: false } },
          contextBlocks: [],
        },
      } as any, "runtime_start", {
        getProject: async () => {
          throw new Error("not found")
        },
        start: async () => {
          sessionsCreated++
        },
      })

      expect(sessionsCreated).toBe(0)
      expect(rejected).toMatchObject({ accepted: false, error: "project_binding_missing", httpStatus: 202 })
      expect(ReviewRunStore.get(run.id)).toMatchObject({
        status: "rejected",
        rejectionKind: "configuration",
        recoverable: true,
        attempt: 1,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects missing, file, and inaccessible runtime directories before the start callback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-directory-preflight-"))
    const filePath = join(directory, "project-file")
    const inaccessiblePath = join(directory, "inaccessible-project")
    await writeFile(filePath, "not a directory")
    await mkdir(inaccessiblePath)
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()

    try {
      for (const scenario of [
        { name: "missing", projectPath: join(directory, "missing-project") },
        { name: "file", projectPath: filePath },
        {
          name: "inaccessible",
          projectPath: inaccessiblePath,
          inspectDirectory: async () => {
            const error = new Error("access denied") as NodeJS.ErrnoException
            error.code = "EACCES"
            throw error
          },
        },
      ]) {
        const run = ReviewRunStore.create({
          platform: "gitlab",
          status: "running",
          trigger: {
            host: "gitlab.example.com",
            projectId: 123,
            objectType: "mr",
            objectIid: 10,
            headSha: `${scenario.name}-binding-head`,
            mode: "webhook",
          },
        })
        let starts = 0
        const result = await startGitLabReviewRuntime({
          runId: run.id,
          idempotencyKey: `gitlab:directory:${scenario.name}`,
          trigger: run.trigger as any,
          context: {
            project: { nine1botProjectID: `project-${scenario.name}` },
            diff: {
              files: [],
              skipped: [],
              blocked: false,
              stats: {
                fileCount: 0,
                includedFileCount: 0,
                skippedFileCount: 0,
                includedBytes: 0,
                truncated: false,
              },
            },
            contextBlocks: [],
          },
        } as any, "runtime_start", {
          getProject: async () => ({ rootDirectory: scenario.projectPath, worktree: scenario.projectPath }),
          inspectDirectory: scenario.inspectDirectory,
          start: async () => {
            starts++
          },
        })

        expect(starts).toBe(0)
        expect(result).toMatchObject({
          accepted: false,
          status: "rejected",
          error: "project_binding_missing",
          httpStatus: 202,
          runId: run.id,
        })
        expect(ReviewRunStore.get(run.id)).toMatchObject({
          status: "rejected",
          error: "project_binding_missing",
          rejectionKind: "configuration",
          recoverable: true,
        })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
