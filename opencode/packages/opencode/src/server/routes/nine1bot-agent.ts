import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import { HTTPException } from "hono/http-exception"
import z from "zod"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { ControllerAgentRunCompiler } from "@/runtime/controller/agent-run-compiler"
import { RuntimeControllerEvents } from "@/runtime/controller/events"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { RuntimeContextEvents } from "@/runtime/context/events"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { RuntimeMetricsEvents } from "@/runtime/metrics/events"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import { ControllerTemplateResolver } from "@/runtime/controller/template-resolver"
import { SessionProfileCompiler } from "@/runtime/session/profile-compiler"
import { SessionRuntimeProfile } from "@/runtime/session/profile"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { NamedError } from "@opencode-ai/util/error"
import { Provider } from "@/provider/provider"
import { Storage } from "@/storage/storage"
import { ulid } from "ulid"

const log = Log.create({ service: "server.nine1bot-agent" })

type ControllerPromptBody = Omit<
  SessionPrompt.PromptInput,
  "sessionID" | "runtimeModelSource" | "runtimeProfileSnapshot" | "runtimeTurnSnapshotId"
>

async function capabilities(): Promise<RuntimeControllerProtocol.CapabilitiesResponse> {
  return {
    version: RuntimeControllerProtocol.VERSION,
    protocolVersions: [RuntimeControllerProtocol.VERSION],
    server: {
      controllerApi: true,
      sessionProfileSnapshots: await RuntimeFeatureFlags.profileSnapshotEnabled(),
      contextPipeline: await RuntimeFeatureFlags.contextPipelineEnabled(),
      resourceResolver: await RuntimeFeatureFlags.resourceResolverEnabled(),
      sessionEvents: true,
      interactionEvents: true,
      artifactEvents: true,
      debugApi: true,
      legacyEventProjection: true,
    },
    eventTypes: [...RuntimeControllerProtocol.RuntimeEventTypes],
    fallbackActions: ["continue-in-web", "open-settings", "start-auth", "retry"],
  }
}

type ControllerMetricsInput = {
  route: string
  method: string
  entry?: RuntimeControllerProtocol.Entry
  protocolVersion?: string
}

async function emitControllerMetrics(
  input: ControllerMetricsInput & {
    startedAt: number
    status: number
    accepted?: boolean
    busy?: boolean
    errorType?: string
  },
) {
  await Bus.publish(RuntimeMetricsEvents.ControllerApiCompleted, {
    route: input.route,
    method: input.method,
    status: input.status,
    durationMs: Date.now() - input.startedAt,
    completedAt: Date.now(),
    entrySource: input.entry?.source,
    platform: input.entry?.platform,
    mode: input.entry?.mode,
    traceId: input.entry?.traceId,
    protocolVersion: input.protocolVersion,
    accepted: input.accepted,
    busy: input.busy,
    errorType: input.errorType,
  }).catch((error) => {
    log.warn("failed to publish controller metrics event", { error, route: input.route })
  })
}

async function withControllerMetrics<T>(input: {
  route: string
  method: string
  entry?: RuntimeControllerProtocol.Entry
  protocolVersion?: string
  run: () => Promise<{ status: number; accepted?: boolean; busy?: boolean; body: T }>
}) {
  const startedAt = Date.now()
  try {
    const result = await input.run()
    await emitControllerMetrics({
      route: input.route,
      method: input.method,
      entry: input.entry,
      protocolVersion: input.protocolVersion,
      startedAt,
      status: result.status,
      accepted: result.accepted,
      busy: result.busy,
    })
    return result
  } catch (error) {
    const failure = controllerMetricFailure(error)
    await emitControllerMetrics({
      route: input.route,
      method: input.method,
      entry: input.entry,
      protocolVersion: input.protocolVersion,
      startedAt,
      status: failure.status,
      accepted: failure.accepted,
      busy: failure.busy,
      errorType: failure.errorType,
    })
    throw error
  }
}

