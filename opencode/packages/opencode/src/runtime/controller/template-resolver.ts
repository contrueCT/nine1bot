import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { RuntimeContextEvents } from "@/runtime/context/events"
import { RuntimeContextPipeline } from "@/runtime/context/pipeline"
import type {
  ContextBlock,
  OrchestrationSpec,
  ResourceSpec,
  SessionProfileSnapshot,
} from "@/runtime/protocol/agent-run-spec"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { RuntimePlatformAdapterRegistry } from "@/runtime/platform/adapter"

export namespace ControllerTemplateResolver {
  export type Input = {
    entry?: RuntimeControllerProtocol.Entry
    sessionChoice?: RuntimeControllerProtocol.SessionChoice
    clientCapabilities?: RuntimeControllerProtocol.ClientCapabilities
    page?: RuntimeContextEvents.RequestPagePayload
  }

  export type ProfileTemplate = {
    templateIds: string[]
    context: SessionProfileSnapshot["context"]
    resources: ResourceSpec
    orchestration: OrchestrationSpec
    permissions?: {
      rules?: Record<string, unknown>
      source?: string[]
    }
    audit: TemplateAudit
  }

  export type TemplateAudit = {
    requestedTemplateIds: string[]
    inferredTemplateIds: string[]
    templates: string[]
    skippedPlatforms: RuntimePlatformAdapterRegistry.PlatformSkipAudit[]
    resourceMergeMode: "additive-only"
    contextBlocks: Array<{ id: string; source: string; enabled: boolean }>
    agentRecommendation?: {
      requested?: string
      resolved: string
      accepted: boolean
      platform?: string
      reason?: "not-found"
    }
    resources: {
      builtinGroups: string[]
      builtinTools: string[]
      mcp: string[]
      skills: string[]
    }
  }

  export type Resolved = {
    version: typeof RuntimeControllerProtocol.VERSION
    templateIds: string[]
    defaultAgent: {
      name: string
      source: "default-user-template" | "session-choice"
    }
    recommendedAgent?: string
    defaultModel: {
      providerID: string
      modelID: string
      source: "default-user-template"
    }
    contextPreview: Array<{ id: string; layer: ContextBlock["layer"]; source: string; enabled: boolean }>
    resourcesPreview: {
      builtinTools: string[]
      builtinGroups: string[]
      mcp: string[]
      skills: string[]
    }
    orchestration: OrchestrationSpec
    profileTemplate: ProfileTemplate
    audit: TemplateAudit
  }

  const FEISHU_CONTEXT = [
    "You are replying inside a Feishu private chat.",
    "Keep replies plain text, concise, and easy to read in chat.",
    "Do not use markdown in this chat, and do not include code blocks.",
    "If a permission request or follow-up question is rejected, clearly tell the user that they need to continue in the web UI.",
  ].join("\n")
  const SCHEDULED_ENTRY_CONTEXT = [
    "This session was created by a Nine1Bot scheduled task.",
    "There may be no user available to answer follow-up questions during this run.",
    "Stay within the configured unattended permissions and make the final result easy to inspect later.",
  ].join("\n")

