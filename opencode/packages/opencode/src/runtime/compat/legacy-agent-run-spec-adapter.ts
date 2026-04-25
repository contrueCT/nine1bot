import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session"
import type { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { RuntimeContextEvents } from "@/runtime/context/events"
import { SessionRuntimeProfile } from "@/runtime/session/profile"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import { SessionProfileCompiler } from "@/runtime/session/profile-compiler"
import { ulid } from "ulid"
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRunSpec,
  type AgentSpec,
  type ContextBlock,
  type EntrySpec,
  type ModelSpec,
  type ResourceSpec,
  type SessionProfileSnapshot,
} from "@/runtime/protocol/agent-run-spec"

export namespace LegacyAgentRunSpecAdapter {
  const log = Log.create({ service: "runtime.legacy-adapter" })

  export type SessionMessageInput = {
    session: Session.Info
    body: Omit<SessionPrompt.PromptInput, "sessionID">
    entry?: Partial<EntrySpec>
  }

  export type SessionCreateInput = {
    session?: Session.Info
    directory?: string
    permission?: unknown
    source?: SessionProfileSnapshot["source"]
    agentName?: string
  }

  export async function fromSessionMessage(input: SessionMessageInput): Promise<AgentRunSpec> {
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
            templateIds: ["default-user-template", "legacy-session-create"],
          })
        : undefined)
    if (profile && body.agent && body.agent !== profile.agent.name) {
      log.warn("ignoring per-turn agent override for profiled session", {
        sessionID: input.session.id,
        requestedAgent: body.agent,
        profileAgent: profile.agent.name,
        profileSnapshotID: profile.id,
      })
    }
    const agent = await resolveAgent(profile?.agent.name ?? body.agent)
    const model = await resolveModel({
      session: input.session,
      requestedModel: body.model,
      agent,
      profile,
      allowLegacyHistoryModel: !!profile && !storedProfile,
    })
    const contextBlocks = legacyContextBlocks(body)
    const resources = profile?.resources ?? legacyResources(body.tools)
    const templateIds = input.entry?.templateIds ?? ["legacy-session-message"]
    const now = Date.now()

    const spec: AgentRunSpec = {
      version: AGENT_RUNTIME_PROTOCOL_VERSION,
      session: {
        id: input.session.id,
        directory: input.session.directory,
        projectId: input.session.projectID,
        lifecycle: "existing",
        profileSnapshot: profile,
      },
      entry: {
        source: input.entry?.source ?? "api",
        platform: input.entry?.platform,
        mode: input.entry?.mode ?? "legacy-session-message",
        templateIds,
        traceId: input.entry?.traceId ?? ulid(),
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
        source: profile?.agent.source ?? (body.agent ? "session-choice" : "default-user-template"),
      },
      context: {
        blocks: contextBlocks,
      },
      resources,
      permissions: {
        rules: {},
        source: profile ? ["legacy-session", "profile-snapshot"] : ["legacy-session"],
        mergeMode: "strict",
        sessionGrants: profile?.sessionPermissionGrants,
      },
      orchestration: {
        mode: "single",
      },
      runtime: {
        noReply: body.noReply,
      },
      audit: {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        templates: templateIds,
        profileSnapshotId: profile?.id,
        modelSource: model.auditSource,
        agentSource: profile ? "profile-snapshot" : body.agent ? "session-choice" : "legacy-adapter",
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
        permissionSources: profile ? ["legacy-session", "profile-snapshot"] : ["legacy-session"],
        legacy: {
          adapter: "LegacyAgentRunSpecAdapter.fromSessionMessage",
          promptFields: Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined),
        },
      },
    }

    log.info("compiled legacy session message", {
      sessionID: input.session.id,
      traceID: spec.entry.traceId,
      agent: spec.agent.name,
      providerID: spec.model.providerID,
      modelID: spec.model.modelID,
      profileSnapshotID: profile?.id,
      contextBlocks: contextBlocks.length,
      toolOverrides: Object.keys(body.tools ?? {}).length,
      createdAt: now,
    })
    log.debug("legacy AgentRunSpec", { spec })

    return spec
  }

  export async function fromSessionCreate(input: SessionCreateInput): Promise<SessionProfileSnapshot> {
    return SessionProfileCompiler.compile({
      ...input,
      templateIds: ["default-user-template", "legacy-session-create"],
    })
  }

  async function resolveAgent(agentName?: string) {
    const name = agentName ?? (await Agent.defaultAgent())
    const agent = await Agent.get(name)
    if (!agent) throw new Error(`Agent not found: ${name}`)
    return agent
  }

  async function resolveModel(input: {
    session: Session.Info
    requestedModel?: { providerID: string; modelID: string }
    agent: Agent.Info
    profile?: SessionProfileSnapshot
    allowLegacyHistoryModel?: boolean
  }): Promise<ModelSpec & { auditSource: string }> {
    if (input.requestedModel) {
      return {
        providerID: input.requestedModel.providerID,
        modelID: input.requestedModel.modelID,
        source: "session-choice",
        auditSource: "session-choice",
      }
    }
    if (input.profile && input.session.runtime?.currentModel) {
      return {
        providerID: input.session.runtime.currentModel.providerID,
        modelID: input.session.runtime.currentModel.modelID,
        source: input.session.runtime.currentModel.source,
        auditSource: input.session.runtime.currentModel.source,
      }
    }
    if (input.allowLegacyHistoryModel) {
      const historyModel = await lastModel(input.session.id, { fallback: false })
      if (historyModel) return historyModel
    }
    if (input.profile) {
      return {
        providerID: input.profile.defaultModel.providerID,
        modelID: input.profile.defaultModel.modelID,
        source: "profile-snapshot",
        auditSource: "profile-snapshot",
      }
    }
    if (input.agent.model) {
      return {
        providerID: input.agent.model.providerID,
        modelID: input.agent.model.modelID,
        source: "profile-snapshot",
        auditSource: "legacy-adapter",
      }
    }
    const model = await lastModel(input.session.id)
    if (model) return model
    throw new Error("Unable to resolve session model")
  }

  async function lastModel(
    sessionID: string,
    options?: { fallback?: boolean },
  ): Promise<(ModelSpec & { auditSource: string }) | undefined> {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) {
        return {
          providerID: item.info.model.providerID,
          modelID: item.info.model.modelID,
          source: "session-choice",
          auditSource: "session-choice",
        }
      }
    }
    if (options?.fallback === false) return undefined
    const model = await Provider.defaultModel()
    return {
      providerID: model.providerID,
      modelID: model.modelID,
      source: "profile-snapshot",
      auditSource: "legacy-adapter",
    }
  }

  function legacyContextBlocks(input: Omit<SessionPrompt.PromptInput, "sessionID">): ContextBlock[] {
    const blocks = [...(input.context?.blocks ?? [])]
    if (input.context?.page) {
      blocks.push(...RuntimeContextEvents.blocksFromPagePayload(input.context.page))
    }
    if (input.system) {
      blocks.push({
        id: "runtime:legacy-system",
        layer: "runtime",
        source: "legacy-session-message.system",
        enabled: true,
        priority: 0,
        lifecycle: "turn",
        visibility: "system-required",
        content: input.system,
      })
    }
    return blocks
  }

  function legacyResources(tools?: Record<string, boolean>): ResourceSpec {
    return {
      ...emptyResources(),
      builtinTools: {
        enabledTools: Object.entries(tools ?? {})
          .filter(([, enabled]) => enabled)
          .map(([tool]) => tool),
      },
    }
  }

  function emptyResources(): ResourceSpec {
    return RuntimeResourceResolver.emptyResources()
  }
}