function controllerMetricFailure(error: unknown) {
  let status = 500
  let accepted: boolean | undefined
  let busy: boolean | undefined

  if (error instanceof Session.BusyError) {
    status = 409
    accepted = false
    busy = true
  } else if (error instanceof HTTPException) {
    status = error.status
  } else if (error instanceof NamedError) {
    if (error instanceof Storage.NotFoundError) status = 404
    else if (error instanceof Provider.ModelNotFoundError) status = 400
    else if (error.name.startsWith("Worktree")) status = 400
  }

  return {
    status,
    accepted,
    busy,
    errorType: RuntimeMetricsEvents.normalizeErrorType(error),
  }
}

async function resolveTemplate(input?: RuntimeControllerProtocol.TemplateResolveRequest) {
  const resolved = await ControllerTemplateResolver.resolve({
    entry: input?.entry,
    sessionChoice: input?.sessionChoice,
    clientCapabilities: input?.clientCapabilities,
    page: parsePage(input?.page),
  })

  return {
    version: RuntimeControllerProtocol.VERSION,
    templateIds: resolved.templateIds,
    template: {
      id: resolved.templateIds.at(-1) ?? "default-user-template",
      source: "user-config",
      protocolVersion: RuntimeControllerProtocol.VERSION,
    },
    defaultAgent: resolved.defaultAgent,
    recommendedAgent: resolved.recommendedAgent,
    defaultModel: resolved.defaultModel,
    sessionChoice: input?.sessionChoice,
    contextPreview: resolved.contextPreview,
    resourcesPreview: resolved.resourcesPreview,
    orchestration: resolved.orchestration,
    audit: resolved.audit,
    defaultUserTemplate: {
      agent: resolved.defaultAgent,
      defaultModel: resolved.defaultModel,
      resources: resolved.profileTemplate.resources,
    },
    capabilities: await capabilities(),
  }
}

