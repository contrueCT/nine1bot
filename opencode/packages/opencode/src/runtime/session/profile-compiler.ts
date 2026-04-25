import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import type { Session } from "@/session"
import { ulid } from "ulid"
import type { SessionProfileSnapshot } from "@/runtime/protocol/agent-run-spec"

export namespace SessionProfileCompiler {
  export type Input = {
    session?: Session.Info
    directory?: string
    permission?: unknown
    source?: SessionProfileSnapshot["source"]
    agentName?: string
    templateIds?: string[]
  }

  export async function compile(input: Input): Promise<SessionProfileSnapshot> {
    const agent = await resolveAgent(input.agentName)
    const defaultModel = agent.model ?? (await Provider.defaultModel())
    const resourceResolverEnabled = await RuntimeFeatureFlags.resourceResolverEnabled()
    const templateIds = input.templateIds ?? [
      "default-user-template",
      input.source === "legacy-resumed" ? "legacy-resumed-session" : "session-profile-compiler",
    ]

    return {
      id: ulid(),
      sessionId: input.session?.id,
      createdAt: Date.now(),
      source: input.source ?? (input.session ? "legacy-resumed" : "new-session"),
      sourceTemplateIds: [
        ...templateIds,
        ...(resourceResolverEnabled ? [RuntimeResourceResolver.resourceTemplateId()] : []),
      ],
      agent: {
        name: agent.name,
        source: input.agentName ? "session-choice" : "default-user-template",
      },
      defaultModel: {
        providerID: defaultModel.providerID,
        modelID: defaultModel.modelID,
        source: "default-user-template",
      },
      context: {
        blocks: [],
      },
      resources: resourceResolverEnabled
        ? await RuntimeResourceResolver.compileProfileResources()
        : RuntimeResourceResolver.emptyResources(),
      permissions: {
        rules: input.permission && typeof input.permission === "object" ? (input.permission as Record<string, unknown>) : {},
        source: ["session-profile-compiler"],
        mergeMode: "strict",
      },
      sessionPermissionGrants: [],
      orchestration: {
        mode: "single",
      },
    }
  }

  export async function resolveAgent(agentName?: string) {
    const name = agentName ?? (await Agent.defaultAgent())
    const agent = await Agent.get(name)
    if (!agent) throw new Error(`Agent not found: ${name}`)
    return agent
  }
}
