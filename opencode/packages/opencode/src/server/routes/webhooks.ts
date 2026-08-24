import { PermissionNext } from "@/permission/next"
import { Project } from "@/project/project"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { Webhook } from "@/webhook/webhook"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, resolver, validator } from "hono-openapi"
import { constants } from "fs"
import { access, stat } from "fs/promises"
import { networkInterfaces, type NetworkInterfaceInfo } from "os"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import {
  runAutomatedControllerSession,
  type AutomatedControllerResponse,
  type AutomatedControllerRunner,
  type AutomatedRunStatus,
} from "./automated-controller"
import {
  extractGitLabReviewStageResultFromRuntimeText,
  handleGitLabReviewWebhook,
  gitLabReviewRuntimeSkillIds,
  publishGitLabReviewRunResult,
  rejectGitLabReviewRuntimeConfiguration,
  reportGitLabReviewRunFailure,
  resolveGitLabReviewModelSelection,
  retryGitLabReviewAttempt,
  validateGitLabDedicatedWebhookSecret as validateGitLabDedicatedWebhookPathSecret,
  type GitLabReviewWebhookResult,
} from "../../../../../../packages/nine1bot/src/review/gitlab-controller"
import { buildGitLabReviewRuntimePrompt } from "../../../../../../packages/nine1bot/src/review/gitlab-controller"
import { ReviewRunStore, type ReviewRunRecord } from "../../../../../../packages/nine1bot/src/review/run-store"
import { readPlatformManagerConfig } from "../../../../../../packages/nine1bot/src/platform/config-store"
import { FilePlatformSecretStore } from "../../../../../../packages/nine1bot/src/platform/secrets"
import { registerBuiltinPlatformAdapters } from "../../../../../../packages/nine1bot/src/platform/builtin"
import {
  GITLAB_REVIEW_PUBLICATION_INPUT_TOO_LARGE,
  gitLabReviewPublicationBudget,
} from "../../../../../../packages/platform-gitlab/src/review"

const WEBHOOK_CLIENT_CAPABILITIES = {
  interactions: false,
  permissionRequests: false,
  questionRequests: false,
  artifacts: false,
  filePreview: false,
  resourceFailures: true,
  continueInWeb: true,
} satisfies RuntimeControllerProtocol.ClientCapabilities

const WEBHOOK_ENTRY_BASE = {
  source: "webhook",
  platform: "generic-webhook",
  mode: "event-trigger",
  templateIds: ["default-user-template", "webhook-entry"],
} satisfies RuntimeControllerProtocol.Entry

const GITLAB_REVIEW_CLIENT_CAPABILITIES = {
  interactions: false,
  permissionRequests: false,
  questionRequests: false,
  artifacts: false,
  filePreview: false,
  resourceFailures: true,
  continueInWeb: true,
  contextAudit: true,
} satisfies RuntimeControllerProtocol.ClientCapabilities

const GitLabReviewPublishBody = z.object({
  stageResult: z.unknown(),
}).strict()

const gitLabReviewPublishBodyLimit = bodyLimit({
  maxSize: gitLabReviewPublicationBudget.maxManagementRequestBytes,
  onError(c) {
    return c.json({
      published: false,
      runId: c.req.param("runId"),
      error: GITLAB_REVIEW_PUBLICATION_INPUT_TOO_LARGE,
    }, 413)
  },
})

export async function gitLabReviewWebhookBodyLimit(c: any, next: () => Promise<void>) {
  const maxBytes = gitLabReviewPublicationBudget.maxManagementRequestBytes
  const declaredBytes = Number.parseInt(c.req.raw.headers.get("content-length") ?? "", 10)
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await cancelGitLabWebhookBody(c.req.raw)
    return gitLabWebhookPayloadTooLarge(c)
  }

  let body: ArrayBuffer | undefined
  try {
    body = await readBoundedGitLabWebhookBody(c.req.raw, maxBytes)
  } catch {
    return c.json({ accepted: false, error: "invalid_json_body" }, 400)
  }
  if (!body) return gitLabWebhookPayloadTooLarge(c)
  if (c.req.raw.body) c.req.raw = new Request(c.req.raw, { body })
  await next()
}

async function cancelGitLabWebhookBody(request: Request) {
  if (!request.body || request.body.locked) return
  await request.body.cancel().catch(() => undefined)
}

