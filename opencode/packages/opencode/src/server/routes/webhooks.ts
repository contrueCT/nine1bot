import { Bus } from "@/bus"
import { PermissionNext } from "@/permission/next"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { Webhook } from "@/webhook/webhook"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import {
  answerInteraction,
  createControllerSession,
  sendControllerMessage,
} from "./nine1bot-agent"

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

function startRunMonitor(runID: string, sessionID: string, permissionMode: Webhook.PermissionPolicy["mode"]) {
  let finished = false
  let unsubscribe: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  const finish = async (status: "succeeded" | "failed", error?: string) => {
    if (finished) return
    finished = true
    if (timeout) clearTimeout(timeout)
    unsubscribe?.()
    await Webhook.updateRun(runID, {
      status,
      ...(error ? { error } : {}),
      time: { finished: Date.now() },
    }).catch(() => undefined)
  }

  unsubscribe = Bus.subscribeAll(async (event) => {
    const properties = event.properties as Record<string, any> | undefined
    const eventSessionID = properties?.sessionID || properties?.info?.id
    if (eventSessionID !== sessionID) return

    if (event.type === "permission.asked") {
      const allowFull = permissionMode === "full"
      await answerInteraction(String(properties?.id || ""), {
        kind: "permission",
        answer: allowFull ? "allow-session" : "deny",
        message: allowFull
          ? "Webhook run uses the full permission policy, so permission requests are allowed for this session."
          : "Webhook runs use the default non-interactive permission policy, so permission requests are denied.",
      }).catch(() => undefined)
      if (!allowFull) {
        await Webhook.updateRun(runID, {
          error: `Permission request denied automatically: ${String(properties?.permission || "unknown")}`,
        }).catch(() => undefined)
      }
      return
    }

    if (event.type === "question.asked") {
      await answerInteraction(String(properties?.id || ""), {
        kind: "question",
        answer: "deny",
      }).catch(() => undefined)
      await Webhook.updateRun(runID, {
        error: "Question request denied automatically in webhook run.",
      }).catch(() => undefined)
      return
    }

    if (event.type === "session.idle") {
      await finish("succeeded")
      return
    }

    if (event.type === "session.error") {
      await finish("failed", JSON.stringify(properties?.error || "Session failed"))
    }
  })

  timeout = setTimeout(() => {
    finish("failed", "Webhook run monitor timed out.").catch(() => undefined)
  }, RUN_MONITOR_TIMEOUT_MS)
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
      const created = await Instance.provide({
        directory,
        init: InstanceBootstrap,
        async fn() {
          const sessionResponse = await createControllerSession({
            directory,
            title: `Webhook: ${source.name}`,
            permission: permissionForSource(source),
            sessionChoice: sessionChoiceForSource(source),
            entry,
            clientCapabilities: WEBHOOK_CLIENT_CAPABILITIES,
          })
          const messageResponse = await sendControllerMessage(sessionResponse.sessionId, {
            parts: [{ type: "text", text: renderedPrompt }],
            entry,
            clientCapabilities: WEBHOOK_CLIENT_CAPABILITIES,
          })
          return {
            sessionResponse,
            messageResponse,
          }
        },
      })

      const responseBody = {
        accepted: created.messageResponse.response.accepted,
        runId: run.id,
        sessionId: created.sessionResponse.sessionId,
        turnSnapshotId: created.messageResponse.response.turnSnapshotId,
        ...(created.messageResponse.response.accepted ? {} : { error: "controller_message_not_accepted" }),
      } satisfies Webhook.TriggerResponse

      await Webhook.updateRun(run.id, {
        sessionID: created.sessionResponse.sessionId,
        turnSnapshotId: created.messageResponse.response.turnSnapshotId,
        status: created.messageResponse.response.accepted ? "running" : "failed",
        httpStatus: created.messageResponse.status,
        responseBody,
        time: { started: Date.now() },
        ...(created.messageResponse.response.accepted ? {} : { error: "controller_message_not_accepted" }),
      })

      if (created.messageResponse.response.accepted) {
        await Webhook.markCooldown(source, run.id)
        await Instance.provide({
          directory,
          init: InstanceBootstrap,
          fn() {
            startRunMonitor(run.id, created.sessionResponse.sessionId, source.permissionPolicy.mode)
          },
        })
      }

      return c.json(responseBody, created.messageResponse.status as never)
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
