import type { ContextBlock, ResourceSpec } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimePlatformAdapterRegistry {
  export type PagePayload = {
    platform: string
    url?: string
    pageType?: string
    title?: string
    objectKey?: string
    selection?: string
    visibleSummary?: string
    raw?: Record<string, unknown>
  }

  export type TemplateInput = {
    entry?: {
      source?: string
      platform?: string
      mode?: string
      templateIds?: string[]
    }
    page?: PagePayload
  }

  export type PlatformAdapter = {
    id: string
    matchPage?: (page: PagePayload) => boolean
    normalizePage?: (page: PagePayload) => PagePayload | undefined
    blocksFromPage?: (page: PagePayload, observedAt: number) => ContextBlock[] | undefined
    inferTemplateIds?: (input: TemplateInput) => string[]
    templateContextBlocks?: (input: { templateIds: string[]; page?: PagePayload }) => ContextBlock[]
    resourceContributions?: (input: { templateIds: string[] }) => ResourceSpec | undefined
    recommendedAgent?: (input: { templateIds: string[]; fallback: string }) => string | undefined
  }

  export type DisabledPlatform = {
    id: string
    templateIds?: string[]
    reason?: "platform-disabled-by-current-config"
    message?: string
  }

  export type PlatformSkipAudit = {
    platform: string
    reason: "platform-disabled-by-current-config"
    message: string
    templateIds: string[]
    matchedTemplateIds: string[]
  }

  const adapters = new Map<string, PlatformAdapter>()
  const disabled = new Map<string, DisabledPlatform>()

  export function register(adapter: PlatformAdapter) {
    disabled.delete(adapter.id)
    adapters.set(adapter.id, adapter)
  }

  export function unregister(id: string) {
    adapters.delete(id)
    disabled.delete(id)
  }

  export function markDisabled(input: DisabledPlatform) {
    adapters.delete(input.id)
    disabled.set(input.id, {
      ...input,
      reason: input.reason ?? "platform-disabled-by-current-config",
      templateIds: unique(input.templateIds ?? []),
      message: input.message ?? `Platform "${input.id}" is disabled by the current configuration.`,
    })
  }

  export function unmarkDisabled(id: string) {
    disabled.delete(id)
  }

  export function clearForTesting() {
    adapters.clear()
    disabled.clear()
  }

  export function list() {
    return Array.from(adapters.values())
  }

  export function listDisabled() {
    return Array.from(disabled.values()).map((item) => ({ ...item, templateIds: [...(item.templateIds ?? [])] }))
  }

  export function isDisabled(id: string) {
    return disabled.has(id)
  }

  export function normalizePage(page: PagePayload): PagePayload {
    if (disabled.has(page.platform)) return page
    for (const adapter of adapters.values()) {
      if (!adapter.matchPage?.(page)) continue
      const normalized = adapter.normalizePage?.(page)
      if (normalized) return normalized
    }
    return page
  }

  export function blocksFromPage(page: PagePayload, observedAt: number): ContextBlock[] | undefined {
    if (disabled.has(page.platform)) return undefined
    for (const adapter of adapters.values()) {
      if (!adapter.matchPage?.(page)) continue
      const blocks = adapter.blocksFromPage?.(page, observedAt)
      if (blocks?.length) return blocks
    }
    return undefined
  }

  export function inferTemplateIds(input: TemplateInput): string[] {
    if (input.page && disabled.has(input.page.platform)) return []
    return unique(Array.from(adapters.values()).flatMap((adapter) => adapter.inferTemplateIds?.(input) ?? []))
  }

  export function templateContextBlocks(input: { templateIds: string[]; page?: PagePayload }): ContextBlock[] {
    const templateIds = activeTemplateIds(input.templateIds)
    return Array.from(adapters.values()).flatMap((adapter) => adapter.templateContextBlocks?.({ ...input, templateIds }) ?? [])
  }

  export function resourceContributions(input: { templateIds: string[] }): ResourceSpec[] {
    const templateIds = activeTemplateIds(input.templateIds)
    return Array.from(adapters.values()).flatMap((adapter) => {
      const resources = adapter.resourceContributions?.({ ...input, templateIds })
      return resources ? [resources] : []
    })
  }

  export function recommendAgent(input: { templateIds: string[]; fallback: string }): {
    requested?: string
    fallback: string
    platform?: string
  } {
    const templateIds = activeTemplateIds(input.templateIds)
    for (const adapter of adapters.values()) {
      const recommended = adapter.recommendedAgent?.({ ...input, templateIds })
      if (recommended) {
        return {
          requested: recommended,
          fallback: input.fallback,
          platform: adapter.id,
        }
      }
    }
    return {
      fallback: input.fallback,
    }
  }

  export function recommendedAgent(input: { templateIds: string[]; fallback: string }): string {
    return recommendAgent(input).requested ?? input.fallback
  }

  export function activeTemplateIds(templateIds: string[]) {
    return templateIds.filter((templateId) => !disabledPlatformForTemplate(templateId))
  }

  export function disabledAudits(input: { page?: PagePayload; templateIds?: string[] }): PlatformSkipAudit[] {
    const templateIds = input.templateIds ?? []
    const audits: PlatformSkipAudit[] = []
    const matched = new Set<string>()

    for (const templateId of templateIds) {
      const item = disabledPlatformForTemplate(templateId)
      if (!item) continue
      matched.add(item.id)
    }

    if (input.page && disabled.has(input.page.platform)) {
      matched.add(input.page.platform)
    }

    for (const platform of matched) {
      const item = disabled.get(platform)
      if (!item) continue
      audits.push({
        platform,
        reason: item.reason ?? "platform-disabled-by-current-config",
        message: item.message ?? `Platform "${platform}" is disabled by the current configuration.`,
        templateIds: [...(item.templateIds ?? [])],
        matchedTemplateIds: templateIds.filter((templateId) => templateBelongsToDisabledPlatform(templateId, item)),
      })
    }

    return audits
  }

  function disabledPlatformForTemplate(templateId: string) {
    for (const item of disabled.values()) {
      if (templateBelongsToDisabledPlatform(templateId, item)) return item
    }
    return undefined
  }

  function templateBelongsToDisabledPlatform(templateId: string, item: DisabledPlatform) {
    if (item.templateIds?.includes(templateId)) return true
    return templateId.startsWith(`${item.id}-`)
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