function parsePermission(input: unknown) {
  const parsed = PermissionNext.Ruleset.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

function parsePage(input: unknown) {
  const parsed = RuntimeContextEvents.RequestPagePayload.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

export async function createControllerSession(input?: RuntimeControllerProtocol.SessionCreateRequest) {
  const model = input?.sessionChoice?.model
  const permission = parsePermission(input?.permission)
  const template = await ControllerTemplateResolver.resolve({
    entry: input?.entry,
    sessionChoice: input?.sessionChoice,
    clientCapabilities: input?.clientCapabilities,
    page: parsePage(input?.page),
  })
  const compiledProfile = await SessionProfileCompiler.compile({
    directory: input?.directory ?? Instance.directory,
    permission,
    source: "new-session",
    agentName: input?.sessionChoice?.agent,
    profileTemplate: template.profileTemplate,
  })
  const session = await Session.createNext({
    title: input?.title,
    directory: input?.directory ?? Instance.directory,
    permission,
    runtimeProfile: compiledProfile,
    runtimeCurrentModel: model ? SessionRuntimeProfile.currentModel(model, "session-choice") : undefined,
  })
  const profile = input?.debug?.profileSnapshot ? await SessionRuntimeProfile.read(session) : undefined
  return {
    version: RuntimeControllerProtocol.VERSION,
    sessionId: session.id,
    session,
    profileSnapshotId: session.runtime?.profileSnapshotId,
    agent: session.runtime?.agent,
    currentModel: session.runtime?.currentModel,
    templateIds: template.templateIds,
    contextPreview: template.contextPreview,
    resourcesPreview: template.resourcesPreview,
    audit: template.audit,
    profileSnapshot: profile,
  }
}

async function compileControllerPrompt(input: {
  sessionID: string
  body: RuntimeControllerProtocol.MessageSendRequest
  turnSnapshotId: string
}) {
  const body = input.body
  const promptBody: ControllerPromptBody = {
    messageID: body.messageID,
    model: body.model,
    noReply: body.noReply,
    tools: body.tools,
    context: body.context as SessionPrompt.PromptInput["context"],
    system: body.system,
    variant: body.variant,
    parts: body.parts as SessionPrompt.PromptInput["parts"],
  }

  SessionPrompt.assertNotBusy(input.sessionID)

  if (!(await RuntimeFeatureFlags.agentRunSpecEnabled())) {
    return {
      ...promptBody,
      sessionID: input.sessionID,
      runtimeTurnSnapshotId: input.turnSnapshotId,
    } satisfies SessionPrompt.PromptInput
  }

  const session = await Session.get(input.sessionID)
  return ControllerAgentRunCompiler.compilePrompt({
    session,
    body,
    turnSnapshotId: input.turnSnapshotId,
  })
}

export async function sendControllerMessage(sessionID: string, body: RuntimeControllerProtocol.MessageSendRequest) {
  const turnSnapshotId = ulid()
  let prompt: SessionPrompt.PromptInput
  try {
    prompt = await compileControllerPrompt({ sessionID, body, turnSnapshotId })
  } catch (error) {
    if (error instanceof Session.BusyError) {
      return {
        response: {
          version: RuntimeControllerProtocol.VERSION,
          accepted: false,
          sessionId: sessionID,
          turnSnapshotId,
          busy: true,
          fallbackAction:
            body.clientCapabilities?.continueInWeb === false
              ? undefined
              : {
                  type: "continue-in-web" as const,
                  label: "Continue in web",
                },
        },
        status: 409,
      }
    }
    throw error
  }

  RuntimeControllerEvents.bindTurn(sessionID, turnSnapshotId)
  await Bus.publish(RuntimeControllerEvents.TurnStarted, {
    sessionID,
    turnSnapshotId,
    profileSnapshotId: prompt.runtimeProfileSnapshot?.id,
    agent: prompt.agent,
    model: prompt.model
      ? {
          providerID: prompt.model.providerID,
          modelID: prompt.model.modelID,
          source: prompt.runtimeModelSource,
        }
      : undefined,
  })

  try {
    await SessionPrompt.promptAsync(prompt)
  } catch (error) {
    RuntimeControllerEvents.clearTurn(sessionID, turnSnapshotId)
    if (error instanceof Session.BusyError) {
      return {
        response: {
          version: RuntimeControllerProtocol.VERSION,
          accepted: false,
          sessionId: sessionID,
          turnSnapshotId,
          busy: true,
          fallbackAction:
            body.clientCapabilities?.continueInWeb === false
              ? undefined
              : {
                  type: "continue-in-web" as const,
                  label: "Continue in web",
                },
        },
        status: 409,
      }
    }
    throw error
  }

  return {
    response: {
      version: RuntimeControllerProtocol.VERSION,
      accepted: true,
      sessionId: sessionID,
      turnSnapshotId,
    },
    status: 202,
  }
}

async function changeModel(sessionID: string, input: RuntimeControllerProtocol.ModelChangeRequest) {
  const session = await Session.get(sessionID)
  let profile = await SessionRuntimeProfile.read(session)
  if (!profile && (await RuntimeFeatureFlags.profileSnapshotEnabled())) {
    profile = await SessionProfileCompiler.compile({
      session,
      directory: session.directory,
      permission: session.permission,
      source: "legacy-resumed",
    })
    const runtime = await SessionRuntimeProfile.initialize(session, profile, {
      currentModel: SessionRuntimeProfile.currentModel(input.model, "session-choice"),
    })
    const updated = await Session.update(
      sessionID,
      (draft) => {
        draft.runtime = runtime
      },
      { touch: false },
    )
    return {
      version: RuntimeControllerProtocol.VERSION,
      sessionId: sessionID,
      currentModel: updated.runtime?.currentModel,
      profileSnapshotId: updated.runtime?.profileSnapshotId,
    }
  }

  if (!session.runtime) {
    return {
      version: RuntimeControllerProtocol.VERSION,
      sessionId: sessionID,
      currentModel: SessionRuntimeProfile.currentModel(input.model, "session-choice"),
    }
  }

  const currentModel = SessionRuntimeProfile.currentModel(input.model, "session-choice")
  const updated = await Session.update(
    sessionID,
    (draft) => {
      draft.runtime = SessionRuntimeProfile.withCurrentModel(session.runtime!, currentModel)
    },
    { touch: false },
  )

  return {
    version: RuntimeControllerProtocol.VERSION,
    sessionId: sessionID,
    currentModel: updated.runtime?.currentModel,
    profileSnapshotId: updated.runtime?.profileSnapshotId,
  }
}

export async function answerInteraction(requestID: string, body: RuntimeControllerProtocol.InteractionAnswerRequest) {
  const inferredKind = body.kind ?? (typeof body.answer === "object" ? "question" : "permission")
  if (inferredKind === "question") {
    if (typeof body.answer === "object") {
      await Question.reply({
        requestID,
        answers: body.answer.answers,
      })
    } else {
      await Question.reject(requestID)
    }
    return true
  }

  const reply =
    body.answer === "allow-once" ? "once" : body.answer === "allow-session" ? "always" : "reject"
  await PermissionNext.reply({
    requestID,
    reply,
    message: body.message,
  })
  return true
}

async function debugSession(sessionID: string) {
  const session = await Session.get(sessionID)
  const [profileSnapshot, contextEvents, messages] = await Promise.all([
    SessionRuntimeProfile.read(session),
    RuntimeContextEvents.list({ sessionID, projectID: session.projectID }),
    Session.messages({ sessionID, limit: 20 }),
  ])
  const resourceResolution = profileSnapshot
    ? await RuntimeResourceResolver.resolve({
        sessionID,
        profile: profileSnapshot,
        emitFailures: false,
        emitResolved: false,
      })
    : undefined
  return {
    version: RuntimeControllerProtocol.VERSION,
    sessionId: sessionID,
    status: SessionStatus.get(sessionID),
    session: {
      id: session.id,
      runtime: session.runtime,
      directory: session.directory,
      title: session.title,
    },
    profileSnapshot,
    resourceAudit: resourceResolution?.audit,
    contextEvents,
    recentMessages: messages.map((message) => ({
      id: message.info.id,
      role: message.info.role,
      parts: message.parts.length,
    })),
  }
}

function writeEnvelope(
  stream: { writeSSE(input: { id?: string; event?: string; data: string }): Promise<void> },
  envelope: RuntimeControllerEvents.RuntimeEventEnvelope,
) {
  return stream.writeSSE({
    id: envelope.id,
    event: envelope.type,
    data: JSON.stringify(envelope),
  })
}

export const Nine1BotAgentRoutes = lazy(() =>
  new Hono()
    .get(
      "/runtime/capabilities",
      describeRoute({
        summary: "Get Nine1Bot runtime capabilities",
        operationId: "nine1bot.runtime.capabilities",
        responses: {
          200: {
            description: "Controller protocol capabilities",
            content: {
              "application/json": {
                schema: resolver(RuntimeControllerProtocol.CapabilitiesResponse),
              },
            },
          },
        },
      }),
      async (c) => {
        const result = await withControllerMetrics({
          route: "/nine1bot/runtime/capabilities",
          method: c.req.method,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => ({
            status: 200,
            body: await capabilities(),
          }),
        })
        return c.json(result.body, result.status as never)
      },
    )
    .get("/agent/capabilities", async (c) => {
      const result = await withControllerMetrics({
        route: "/nine1bot/agent/capabilities",
        method: c.req.method,
        protocolVersion: RuntimeControllerProtocol.VERSION,
        run: async () => ({
          status: 200,
          body: await capabilities(),
        }),
      })
      return c.json(result.body, result.status as never)
    })
    .post(
      "/agent/templates/resolve",
      validator("json", RuntimeControllerProtocol.TemplateResolveRequest),
      async (c) => {
        const body = c.req.valid("json")
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/templates/resolve",
          method: c.req.method,
          entry: body?.entry,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => ({
            status: 200,
            body: await resolveTemplate(body),
          }),
        })
        return c.json(result.body, result.status as never)
      },
    )
    .post(
      "/agent/sessions",
      validator("json", RuntimeControllerProtocol.SessionCreateRequest),
      async (c) => {
        const body = c.req.valid("json")
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/sessions",
          method: c.req.method,
          entry: body?.entry,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => ({
            status: 200,
            accepted: true,
            body: await createControllerSession(body),
          }),
        })
        return c.json(result.body, result.status as never)
      },
    )
    .post(
      "/agent/sessions/:sessionID/messages",
      validator("param", z.object({ sessionID: z.string() })),
      validator("json", RuntimeControllerProtocol.MessageSendRequest),
      async (c) => {
        const body = c.req.valid("json")
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/sessions/:sessionID/messages",
          method: c.req.method,
          entry: body.entry,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => {
            const response = await sendControllerMessage(c.req.valid("param").sessionID, body)
            return {
              status: response.status,
              accepted: response.response.accepted,
              busy: response.response.busy,
              body: response.response,
            }
          },
        })
        return c.json(result.body, result.status as never)
      },
    )
    .post(
      "/agent/sessions/:sessionID/model",
      validator("param", z.object({ sessionID: z.string() })),
      validator("json", RuntimeControllerProtocol.ModelChangeRequest),
      async (c) => {
        const body = c.req.valid("json")
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/sessions/:sessionID/model",
          method: c.req.method,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => ({
            status: 200,
            accepted: true,
            body: await changeModel(c.req.valid("param").sessionID, body),
          }),
        })
        return c.json(result.body, result.status as never)
      },
    )
    .post(
      "/agent/interactions/:requestID/answer",
      validator("param", z.object({ requestID: z.string() })),
      validator("json", RuntimeControllerProtocol.InteractionAnswerRequest),
      async (c) => {
        const body = c.req.valid("json")
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/interactions/:requestID/answer",
          method: c.req.method,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => ({
            status: 200,
            accepted: true,
            body: await answerInteraction(c.req.valid("param").requestID, body),
          }),
        })
        return c.json(result.body, result.status as never)
      },
    )
    .post(
      "/agent/permissions/:requestID/answer",
      validator("param", z.object({ requestID: z.string() })),
      validator("json", RuntimeControllerProtocol.InteractionAnswerRequest),
      async (c) => {
        const body = c.req.valid("json")
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/permissions/:requestID/answer",
          method: c.req.method,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => {
            await answerInteraction(c.req.valid("param").requestID, { ...body, kind: "permission" })
            return {
              status: 200,
              accepted: true,
              body: true,
            }
          },
        })
        return c.json(result.body, result.status as never)
      },
    )
    .get(
      "/agent/sessions/:sessionID/debug",
      validator("param", z.object({ sessionID: z.string() })),
      async (c) => {
        const result = await withControllerMetrics({
          route: "/nine1bot/agent/sessions/:sessionID/debug",
          method: c.req.method,
          protocolVersion: RuntimeControllerProtocol.VERSION,
          run: async () => ({
            status: 200,
            body: await debugSession(c.req.valid("param").sessionID),
          }),
        })
        return c.json(result.body, result.status as never)
      },
    )
    .get(
      "/agent/sessions/:sessionID/events",
      validator("param", z.object({ sessionID: z.string() })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("controller event connected", { sessionID })
        const startedAt = Date.now()
        return streamSSE(c, async (stream) => {
          await emitControllerMetrics({
            route: "/nine1bot/agent/sessions/:sessionID/events",
            method: c.req.method,
            protocolVersion: RuntimeControllerProtocol.VERSION,
            startedAt,
            status: 200,
            accepted: true,
          })
          await writeEnvelope(stream, RuntimeControllerEvents.connected(sessionID))
          const unsub = Bus.subscribeAll(async (event) => {
            for (const envelope of RuntimeControllerEvents.project(event, { sessionID })) {
              await writeEnvelope(stream, envelope)
            }
          })

          const heartbeat = setInterval(() => {
            writeEnvelope(stream, RuntimeControllerEvents.heartbeat(sessionID)).catch((error) =>
              log.warn("failed to write heartbeat", { error }),
            )
          }, 30000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              unsub()
              resolve()
              log.info("controller event disconnected", { sessionID })
            })
          })
        })
      },
    ),
)
