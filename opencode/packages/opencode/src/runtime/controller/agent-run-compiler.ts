import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { RuntimePromptBridgeCompiler } from "@/runtime/bridge/prompt-compiler"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { RuntimeContextPipeline } from "@/runtime/context/pipeline"
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRunSpec,
  type ContextBlock,
  type ModelSpec,
  type SessionProfileSnapshot,
} from "@/runtime/protocol/agent-run-spec"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import { SessionProfileCompiler } from "@/runtime/session/profile-compiler"
import { SessionRuntimeProfile } from "@/runtime/session/profile"
import type { Session } from "@/session"
import type { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"
import { ulid } from "ulid"

export namespace ControllerAgentRunCompiler {
  const log = Log.create({ service: "runtime.controller-compiler" })

  export type Input = {
    session: Session.Info
    body: RuntimeControllerProtocol.MessageSendRequest
    turnSnapshotId: string
  }

  export async function compileSpec(input: Input): Promise<AgentRunSpec> {
    const body = input.body
    const profileSnapshotEnabled = await RuntimeFeatureFlags.profileSnapshotEnabled()
    const storedProfile = profileSnapshotEnabled ? await SessionRuntimeProfile.read(input.session) : undefined
    const profile =
      storedProfile ??
      (profileSnapshotEnabled
        ? await SessionProfileCompiler.compile({
            session: input.session,
            directory: input.session.directory,
            permission: input.session.permission,
            source: "legacy-resumed",
          })
        : undefined)
    const agent = await resolveAgent(input.session, profile)
    const ignoredAgentOverride =
      body.agent && body.agent !== agent.name
        ? {
            requested: body.agent,
            profile: agent.name,
          }
        : undefined
    if (ignoredAgentOverride) {
      log.warn("ignoring controller per-turn agent override", {
        sessionID: input.session.id,
        requestedAgent: ignoredAgentOverride.requested,
        profileAgent: ignoredAgentOverride.profile,
        profileSnapshotID: profile?.id,
      })
    }
    const model = await resolveModel({
      session: input.session,
      requestedModel: body.model,
      agent,
      profile,
    })
    const contextBlocks = controllerContextBlocks(body)
    const resources = profile?.resources ?? RuntimeResourceResolver.emptyResources()
    const templateIds = body.entry?.templateIds ?? ["default-user-template", "controller-message"]
    const capabilities = capabilitiesFrom(body, { profileSnapshotEnabled })
    const permissionSources = profile ? ["controller-message", "profile-snapshot"] : ["controller-message"]

    const spec: AgentRunSpec = {
      version: AGENT_RUNTIME_PROTOCOL_VERSION,
      capabilities,
      session: {
        id: input.session.id,
        directory: input.session.directory,
        projectId: input.session.projectID,
        lifecycle: "existing",
        profileSnapshot: profile,
      },
      entry: {
        source: body.entry?.source ?? "api",
        platform: body.entry?.platform,
        mode: body.entry?.mode ?? "controller-message",
        templateIds,
        traceId: body.entry?.traceId ?? ulid(),
      },
      input: {
        parts: body.parts as AgentRunSpec["input"]["parts"],
      },
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        source: model.source,
      },
      agent: {
        name: agent.name,
        source: profile?.agent.source ?? "default-user-template",
      },
      context: {
        blocks: contextBlocks,
        policy: profile?.context.policy,
      },
      resources,
      permissions: {
        rules: profile?.permissions.rules ?? {},
        source: permissionSources,
        mergeMode: "strict",
        sessionGrants: profile?.sessionPermissionGrants,
      },
      orchestration: profile?.orchestration ?? {
        mode: "single",
      },
      runtime: {
        noReply: body.noReply,
        debug: body.runtimeOverride?.debug,
        timing: body.runtimeOverride?.timing,
        timeoutMs: body.runtimeOverride?.timeoutMs,
        turnSnapshotId: input.turnSnapshotId,
      },
      audit: {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        capabilityNegotiation: capabilities,
        templates: templateIds,
        profileSnapshotId: profile?.id,
        modelSource: model.auditSource,
        agentSource: profile ? "profile-snapshot" : "default-user-template",
        agentOverrideIgnored: ignoredAgentOverride,
        contextBlocks: contextBlocks.map((block) => ({
          id: block.id,
          source: block.source,
          enabled: block.enabled,
        })),
        resources: {
          mcp: resources.mcp.servers,
          skills: resources.skills.skills,
          builtinTools: Object.keys(body.tools ?? {}),
        },
        permissionSources,
      },
    }

    log.info("compiled controller message", {
      sessionID: input.session.id,
      traceID: spec.entry.traceId,
      agent: spec.agent.name,
      providerID: spec.model.providerID,
      modelID: spec.model.modelID,
      profileSnapshotID: profile?.id,
      contextBlocks: contextBlocks.length,
    })
    log.debug("controller AgentRunSpec", { spec })

    return spec
  }

  export async function compileTurnSnapshot(input: Input) {
    const spec = await compileSpec(input)
    return RuntimePromptBridgeCompiler.compileTurnSnapshot(spec, {
      messageID: input.body.messageID,
      tools: input.body.tools,
      variant: input.body.variant,
      context: bridgeContext(spec, input.body),
    })
  }

  export async function compilePrompt(input: Input): Promise<SessionPrompt.PromptInput> {
    return RuntimePromptBridgeCompiler.compilePrompt(await compileTurnSnapshot(input))
  }

  async function resolveAgent(session: Session.Info, profile?: SessionProfileSnapshot) {
    const name = profile?.agent.name ?? session.runtime?.agent ?? (await Agent.defaultAgent())
    const agent = await Agent.get(name)
    if (!agent) throw new Error(`Agent not found: ${name}`)
    return agent
  }

  async function resolveModel(input: {
    session: Session.Info
    requestedModel?: { providerID: string; modelID: string }
    agent: Agent.Info
    profile?: SessionProfileSnapshot
  }): Promise<ModelSpec & { auditSource: string }> {
    if (input.requestedModel) {
      return {
        providerID: input.requestedModel.providerID,
        modelID: input.requestedModel.modelID,
        source: "session-choice",
        auditSource: "session-choice",
      }
    }
    if (input.session.runtime?.currentModel) {
      return {
        providerID: input.session.runtime.currentModel.providerID,
        modelID: input.session.runtime.currentModel.modelID,
        source: input.session.runtime.currentModel.source,
        auditSource: input.session.runtime.currentModel.source,
      }
    }
    if (input.profile) {
      return {
        providerID: input.profile.defaultModel.providerID,
        modelID: input.profile.defaultModel.modelID,
        source: "profile-snapshot",
        auditSource: "profile-snapshot",
      }
    }
    const model = input.agent.model ?? (await Provider.defaultModel())
    return {
      providerID: model.providerID,
      modelID: model.modelID,
      source: "profile-snapshot",
      auditSource: "default-user-template",
    }
  }

  function controllerContextBlocks(body: RuntimeControllerProtocol.MessageSendRequest): ContextBlock[] {
    const blocks = [...((body.context?.blocks ?? []) as ContextBlock[])]
    if (body.system?.trim()) {
      blocks.push(
        RuntimeContextPipeline.textBlock({
          id: "runtime:controller-message-system",
          layer: "runtime",
          source: "controller-message.system",
          content: body.system,
          lifecycle: "turn",
          visibility: "system-required",
          priority: 90,
        }),
      )
    }
    return blocks
  }

  function bridgeContext(spec: AgentRunSpec, body: RuntimeControllerProtocol.MessageSendRequest) {
    if (spec.context.blocks.length === 0 && !body.context?.page) return undefined
    return {
      blocks: spec.context.blocks,
      page: body.context?.page as SessionPrompt.PromptInput["context"] extends infer ContextInput
        ? ContextInput extends { page?: infer Page }
          ? Page
          : never
        : never,
    }
  }

  function capabilitiesFrom(
    body: RuntimeControllerProtocol.MessageSendRequest,
    flags: { profileSnapshotEnabled: boolean },
  ): AgentRunSpec["capabilities"] {
    return {
      client: {
        permissionAsk: body.clientCapabilities?.permissionRequests,
        debugPanel: body.clientCapabilities?.debug,
        pageContext: body.clientCapabilities?.pageContext,
        selectionContext: body.clientCapabilities?.selectionContext,
        resourceFailureEvents: body.clientCapabilities?.resourceFailures,
      },
      server: {
        protocolVersions: [RuntimeControllerProtocol.VERSION],
        contextEvents: true,
        resourceHealthEvents: true,
        sessionPermissionGrants: true,
        profileSnapshots: flags.profileSnapshotEnabled,
      },
    }
  }
}
