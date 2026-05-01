import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import type { Session } from "@/session"
import { ulid } from "ulid"
import type {
  ContextSpec,
  OrchestrationSpec,
  ResourceSpec,
  SessionProfileSnapshot,
} from "@/runtime/protocol/agent-run-spec"

export namespace SessionProfileCompiler {
  export type ProfileTemplate = {
    templateIds?: string[]
    context?: Pick<ContextSpec, "blocks" | "policy">
    resources?: ResourceSpec
    permissions?: {
      rules?: Record<string, unknown>
      source?: string[]
    }
    orchestration?: OrchestrationSpec
  }

  export type Input = {
    session?: Session.Info
    directory?: string
    permission?: unknown
    source?: SessionProfileSnapshot["source"]
    agentName?: string
    templateIds?: string[]
    profileTemplate?: ProfileTemplate
  }

  export async function compile(input: Input): Promise<SessionProfileSnapshot> {
    const agent = await resolveAgent(input.agentName)
    const defaultModel = agent.model ?? (await Provider.defaultModel())
    const resourceResolverEnabled = await RuntimeFeatureFlags.resourceResolverEnabled()
    const templateIds = input.templateIds ?? input.profileTemplate?.templateIds ?? [
      "default-user-template",
      input.source === "legacy-resumed" ? "legacy-resumed-session" : "session-profile-compiler",
    ]
    const permissionRules = {
      ...(input.profileTemplate?.permissions?.rules ?? {}),
      ...(input.permission && typeof input.permission === "object" ? (input.permission as Record<string, unknown>) : {}),
    }
    const permissionSource = unique([
      ...(input.profileTemplate?.permissions?.source ?? []),
      "session-profile-compiler",
    ])

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
        blocks: input.profileTemplate?.context?.blocks ?? [],
        policy: input.profileTemplate?.context?.policy,
      },
      resources: resourceResolverEnabled
        ? input.profileTemplate?.resources ?? (await RuntimeResourceResolver.compileProfileResources())
        : RuntimeResourceResolver.emptyResources(),
      permissions: {
        rules: permissionRules,
        source: permissionSource,
        mergeMode: "strict",
      },
      sessionPermissionGrants: [],
      orchestration: input.profileTemplate?.orchestration ?? {
        mode: "single",
      },
    }
  }

  export async function resolveAgent(agentName?: string) {
    const name = agentName ?? (await Agent.defaultAgent())
    const agent = await Agent.get(name, agentName ? { includeDeclaredOnly: true, includeRecommendable: true } : undefined)
    if (!agent) throw new Error(`Agent not found: ${name}`)
    return agent
  }

  function unique(values: string[]) {
    return [...new Set(values)]
  }
}