async function readBoundedGitLabWebhookBody(request: Request, maxBytes: number) {
  if (!request.body) return new ArrayBuffer(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const buffer = new ArrayBuffer(size)
  const body = new Uint8Array(buffer)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buffer
}

function gitLabWebhookPayloadTooLarge(c: any) {
  return c.json({
    accepted: false,
    error: "gitlab_webhook_payload_too_large",
  }, 413)
}

const RUN_MONITOR_TIMEOUT_MS = 30 * 60 * 1000
const PROMPT_PREVIEW_LIMIT = 4000
const FULL_PERMISSION_RULES: PermissionNext.Ruleset = [
  {
    permission: "*",
    pattern: "*",
    action: "allow",
  },
]

function projectDirectory(project: Pick<Project.Info, "rootDirectory" | "worktree">) {
  return project.rootDirectory || project.worktree
}

export async function resolveGitLabReviewRuntimeDirectory(
  project: { nine1botProjectID?: string } | undefined,
  getProject: (projectID: string) => Promise<Pick<Project.Info, "rootDirectory" | "worktree">> = Project.get,
  inspectDirectory: (directory: string) => Promise<void> = inspectGitLabReviewRuntimeDirectory,
) {
  const projectID = project?.nine1botProjectID?.trim()
  if (!projectID) throw new Error("project_binding_missing")
  const boundProject = await getProject(projectID).catch(() => undefined)
  const directory = boundProject ? projectDirectory(boundProject) : undefined
  if (!directory) throw new Error("project_binding_missing")
  await inspectDirectory(directory).catch(() => {
    throw new Error("project_binding_missing")
  })
  return directory
}

async function inspectGitLabReviewRuntimeDirectory(directory: string) {
  const info = await stat(directory)
  if (!info.isDirectory()) throw new Error("project_binding_missing")
  await access(directory, constants.R_OK | constants.X_OK)
}

function currentOrigin(c: { req: { url: string } }) {
  return new URL(c.req.url).origin
}

export function webhookLocalOrigin(input: {
  requestOrigin: string
  envLocalUrl?: string
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
}) {
  if (input.envLocalUrl?.trim()) return input.envLocalUrl.trim().replace(/\/+$/, "")
  const request = new URL(input.requestOrigin)
  if (!isLoopbackHost(request.hostname)) return request.origin
  const address = firstReachableIPv4(input.interfaces ?? networkInterfaces())
  if (!address) return request.origin
  request.hostname = address
  return request.origin
}

function firstReachableIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && info.address) return info.address
    }
  }
  return undefined
}

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "::1" || host.startsWith("127.")
}

function webhookTemplateUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/webhooks/{sourceId}/{secret}`
}

function promptPreview(prompt: string) {
  return prompt.length > PROMPT_PREVIEW_LIMIT ? `${prompt.slice(0, PROMPT_PREVIEW_LIMIT)}...` : prompt
}

function sessionChoiceForSource(source: Webhook.Source): RuntimeControllerProtocol.SessionChoice {
  const choice: NonNullable<RuntimeControllerProtocol.SessionChoice> = {}
  if (source.runtimeProfile.modelMode === "custom" && source.runtimeProfile.model) {
    choice.model = source.runtimeProfile.model
  }
  const mcpServers = source.runtimeProfile.resourcesMode === "default-plus-selected"
    ? source.runtimeProfile.mcpServers.filter((server) => server.trim().length > 0)
    : []
  if (mcpServers.length > 0) {
    choice.resources = {
      mcp: {
        servers: mcpServers,
      },
    }
  }
  return Object.keys(choice).length > 0 ? choice : undefined
}

function permissionForSource(source: Webhook.Source) {
  return source.permissionPolicy.mode === "full" ? FULL_PERMISSION_RULES : undefined
}

function responseForRun(runID: string, response: AutomatedControllerResponse): Webhook.TriggerResponse {
  return {
    accepted: response.accepted,
    runId: runID,
    sessionId: response.sessionID,
    turnSnapshotId: response.turnSnapshotId,
    ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
  }
}

async function createRejectedRun(c: any, input: {
  sourceID: string
  projectID: string
  httpStatus: number
  requestSummary: unknown
  error: string
  guardType?: Webhook.GuardType
  guardReason?: string
  dedupeKey?: string
}) {
  const responseBody = {
    accepted: false,
    error: input.error,
    ...(input.guardType ? { guardType: input.guardType } : {}),
    ...(input.guardReason ? { guardReason: input.guardReason } : {}),
  } satisfies Webhook.TriggerResponse
  const run = await Webhook.createRun({
    sourceID: input.sourceID,
    projectID: input.projectID,
    status: "rejected",
    httpStatus: input.httpStatus,
    requestSummary: input.requestSummary,
    error: input.error,
    guardType: input.guardType,
    guardReason: input.guardReason,
    dedupeKey: input.dedupeKey,
    responseBody,
  })
  return c.json(
    {
      ...responseBody,
      runId: run.id,
    } satisfies Webhook.TriggerResponse,
    input.httpStatus,
  )
}

async function handleWebhookTrigger(c: any, input: {
  sourceID: string
  authentication:
    | { type: "public-secret"; secret: string }
    | { type: "management-test" }
  runner?: AutomatedControllerRunner
}) {
  const { sourceID } = input
  let source: Webhook.Source
  try {
    source = await Webhook.getSource(sourceID)
  } catch {
    return c.json(
      {
        accepted: false,
        error: "webhook_source_not_found",
      } satisfies Webhook.TriggerResponse,
      404,
    )
  }

  const headers = Webhook.normalizeHeaders(c.req.raw.headers)
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const requestBase = {
    method: c.req.method,
    sourceID,
    headers,
    query,
    body: undefined,
  }

  if (source.deletedAt || !source.enabled) {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 403,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "webhook_source_disabled",
    })
  }

  if (input.authentication.type === "public-secret" && !Webhook.verifySecret(source, input.authentication.secret)) {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 401,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "invalid_webhook_secret",
    })
  }

  const contentType = c.req.header("content-type") || ""
  if (!contentType.toLowerCase().includes("application/json")) {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 400,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "json_body_required",
    })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 400,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "invalid_json_body",
    })
  }

  let project: Project.Info
  try {
    project = await Project.get(source.projectID)
  } catch {
    const run = await Webhook.createRun({
      sourceID,
      projectID: source.projectID,
      status: "failed",
      httpStatus: 500,
      requestSummary: Webhook.requestSummary({
        ...requestBase,
        body,
      }),
      error: "webhook_project_not_found",
    })
    return c.json(
      {
        accepted: false,
        runId: run.id,
        error: "webhook_project_not_found",
      } satisfies Webhook.TriggerResponse,
      500,
    )
  }
  const contextWithoutFields = {
    source: {
      id: source.id,
      name: source.name,
    },
    project,
    fields: {},
    body,
    headers,
    query,
  }
  const fields = Webhook.mapFields(source.requestMapping, contextWithoutFields)
  const renderContext = {
    ...contextWithoutFields,
    fields,
  }
  const renderedPrompt = Webhook.renderTemplate(source.promptTemplate, renderContext)
  const requestSummary = Webhook.requestSummary({
    ...requestBase,
    body,
  })

  return Webhook.withSourceLock(source.id, async () => {
    const guard = await Webhook.evaluateRequestGuards(source, renderContext)
    if (!guard.allowed) {
      return createRejectedRun(c, {
        sourceID,
        projectID: source.projectID,
        httpStatus: guard.httpStatus,
        requestSummary,
        error: guard.error,
        guardType: guard.guardType,
        guardReason: guard.guardReason,
        dedupeKey: guard.dedupeKey,
      })
    }

    const run = await Webhook.createRun({
      sourceID,
      projectID: source.projectID,
      status: "accepted",
      httpStatus: 202,
      requestSummary,
      renderedPromptPreview: promptPreview(renderedPrompt),
      dedupeKey: guard.dedupeKey,
    })

    const entry = {
      ...WEBHOOK_ENTRY_BASE,
      traceId: run.id,
    } satisfies RuntimeControllerProtocol.Entry

    try {
      const directory = projectDirectory(project)
      const startedAt = Date.now()
      let terminal:
        | {
            status: AutomatedRunStatus
            error?: string
            finishedAt: number
        }
        | undefined
      let runUpdateTail = Promise.resolve()
      const queueRunUpdate = <T>(operation: () => Promise<T>) => {
        const current = runUpdateTail.then(operation, operation)
        runUpdateTail = current.then(() => undefined, () => undefined)
        return current
      }
      const created = await (input.runner ?? runAutomatedControllerSession)({
        directory,
        title: `Webhook: ${source.name}`,
        permission: permissionForSource(source),
        sessionChoice: sessionChoiceForSource(source),
        entry,
        clientCapabilities: WEBHOOK_CLIENT_CAPABILITIES,
        parts: [{ type: "text", text: renderedPrompt }],
        timeoutMs: RUN_MONITOR_TIMEOUT_MS,
        timeoutMessage: "Webhook run monitor timed out.",
        interactionPolicy: {
          permission: source.permissionPolicy.mode === "full" ? "allow-session" : "deny",
          question: "deny",
          permissionAllowMessage: "Webhook run uses the full permission policy, so permission requests are allowed for this session.",
          permissionDenyMessage: "Webhook runs use the default non-interactive permission policy, so permission requests are denied.",
          questionDenyMessage: "Question request denied automatically in webhook run.",
        },
        async onControllerResponse(response) {
          const responseBody = responseForRun(run.id, response)
          await queueRunUpdate(async () => {
            const finished = terminal
            await Webhook.updateRun(run.id, {
              sessionID: response.sessionID,
              turnSnapshotId: response.turnSnapshotId,
              status: finished?.status ?? (response.accepted ? "running" : "failed"),
              httpStatus: response.status,
              responseBody,
              time: {
                started: startedAt,
                ...(finished ? { finished: finished.finishedAt } : {}),
              },
              ...(finished?.error
                ? { error: finished.error }
                : response.accepted || finished
                  ? {}
                  : { error: "controller_message_not_accepted" }),
            })
          })
          if (response.accepted) {
            await Webhook.markCooldown(source, run.id)
          }
        },
        async onFinished(result) {
          const finished = {
            ...result,
            finishedAt: Math.max(Date.now(), startedAt),
          }
          terminal = finished
          await queueRunUpdate(() => Webhook.updateRun(run.id, {
            status: finished.status,
            ...(finished.error ? { error: finished.error } : {}),
            time: { finished: finished.finishedAt },
          })).catch(() => undefined)
        },
        async onInteraction(interaction) {
          if (!interaction.error) return
          await queueRunUpdate(() => Webhook.updateRun(run.id, {
            error: interaction.error,
          })).catch(() => undefined)
        },
      })

      return c.json(responseForRun(run.id, created), created.status as never)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const responseBody = {
        accepted: false,
        runId: run.id,
        error: message,
      } satisfies Webhook.TriggerResponse
      await Webhook.updateRun(run.id, {
        status: "failed",
        httpStatus: 500,
        error: message,
        responseBody,
        time: { finished: Date.now() },
      })
      return c.json(responseBody, 500)
    }
  })
}

async function triggerWebhook(c: any, options: { runner?: AutomatedControllerRunner } = {}) {
  const { sourceID, secret } = c.req.param()
  return handleWebhookTrigger(c, {
    sourceID,
    authentication: { type: "public-secret", secret },
    runner: options.runner,
  })
}

async function testWebhook(c: any) {
  const { sourceID } = c.req.param()
  return handleWebhookTrigger(c, {
    sourceID,
    authentication: { type: "management-test" },
  })
}

export function publicGitLabReviewRun(run: ReviewRunRecord) {
  const { context: _context, project, ci, repository: _repository, ...publicRun } = run
  return {
    ...publicRun,
    ...(project ? {
      project: {
        id: project.id,
        host: project.host,
        projectId: project.projectId,
        nine1botProjectID: project.nine1botProjectID,
        pathWithNamespace: project.pathWithNamespace,
        displayName: project.displayName,
        enabled: project.enabled,
        source: project.source,
        matchedAt: project.matchedAt,
      },
    } : {}),
    ...(ci ? {
      ci: {
        ...(ci.pipeline ? {
          pipeline: {
            id: ci.pipeline.id,
            sha: ci.pipeline.sha,
            status: ci.pipeline.status,
            ref: ci.pipeline.ref,
            web_url: ci.pipeline.webUrl ?? (ci.pipeline as { web_url?: string }).web_url,
            kind: ci.pipeline.kind,
            verification: ci.pipeline.verification,
          },
        } : {}),
        diagnostics: ci.diagnostics,
      },
    } : {}),
  }
}

export function publicGitLabReviewWebhookResult(
  result: GitLabReviewWebhookResult,
) {
  if (!result.accepted) return result
  const { context: _context, ...publicResult } = result
  return publicResult
}

async function triggerGitLabReviewWebhook(c: any) {
  const contentType = c.req.header("content-type") || ""
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json({ accepted: false, error: "json_body_required" }, 400)
  }

  const platforms = await readPlatformManagerConfig()
  const secretValidation = await validateGitLabDedicatedWebhookSecret(c, platforms)
  if ("response" in secretValidation) return secretValidation.response

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ accepted: false, error: "invalid_json_body" }, 400)
  }

  const result = await handleGitLabReviewWebhook({
    payload,
    headers: Webhook.normalizeHeaders(c.req.raw.headers),
    platforms,
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
    ...(secretValidation.verified ? { verifiedWebhookSecret: true } : {}),
  })

  if (isAcceptedGitLabReviewWithContext(result) && result.status === "accepted") {
    const runtimeResult = await startGitLabReviewRuntime(result, "runtime_start")
    return c.json(publicGitLabReviewWebhookResult(runtimeResult), runtimeResult.accepted ? 202 : runtimeResult.httpStatus as never)
  }

  return c.json(publicGitLabReviewWebhookResult(result), result.accepted ? 202 : result.httpStatus as never)
}

async function validateGitLabDedicatedWebhookSecret(c: any, platforms: Awaited<ReturnType<typeof readPlatformManagerConfig>>) {
  const secret = c.req.param?.("secret")
  if (!secret) return {}

  const validation = await validateGitLabDedicatedWebhookPathSecret({
    secret,
    platforms,
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
  })
  if (!validation.ok) return { response: c.json({ accepted: false, error: validation.error }, 401) }
  return { verified: true }
}

type AcceptedGitLabReviewWithContext = Extract<GitLabReviewWebhookResult, { accepted: true }> & {
  context: NonNullable<Extract<GitLabReviewWebhookResult, { accepted: true }>["context"]>
}

type GitLabReviewRuntimeRunInput = {
  runId: string
  idempotencyKey: string
  trigger: AcceptedGitLabReviewWithContext["trigger"]
  context: AcceptedGitLabReviewWithContext["context"]
}

export type GitLabReviewRuntimeRunOptions = {
  runner?: AutomatedControllerRunner
  platforms?: Awaited<ReturnType<typeof readPlatformManagerConfig>>
  secrets?: FilePlatformSecretStore
}

export type GitLabReviewRuntimePreflightOptions = {
  getProject?: Parameters<typeof resolveGitLabReviewRuntimeDirectory>[1]
  inspectDirectory?: Parameters<typeof resolveGitLabReviewRuntimeDirectory>[2]
  start?: (result: GitLabReviewRuntimeRunInput, directory: string) => Promise<unknown>
}

export async function startGitLabReviewRuntime(
  result: AcceptedGitLabReviewWithContext,
  phase: "runtime_start" | "runtime_retry",
  options: GitLabReviewRuntimePreflightOptions = {},
) {
  let directory: string
  try {
    directory = await resolveGitLabReviewRuntimeDirectory(
      result.context.project,
      options.getProject,
      options.inspectDirectory,
    )
  } catch {
    return rejectGitLabReviewRuntimeConfiguration(result.runId, "project_binding_missing")
  }

  const start = options.start ?? startGitLabReviewRuntimeRun
  start(result, directory).catch((error) => {
    const message = gitLabReviewRuntimeFailure(phase, error)
    failGitLabReviewRuntimeRun(result.runId, phase, message).catch(() => undefined)
  })
  return result
}

function isAcceptedGitLabReviewWithContext(
  result: GitLabReviewWebhookResult,
): result is AcceptedGitLabReviewWithContext {
  return result.accepted && Boolean(result.context)
}

export async function startGitLabReviewRuntimeRun(
  result: GitLabReviewRuntimeRunInput,
  directory: string,
  options: GitLabReviewRuntimeRunOptions = {},
) {
  const platforms = options.platforms ?? await readPlatformManagerConfig()
  const secrets = options.secrets ?? new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH)
  registerBuiltinPlatformAdapters({
    config: platforms,
    secrets,
  })
  let publishAttempted = false
  const entry = {
    source: "webhook",
    platform: "gitlab",
    mode: "gitlab-code-review",
    templateIds: ["browser-gitlab", result.trigger.objectType === "mr" ? "gitlab-mr" : "gitlab-commit"],
    traceId: result.runId,
  } satisfies RuntimeControllerProtocol.Entry

  await (options.runner ?? runAutomatedControllerSession)({
    directory,
    title: `GitLab review: ${result.trigger.projectPath ?? result.trigger.projectId}`,
    sessionChoice: {
      agent: "platform.gitlab.pm-coordinator",
      ...gitLabReviewModelChoice(resolveGitLabReviewModelSelection(platforms)),
      resources: {
        skills: {
          skills: [...gitLabReviewRuntimeSkillIds],
        },
      },
    },
    entry,
    clientCapabilities: GITLAB_REVIEW_CLIENT_CAPABILITIES,
    parts: [{ type: "text", text: buildGitLabReviewRuntimePrompt(result) }],
    context: {
      blocks: result.context.contextBlocks,
    },
    tools: gitLabReviewRuntimeTools(result.trigger.objectType),
    timeoutMs: RUN_MONITOR_TIMEOUT_MS,
    timeoutMessage: "GitLab review run monitor timed out.",
    interactionPolicy: {
      permission: "deny",
      question: "deny",
      permissionAllowMessage: "GitLab review run allowed session permission request.",
      permissionDenyMessage: "GitLab review runs are non-interactive, so permission requests are denied.",
      questionDenyMessage: "Question request denied automatically in GitLab review run.",
    },
    async onSessionCreated({ sessionID }) {
      const run = ReviewRunStore.get(result.runId)
      if (!run) throw new Error("review_run_not_found")
      const patch = gitLabReviewSessionCreatedPatch(
        sessionID,
        run,
      )
      if (patch) ReviewRunStore.update(result.runId, patch)
    },
    async onControllerResponse(response) {
      const patch = gitLabReviewControllerResponsePatch(ReviewRunStore.get(result.runId), response)
      if (!patch) return
      if (!response.accepted) {
        await failGitLabReviewRuntimeRun(result.runId, "controller_message", "controller_message_not_accepted", patch)
        return
      }
      updateGitLabReviewRuntimeRun(result.runId, patch)
    },
    async onRuntimeOutput(output) {
      if (publishAttempted || output.kind !== "part" || !output.text) return
      const stageResult = extractGitLabReviewStageResultFromRuntimeText(output.text)
      if (!stageResult) return
      publishAttempted = true
      try {
        const published = await publishGitLabReviewRunResult({
          runId: result.runId,
          stageResult,
          platforms: await readPlatformManagerConfig(),
          secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
        })
        if (published.published) return
        await failGitLabReviewRuntimeRun(result.runId, "publish_result", published.error, {
          warnings: published.warnings,
        })
      } catch (error) {
        const diagnostic = gitLabReviewRuntimeFailure("runtime_publish", error)
        await failGitLabReviewRuntimeRun(result.runId, "publish_result", diagnostic)
      }
    },
    async onFinished(finished) {
      const beforeCiDiagnostic = ReviewRunStore.get(result.runId)
      const ciDiagnosticPatch = beforeCiDiagnostic && gitLabReviewCiNotQueriedPatch(beforeCiDiagnostic)
      if (ciDiagnosticPatch) updateGitLabReviewRuntimeRun(result.runId, ciDiagnosticPatch)
      if (publishAttempted) return
      const current = ReviewRunStore.get(result.runId)
      if (current?.publishedAt) return
      if (finished.status === "succeeded") {
        const error = "gitlab_review_result_missing"
        await failGitLabReviewRuntimeRun(result.runId, "runtime_output", error, {
          warnings: [
            ...((current?.warnings as string[] | undefined) ?? []),
            "Runtime session finished without a valid GITLAB_REVIEW_RESULT payload.",
          ],
        })
        return
      }
      const error = gitLabReviewRuntimeFailure("runtime_finished", finished.error)
      await failGitLabReviewRuntimeRun(result.runId, "runtime_finished", error)
    },
  })
}

export function gitLabReviewRuntimePatch(
  run: ReviewRunRecord | undefined,
  patch: Parameters<typeof ReviewRunStore.update>[1],
) {
  if (!run || run.status === "rejected" || run.publication) return undefined
  return patch
}

function updateGitLabReviewRuntimeRun(runId: string, patch: Parameters<typeof ReviewRunStore.update>[1]) {
  const guardedPatch = gitLabReviewRuntimePatch(ReviewRunStore.get(runId), patch)
  if (!guardedPatch) return false
  return Boolean(ReviewRunStore.update(runId, guardedPatch))
}

async function failGitLabReviewRuntimeRun(
  runId: string,
  phase: string,
  error: string,
  patch: Parameters<typeof ReviewRunStore.update>[1] = {},
) {
  const updated = updateGitLabReviewRuntimeRun(runId, {
    ...patch,
    status: "failed",
    error,
  })
  if (!updated) return false
  await reportStoredGitLabReviewFailure(runId, phase, error)
  return true
}

export function gitLabReviewSessionCreatedPatch(
  sessionID: string,
  run?: ReviewRunRecord,
) {
  const patch = {
    status: "running" as const,
    sessionId: sessionID,
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
  } satisfies Parameters<typeof ReviewRunStore.update>[1]
  return run ? gitLabReviewRuntimePatch(run, patch) : patch
}

export function gitLabReviewControllerResponsePatch(
  run: ReviewRunRecord | undefined,
  response: Pick<AutomatedControllerResponse, "accepted" | "turnSnapshotId">,
) {
  if (!run || run.publishedAt || (run.status !== "accepted" && run.status !== "running")) return undefined
  return gitLabReviewRuntimePatch(run, {
    status: response.accepted ? "running" as const : "failed" as const,
    turnSnapshotId: response.turnSnapshotId,
    ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
  } satisfies Parameters<typeof ReviewRunStore.update>[1])
}

export function gitLabReviewRuntimeTools(objectType: "mr" | "commit") {
  return {
    "*": false,
    task: true,
    gitlab_ci_inspect: objectType === "mr",
    gitlab_repository_inspect: true,
  }
}

export function gitLabReviewCiNotQueriedPatch(run: ReviewRunRecord) {
  if (
    run.trigger?.objectType !== "mr"
    || (run.ci?.queryCount ?? 0) > 0
    || (run.ci?.jobLogReadCount ?? 0) > 0
  ) return undefined
  return {
    ci: {
      ...run.ci,
      diagnostics: uniqueStrings([
        ...(run.ci?.diagnostics ?? []),
        "ci_not_queried",
      ]),
    },
  } satisfies Parameters<typeof ReviewRunStore.update>[1]
}

async function reportStoredGitLabReviewFailure(runId: string, phase: string, error: string) {
  await reportGitLabReviewRunFailure({
    runId,
    platforms: await readPlatformManagerConfig(),
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
    phase,
    error,
  })
}

function gitLabReviewModelChoice(model: ReturnType<typeof resolveGitLabReviewModelSelection>) {
  if (!model) return {}
  return {
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
    },
  } satisfies NonNullable<RuntimeControllerProtocol.SessionChoice>
}

export function gitLabReviewRuntimeFailure(
  phase: "runtime_start" | "runtime_retry" | "runtime_publish" | "runtime_finished",
  _error: unknown,
) {
  return `gitlab_review_${phase}_failed`
}

export function gitLabReviewPublishStatus(error: string | undefined) {
  if (!error) return 400
  if (error === "review_run_not_found") return 404
  if (error === GITLAB_REVIEW_PUBLICATION_INPUT_TOO_LARGE) return 413
  if (
    error === "review_run_already_published"
    || error === "review_run_already_active"
    || error === "review_run_publish_in_progress"
    || error === "review_run_publish_payload_mismatch"
    || error === "review_run_publish_claim_lost"
    || error === "gitlab_review_publication_legacy_ambiguous"
  ) return 409
  if (error.startsWith("gitlab_api_")) return 502
  return 400
}

async function retryGitLabReviewRun(c: any) {
  const runId = c.req.valid("param").runId
  const result = await retryGitLabReviewAttempt({
    runId,
    platforms: await readPlatformManagerConfig(),
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
  })

  if (isAcceptedGitLabReviewWithContext(result) && result.status === "accepted") {
    const runtimeResult = await startGitLabReviewRuntime(result, "runtime_retry")
    return c.json(publicGitLabReviewWebhookResult(runtimeResult), runtimeResult.accepted ? 202 : runtimeResult.httpStatus as never)
  }

  return c.json(publicGitLabReviewWebhookResult(result), result.accepted ? 202 : result.httpStatus as never)
}

function uniqueStrings(items: string[]) {
  return [...new Set(items)]
}

export function createWebhookPublicRoutes(options: { runner?: AutomatedControllerRunner } = {}) {
  return new Hono()
    .post("/gitlab", gitLabReviewWebhookBodyLimit, triggerGitLabReviewWebhook)
    .post(
      "/gitlab/:secret",
      gitLabReviewWebhookBodyLimit,
      validator("param", z.object({ secret: z.string() })),
      triggerGitLabReviewWebhook,
    )
    .post(
      "/:sourceID/:secret",
      validator("param", z.object({ sourceID: z.string(), secret: z.string() })),
      (c) => triggerWebhook(c, options),
    )
}

export const WebhookPublicRoutes = lazy(() => createWebhookPublicRoutes())

export const WebhookRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get webhook service status",
        operationId: "webhooks.status",
      }),
      async (c) => {
        const localUrl = webhookLocalOrigin({
          requestOrigin: currentOrigin(c),
          envLocalUrl: process.env.NINE1BOT_LOCAL_URL,
        })
        const publicUrl = process.env.NINE1BOT_PUBLIC_URL || ""
        return c.json({
          listening: true,
          localUrl,
          publicUrl,
          localWebhookUrl: webhookTemplateUrl(localUrl),
          publicWebhookUrl: publicUrl ? webhookTemplateUrl(publicUrl) : "",
          tunnel: {
            enabled: Boolean(publicUrl),
            status: publicUrl ? "active" : "disabled",
          },
        })
      },
    )
    .get(
      "/sources",
      describeRoute({
        summary: "List webhook sources",
        operationId: "webhooks.sources.list",
        responses: {
          200: {
            description: "Webhook sources",
            content: {
              "application/json": {
                schema: resolver(Webhook.PublicSource.array()),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Webhook.listSources()),
    )
    .post(
      "/sources",
      describeRoute({
        summary: "Create webhook source",
        operationId: "webhooks.sources.create",
        responses: {
          200: {
            description: "Created webhook source",
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Webhook.SourceCreate),
      async (c) => c.json(await Webhook.createSource(c.req.valid("json"))),
    )
    .patch(
      "/sources/:sourceID",
      validator("param", z.object({ sourceID: z.string() })),
      validator("json", Webhook.SourceUpdate),
      async (c) => c.json(await Webhook.updateSource(c.req.valid("param").sourceID, c.req.valid("json"))),
    )
    .post(
      "/sources/:sourceID/secret/refresh",
      validator("param", z.object({ sourceID: z.string() })),
      async (c) => c.json(await Webhook.refreshSourceSecret(c.req.valid("param").sourceID)),
    )
    .post(
      "/sources/:sourceID/test",
      validator("param", z.object({ sourceID: z.string() })),
      testWebhook,
    )
    .delete(
      "/sources/:sourceID",
      validator("param", z.object({ sourceID: z.string() })),
      async (c) => c.json(await Webhook.deleteSource(c.req.valid("param").sourceID)),
    )
    .get(
      "/runs",
      validator(
        "query",
        z.object({
          sourceID: z.string().optional(),
          limit: z.coerce.number().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      ),
      async (c) => c.json(await Webhook.listRuns(c.req.valid("query"))),
    )
    .get(
      "/gitlab/runs",
      validator(
        "query",
        z.object({
          limit: z.coerce.number().min(1).max(500).optional(),
        }),
      ),
      async (c) => {
        return c.json({
          runs: ReviewRunStore.list({ limit: c.req.valid("query").limit }).map(publicGitLabReviewRun),
        })
      },
    )
    .get(
      "/gitlab/runs/:runId",
      validator("param", z.object({ runId: z.string() })),
      async (c) => {
        const run = ReviewRunStore.get(c.req.valid("param").runId)
        if (!run) return c.json({ error: "review_run_not_found" }, 404)
        return c.json(publicGitLabReviewRun(run))
      },
    )
    .post(
      "/gitlab/runs/:runId/publish",
      validator("param", z.object({ runId: z.string() })),
      gitLabReviewPublishBodyLimit,
      validator("json", GitLabReviewPublishBody),
      async (c) => {
        const result = await publishGitLabReviewRunResult({
          runId: c.req.valid("param").runId,
          stageResult: c.req.valid("json").stageResult,
          platforms: await readPlatformManagerConfig(),
          secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
        })
        return c.json(result, result.published ? 200 : gitLabReviewPublishStatus(result.error))
      },
    )
    .post(
      "/gitlab/runs/:runId/retry",
      validator("param", z.object({ runId: z.string() })),
      retryGitLabReviewRun,
    ),
)