  export async function resolve(input: Input = {}): Promise<Resolved> {
    const requestedTemplateIds = normalizeTemplateIds(input.entry?.templateIds ?? [])
    const inferredTemplateIds = inferTemplateIds(input)
    const rawTemplateIds = normalizeTemplateIds([
      "default-user-template",
      ...(requestedTemplateIds.length > 0 ? requestedTemplateIds : inferredTemplateIds),
      ...inferredTemplateIds,
    ])
    const page = normalizePage(input.page)
    const skippedPlatforms = RuntimePlatformAdapterRegistry.disabledAudits({
      page,
      templateIds: rawTemplateIds,
    })
    const templateIds = RuntimePlatformAdapterRegistry.activeTemplateIds(rawTemplateIds)
    const agent = await resolveAgent(input.sessionChoice?.agent)
    const agentRecommendation = await recommendedAgent(templateIds, agent.name)
    const defaultModel = agent.model ?? (await Provider.defaultModel())
    const resources = (await RuntimeFeatureFlags.resourceResolverEnabled())
      ? mergeResources(
          await RuntimeResourceResolver.compileProfileResources(),
          resourcesForTemplates(templateIds),
          resourcesFromSelection(input.sessionChoice?.resources),
        )
      : RuntimeResourceResolver.emptyResources()
    const contextBlocks = blocksForTemplates(templateIds, input)
    const orchestration: OrchestrationSpec = {
      mode: "single",
    }
    const audit: TemplateAudit = {
      requestedTemplateIds,
      inferredTemplateIds,
      templates: templateIds,
      skippedPlatforms,
      resourceMergeMode: "additive-only",
      contextBlocks: contextBlocks.map((block) => ({
        id: block.id,
        source: block.source,
        enabled: block.enabled,
      })),
      agentRecommendation: agentRecommendation.audit,
      resources: {
        builtinGroups: resources.builtinTools.enabledGroups ?? [],
        builtinTools: resources.builtinTools.enabledTools ?? [],
        mcp: resources.mcp.servers,
        skills: resources.skills.skills,
      },
    }

    return {
      version: RuntimeControllerProtocol.VERSION,
      templateIds,
      defaultAgent: {
        name: agent.name,
        source: input.sessionChoice?.agent ? "session-choice" : "default-user-template",
      },
      recommendedAgent: agentRecommendation.value,
      defaultModel: {
        providerID: defaultModel.providerID,
        modelID: defaultModel.modelID,
        source: "default-user-template",
      },
      contextPreview: contextBlocks.map((block) => ({
        id: block.id,
        layer: block.layer,
        source: block.source,
        enabled: block.enabled,
      })),
      resourcesPreview: {
        builtinGroups: resources.builtinTools.enabledGroups ?? [],
        builtinTools: resources.builtinTools.enabledTools ?? [],
        mcp: resources.mcp.servers,
        skills: resources.skills.skills,
      },
      orchestration,
      profileTemplate: {
        templateIds,
        context: {
          blocks: contextBlocks,
        },
        resources,
        orchestration,
        permissions: {
          source: ["controller-template-resolver"],
        },
        audit,
      },
      audit,
    }
  }

  async function resolveAgent(agentName?: string) {
    const name = agentName ?? (await Agent.defaultAgent())
    const agent = await Agent.get(name, agentName ? { includeDeclaredOnly: true, includeRecommendable: true } : undefined)
    if (!agent) throw new Error(`Agent not found: ${name}`)
    return agent
  }

  function inferTemplateIds(input: Input) {
    const ids: string[] = []
    const source = input.entry?.source
    const platform = input.entry?.platform
    const mode = input.entry?.mode
    const page = normalizePage(input.page)

    if (!source || source === "web" || mode === "web-chat") ids.push("web-chat")
    if (source === "feishu" || platform === "feishu" || mode === "feishu-private-chat") ids.push("feishu-chat")
    if (source === "browser-extension" || mode === "browser-sidepanel") ids.push("browser-generic")
    if (platform === "generic-browser") ids.push("browser-generic")
    if (source === "schedule" || mode === "scheduled-run") ids.push("scheduled-entry")
    ids.push(...RuntimePlatformAdapterRegistry.inferTemplateIds({ entry: input.entry, page }))
    return ids
  }

  function normalizeTemplateIds(values: string[]) {
    return unique(
      values
        .map(normalizeTemplateId)
        .filter((value): value is string => Boolean(value)),
    )
  }

  function normalizeTemplateId(value?: string) {
    if (!value?.trim()) return undefined
    if (value === "feishu-private-chat") return "feishu-chat"
    if (value === "browser-sidepanel") return "browser-generic"
    return value
  }

  function blocksForTemplates(templateIds: string[], input: Input) {
    const page = normalizePage(input.page)
    const blocks: ContextBlock[] = []
    for (const templateId of templateIds) {
      if (templateId === "web-chat") {
        blocks.push(
          RuntimeContextPipeline.textBlock({
            id: "template:web-chat",
            layer: "business",
            source: "template.web-chat",
            content: "Nine1Bot Web chat session.",
            lifecycle: "session",
            visibility: "developer-toggle",
            priority: 10,
          }),
        )
      }
      if (templateId === "feishu-chat") {
        blocks.push(
          RuntimeContextPipeline.textBlock({
            id: "template:feishu-chat",
            layer: "platform",
            source: "template.feishu-chat",
            content: FEISHU_CONTEXT,
            lifecycle: "session",
            visibility: "system-required",
            priority: 80,
          }),
        )
      }
      if (templateId === "browser-generic") {
        blocks.push(
          RuntimeContextPipeline.textBlock({
            id: "template:browser-generic",
            layer: "platform",
            source: "template.browser-generic",
            content: "This session was created from the browser extension side panel. Active page and selection context may be attached when the user sends a message.",
            lifecycle: "session",
            visibility: "developer-toggle",
            priority: 35,
          }),
        )
      }
      if (templateId === "scheduled-entry") {
        blocks.push(
          RuntimeContextPipeline.textBlock({
            id: "template:scheduled-entry",
            layer: "business",
            source: "template.scheduled-entry",
            content: SCHEDULED_ENTRY_CONTEXT,
            lifecycle: "session",
            visibility: "developer-toggle",
            priority: 35,
          }),
        )
      }
    }
    blocks.push(...RuntimePlatformAdapterRegistry.templateContextBlocks({ templateIds, page }))
    return dedupeBlocks(blocks)
  }

