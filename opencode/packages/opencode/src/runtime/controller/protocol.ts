import z from "zod"
import { AGENT_RUNTIME_PROTOCOL_VERSION } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimeControllerProtocol {
  export const VERSION = AGENT_RUNTIME_PROTOCOL_VERSION

  export const ClientCapabilities = z
    .object({
      interactions: z.boolean().optional(),
      permissionRequests: z.boolean().optional(),
      questionRequests: z.boolean().optional(),
      artifacts: z.boolean().optional(),
      filePreview: z.boolean().optional(),
      pageContext: z.boolean().optional(),
      selectionContext: z.boolean().optional(),
      debug: z.boolean().optional(),
      resourceFailures: z.boolean().optional(),
      contextAudit: z.boolean().optional(),
      turnSnapshots: z.boolean().optional(),
      continueInWeb: z.boolean().optional(),
    })
    .passthrough()
  export type ClientCapabilities = z.infer<typeof ClientCapabilities>

  export const ModelChoice = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })
  export type ModelChoice = z.infer<typeof ModelChoice>

  export const ResourceSelection = z
    .object({
      builtinTools: z
        .object({
          enabledGroups: z.array(z.string()).optional(),
          enabledTools: z.array(z.string()).optional(),
        })
        .optional(),
      mcp: z
        .object({
          servers: z.array(z.string()).optional(),
          tools: z.record(z.string(), z.array(z.string())).optional(),
        })
        .optional(),
      skills: z
        .object({
          skills: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional()
  export type ResourceSelection = z.infer<typeof ResourceSelection>

  export const SessionChoice = z
    .object({
      agent: z.string().optional(),
      model: ModelChoice.optional(),
      resources: ResourceSelection,
    })
    .optional()
  export type SessionChoice = z.infer<typeof SessionChoice>

  export const RuntimeOverride = z
    .object({
      debug: z.boolean().optional(),
      timing: z.boolean().optional(),
      timeoutMs: z.number().optional(),
    })
    .optional()
  export type RuntimeOverride = z.infer<typeof RuntimeOverride>

  export const Entry = z
    .object({
      source: z.enum(["web", "feishu", "browser-extension", "api", "webhook"]).optional(),
      platform: z.string().optional(),
      mode: z.string().optional(),
      templateIds: z.array(z.string()).optional(),
      traceId: z.string().optional(),
    })
    .optional()
  export type Entry = z.infer<typeof Entry>

  export const CapabilitiesResponse = z.object({
    version: z.literal(VERSION),
    protocolVersions: z.array(z.string()),
    server: z.object({
      controllerApi: z.literal(true),
      sessionProfileSnapshots: z.boolean(),
      contextPipeline: z.boolean(),
      resourceResolver: z.boolean(),
      sessionEvents: z.literal(true),
      interactionEvents: z.literal(true),
      artifactEvents: z.literal(true),
      debugApi: z.literal(true),
      legacyEventProjection: z.literal(true),
    }),
    eventTypes: z.array(z.string()),
    fallbackActions: z.array(z.enum(["continue-in-web", "open-settings", "start-auth", "retry"])),
  })
  export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponse>

  export const TemplateResolveRequest = z
    .object({
      entry: Entry,
      sessionChoice: SessionChoice,
      clientCapabilities: ClientCapabilities.optional(),
      page: z.any().optional(),
    })
    .optional()
  export type TemplateResolveRequest = z.infer<typeof TemplateResolveRequest>

  export const SessionCreateRequest = z
    .object({
      title: z.string().optional(),
      directory: z.string().optional(),
      permission: z.unknown().optional(),
      entry: Entry,
      sessionChoice: SessionChoice,
      clientCapabilities: ClientCapabilities.optional(),
      page: z.any().optional(),
      debug: z
        .object({
          profileSnapshot: z.boolean().optional(),
        })
        .optional(),
    })
    .optional()
  export type SessionCreateRequest = z.infer<typeof SessionCreateRequest>

  export const MessageSendRequest = z.object({
    messageID: z.string().optional(),
    parts: z.array(z.any()),
    context: z
      .object({
        blocks: z.array(z.any()).optional(),
        page: z.any().optional(),
      })
      .optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    model: ModelChoice.optional(),
    agent: z.string().optional(),
    entry: Entry,
    runtimeOverride: RuntimeOverride,
    clientCapabilities: ClientCapabilities.optional(),
  })
  export type MessageSendRequest = z.infer<typeof MessageSendRequest>

  export const MessageSendResponse = z.object({
    version: z.literal(VERSION),
    accepted: z.boolean(),
    sessionId: z.string(),
    turnSnapshotId: z.string().optional(),
    busy: z.boolean().optional(),
    fallbackAction: z
      .object({
        type: z.enum(["continue-in-web"]),
        label: z.string(),
      })
      .optional(),
  })
  export type MessageSendResponse = z.infer<typeof MessageSendResponse>

  export const ModelChangeRequest = z.object({
    model: ModelChoice,
  })
  export type ModelChangeRequest = z.infer<typeof ModelChangeRequest>

  export const InteractionAnswerRequest = z.object({
    kind: z.enum(["question", "permission"]).optional(),
    answer: z.union([
      z.literal("allow-once"),
      z.literal("allow-session"),
      z.literal("deny"),
      z.object({
        answers: z.array(z.array(z.string())),
      }),
    ]),
    message: z.string().optional(),
  })
  export type InteractionAnswerRequest = z.infer<typeof InteractionAnswerRequest>

  export const RuntimeEventTypes = [
    "runtime.server.connected",
    "runtime.server.heartbeat",
    "runtime.session.created",
    "runtime.session.updated",
    "runtime.session.deleted",
    "runtime.session.status",
    "runtime.message.created",
    "runtime.message.updated",
    "runtime.message.removed",
    "runtime.message.part.updated",
    "runtime.message.part.removed",
    "runtime.interaction.requested",
    "runtime.interaction.answered",
    "runtime.artifact.available",
    "runtime.artifact.closed",
    "runtime.resource.failed",
    "runtime.resources.resolved",
    "runtime.context.compiled",
    "runtime.turn.started",
    "runtime.turn.completed",
    "runtime.turn.failed",
    "runtime.todo.updated",
  ] as const
  export type RuntimeEventType = (typeof RuntimeEventTypes)[number] | `runtime.${string}`
}
