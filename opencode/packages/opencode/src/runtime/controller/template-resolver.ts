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
    resourceMergeMode: "additive-only"
    contextBlocks: Array<{ id: string; source: string; enabled: boolean }>
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

  export async function resolve(input: Input = {}): Promise<Resolved> {
    const requestedTemplateIds = normalizeTemplateIds(input.entry?.templateIds ?? [])
    const inferredTemplateIds = inferTemplateIds(input)
    const templateIds = normalizeTemplateIds([
      "default-user-template",
      ...(requestedTemplateIds.length > 0 ? requestedTemplateIds : inferredTemplateIds),
      ...inferredTemplateIds,
    ])
    const agent = await resolveAgent(input.sessionChoice?.agent)
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
      resourceMergeMode: "additive-only",
      contextBlocks: contextBlocks.map((block) => ({
        id: block.id,
        source: block.source,
        enabled: block.enabled,
      })),
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
      recommendedAgent: recommendedAgent(templateIds, agent.name),
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
    const agent = await Agent.get(name)
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
    if (platform === "gitlab" || page?.platform === "gitlab") {
      ids.push("browser-gitlab")
      const pageType = normalizeTemplateId(page?.pageType)
      if (pageType && pageType.startsWith("gitlab-")) ids.push(pageType)
    }
    if (platform === "generic-browser") ids.push("browser-generic")
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
      if (templateId === "browser-gitlab") {
        blocks.push(
          RuntimeContextPipeline.textBlock({
            id: "template:browser-gitlab",
            layer: "platform",
            source: "template.browser-gitlab",
            content: "This session can use GitLab browser context. Treat GitLab repository, file, merge request, and issue page events as active work context.",
            lifecycle: "session",
            visibility: "developer-toggle",
            priority: 45,
          }),
        )
      }
      if (templateId.startsWith("gitlab-")) {
        blocks.push(
          RuntimeContextPipeline.textBlock({
            id: `template:${templateId}`,
            layer: "platform",
            source: `template.${templateId}`,
            content: renderGitLabTemplateContext(templateId, page),
            lifecycle: "session",
            visibility: "developer-toggle",
            priority: 42,
            mergeKey: page?.objectKey,
          }),
        )
      }
    }
    return dedupeBlocks(blocks)
  }

  function renderGitLabTemplateContext(templateId: string, page?: RuntimeContextEvents.RequestPagePayload) {
    return [
      `GitLab template: ${templateId}`,
      page?.title ? `Initial page title: ${page.title}` : undefined,
      page?.url ? `Initial page URL: ${page.url}` : undefined,
      page?.objectKey ? `Initial object key: ${page.objectKey}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
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
      if (templateId === "browser-gitlab" || templateId.startsWith("gitlab-")) {
        resources.builtinTools.enabledGroups = union(resources.builtinTools.enabledGroups, ["gitlab-context"])
      }
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

  function recommendedAgent(templateIds: string[], fallback: string) {
    if (templateIds.includes("gitlab-mr")) return fallback
    if (templateIds.includes("gitlab-issue")) return fallback
    return fallback
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
