import { PermissionNext } from "@/permission/next"
import { Project } from "@/project/project"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { Webhook } from "@/webhook/webhook"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { runAutomatedControllerSession, type AutomatedControllerResponse } from "./automated-controller"

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

const RUN_MONITOR_TIMEOUT_MS = 30 * 60 * 1000
const PROMPT_PREVIEW_LIMIT = 4000
const FULL_PERMISSION_RULES: PermissionNext.Ruleset = [
  {
    permission: "*",
    pattern: "*",
    action: "allow",
  },
]

function projectDirectory(project: Project.Info) {
  return project.rootDirectory || project.worktree
}

function currentOrigin(c: { req: { url: string } }) {
  return new URL(c.req.url).origin
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

async function triggerWebhook(c: any) {
  const { sourceID, secret } = c.req.param()
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

  if (!Webhook.verifySecret(source, secret)) {
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
      const created = await runAutomatedControllerSession({
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
          await Webhook.updateRun(run.id, {
            sessionID: response.sessionID,
            turnSnapshotId: response.turnSnapshotId,
            status: response.accepted ? "running" : "failed",
            httpStatus: response.status,
            responseBody,
            time: { started: Date.now() },
            ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
          })
          if (response.accepted) {
            await Webhook.markCooldown(source, run.id)
          }
        },
        async onFinished(result) {
          await Webhook.updateRun(run.id, {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            time: { finished: Date.now() },
          }).catch(() => undefined)
        },
        async onInteraction(interaction) {
          if (!interaction.error) return
          await Webhook.updateRun(run.id, {
            error: interaction.error,
          }).catch(() => undefined)
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

export const WebhookPublicRoutes = lazy(() =>
  new Hono().post(
    "/:sourceID/:secret",
    validator("param", z.object({ sourceID: z.string(), secret: z.string() })),
    triggerWebhook,
  ),
)

export const WebhookRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get webhook service status",
        operationId: "webhooks.status",
      }),
      async (c) => {
        const localUrl = process.env.NINE1BOT_LOCAL_URL || currentOrigin(c)
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
        }),
      ),
      async (c) => c.json(await Webhook.listRuns(c.req.valid("query"))),
    ),
)
