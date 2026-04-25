import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session"
import type { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"
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
  }

  export async function fromSessionMessage(input: SessionMessageInput): Promise<AgentRunSpec> {
    const body = input.body
    const agent = await resolveAgent(body.agent)
    const model = await resolveModel({
      sessionID: input.session.id,
      requestedModel: body.model,
      agent,
    })
    const contextBlocks = legacyContextBlocks(body)
    const resources = legacyResources(body.tools)
    const templateIds = input.entry?.templateIds ?? ["legacy-session-message"]
    const now = Date.now()

    const spec: AgentRunSpec = {
      version: AGENT_RUNTIME_PROTOCOL_VERSION,
      session: {
        id: input.session.id,
        directory: input.session.directory,
        projectId: input.session.projectID,
        lifecycle: "existing",
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
        source: body.agent ? "session-choice" : "default-user-template",
      },
      context: {
        blocks: contextBlocks,
      },
      resources,
      permissions: {
        rules: {},
        source: ["legacy-session"],
        mergeMode: "strict",
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
        modelSource: model.auditSource,
        agentSource: body.agent ? "session-choice" : "legacy-adapter",
        contextBlocks: contextBlocks.map((block) => ({
          id: block.id,
          source: block.source,
          enabled: block.enabled,
        })),
        resources: {
          mcp: [],
          skills: [],
          builtinTools: Object.keys(body.tools ?? {}),
        },
        permissionSources: ["legacy-session"],
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
      contextBlocks: contextBlocks.length,
      toolOverrides: Object.keys(body.tools ?? {}).length,
      createdAt: now,
    })
    log.debug("legacy AgentRunSpec", { spec })

    return spec
  }

  export async function fromSessionCreate(input: SessionCreateInput): Promise<SessionProfileSnapshot> {
    const agent = await resolveAgent()
    const defaultModel = agent.model ?? (await Provider.defaultModel())
    return {
      id: ulid(),
      sessionId: input.session?.id,
      createdAt: Date.now(),
      source: input.session ? "legacy-resumed" : "new-session",
      sourceTemplateIds: ["default-user-template", "legacy-session-create"],
      agent: {
        name: agent.name,
        source: "default-user-template",
      },
      defaultModel: {
        providerID: defaultModel.providerID,
        modelID: defaultModel.modelID,
        source: "default-user-template",
      },
      context: {
        blocks: [],
      },
      resources: emptyResources(),
      permissions: {
        rules: input.permission && typeof input.permission === "object" ? (input.permission as Record<string, unknown>) : {},
        source: ["legacy-session-create"],
        mergeMode: "strict",
      },
      sessionPermissionGrants: [],
      orchestration: {
        mode: "single",
      },
    }
  }

  async function resolveAgent(agentName?: string) {
    const name = agentName ?? (await Agent.defaultAgent())
    const agent = await Agent.get(name)
    if (!agent) throw new Error(`Agent not found: ${name}`)
    return agent
  }

  async function resolveModel(input: {
    sessionID: string
    requestedModel?: { providerID: string; modelID: string }
    agent: Agent.Info
  }): Promise<ModelSpec & { auditSource: string }> {
    if (input.requestedModel) {
      return {
        providerID: input.requestedModel.providerID,
        modelID: input.requestedModel.modelID,
        source: "runtime-override",
        auditSource: "runtime-override",
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
    return lastModel(input.sessionID)
  }

  async function lastModel(sessionID: string): Promise<ModelSpec & { auditSource: string }> {
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
    const model = await Provider.defaultModel()
    return {
      providerID: model.providerID,
      modelID: model.modelID,
      source: "profile-snapshot",
      auditSource: "legacy-adapter",
    }
  }

  function legacyContextBlocks(input: Omit<SessionPrompt.PromptInput, "sessionID">): ContextBlock[] {
    if (!input.system) return []
    return [
      {
        id: "runtime:legacy-system",
        layer: "runtime",
        source: "legacy-session-message.system",
        enabled: true,
        priority: 0,
        lifecycle: "turn",
        visibility: "system-required",
        content: input.system,
      },
    ]
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
    return {
      builtinTools: {},
      mcp: {
        servers: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      skills: {
        skills: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
    }
  }
}