  function resourcesForTemplates(templateIds: string[]) {
    const resources = RuntimeResourceResolver.emptyResources()
    for (const templateId of templateIds) {
      if (templateId === "web-chat") {
        resources.builtinTools.enabledGroups = union(resources.builtinTools.enabledGroups, ["web-chat"])
      }
      if (templateId === "feishu-chat") {
        resources.builtinTools.enabledGroups = union(resources.builtinTools.enabledGroups, ["chat-text"])
      }
      if (templateId === "browser-generic") {
        resources.builtinTools.enabledGroups = union(resources.builtinTools.enabledGroups, ["browser-context"])
      }
    }
    for (const contribution of RuntimePlatformAdapterRegistry.resourceContributions({ templateIds })) {
      resources.builtinTools.enabledGroups = union(resources.builtinTools.enabledGroups, contribution.builtinTools.enabledGroups)
      resources.builtinTools.enabledTools = union(resources.builtinTools.enabledTools, contribution.builtinTools.enabledTools)
      resources.mcp.servers = union(resources.mcp.servers, contribution.mcp.servers)
      resources.mcp.tools = mergeMcpTools(resources.mcp.tools, contribution.mcp.tools)
      resources.skills.skills = union(resources.skills.skills, contribution.skills.skills)
    }
    return resources
  }

  function resourcesFromSelection(selection?: RuntimeControllerProtocol.ResourceSelection) {
    const resources = RuntimeResourceResolver.emptyResources()
    resources.builtinTools.enabledGroups = unique(selection?.builtinTools?.enabledGroups ?? [])
    resources.builtinTools.enabledTools = unique(selection?.builtinTools?.enabledTools ?? [])
    resources.mcp.servers = unique(selection?.mcp?.servers ?? [])
    resources.mcp.tools = selection?.mcp?.tools
    resources.skills.skills = unique(selection?.skills?.skills ?? [])
    return resources
  }

  function mergeResources(...items: ResourceSpec[]) {
    const result = RuntimeResourceResolver.emptyResources()
    for (const item of items) {
      result.builtinTools.enabledGroups = union(result.builtinTools.enabledGroups, item.builtinTools.enabledGroups)
      result.builtinTools.enabledTools = union(result.builtinTools.enabledTools, item.builtinTools.enabledTools)
      result.mcp.servers = union(result.mcp.servers, item.mcp.servers)
      result.mcp.tools = mergeMcpTools(result.mcp.tools, item.mcp.tools)
      result.skills.skills = union(result.skills.skills, item.skills.skills)
    }
    return result
  }

  function mergeMcpTools(
    current: Record<string, string[]> | undefined,
    next: Record<string, string[]> | undefined,
  ) {
    const result: Record<string, string[]> = { ...(current ?? {}) }
    for (const [server, tools] of Object.entries(next ?? {})) {
      result[server] = union(result[server], tools)
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  function normalizePage(page?: RuntimeContextEvents.RequestPagePayload) {
    return page ? RuntimeContextEvents.normalizePagePayload(page) : undefined
  }

  async function recommendedAgent(templateIds: string[], fallback: string) {
    const recommendation = RuntimePlatformAdapterRegistry.recommendAgent({ templateIds, fallback })
    if (!recommendation.requested) {
      return {
        value: fallback,
        audit: undefined,
      }
    }

    const agent = await Agent.get(recommendation.requested, {
      includeDeclaredOnly: true,
      includeRecommendable: true,
    })
    if (agent) {
      return {
        value: agent.name,
        audit: {
          requested: recommendation.requested,
          resolved: agent.name,
          accepted: true,
          platform: recommendation.platform,
        },
      }
    }

    return {
      value: fallback,
      audit: {
        requested: recommendation.requested,
        resolved: fallback,
        accepted: false,
        platform: recommendation.platform,
        reason: "not-found" as const,
      },
    }
  }

  function dedupeBlocks(blocks: ContextBlock[]) {
    const seen = new Set<string>()
    return blocks.filter((block) => {
      if (seen.has(block.id)) return false
      seen.add(block.id)
      return true
    })
  }

  function union(left: string[] | undefined, right: string[] | undefined) {
    return unique([...(left ?? []), ...(right ?? [])])
  }

  function unique(values: string[]) {
    const seen = new Set<string>()
    return values.filter((value) => {
      if (!value.trim() || seen.has(value)) return false
      seen.add(value)
      return true
    })
  }
}
