import z from "zod"
import { ulid } from "ulid"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { RuntimeContextPipeline } from "@/runtime/context/pipeline"
import type { ContextBlock } from "@/runtime/protocol/agent-run-spec"
import { RuntimePlatformAdapterRegistry } from "@/runtime/platform/adapter"

export namespace RuntimeContextEvents {
  export const RequestPagePayload = z
    .object({
      platform: z.string(),
      url: z.string().optional(),
      pageType: z.string().optional(),
      title: z.string().optional(),
      objectKey: z.string().optional(),
      selection: z.string().optional(),
      visibleSummary: z.string().optional(),
      raw: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
  export type RequestPagePayload = z.infer<typeof RequestPagePayload>

  export const Input = z
    .object({
      blocks: z.array(z.custom<ContextBlock>()).optional(),
      page: RequestPagePayload.optional(),
    })
    .optional()
  export type Input = z.infer<typeof Input>

  export type PageContextState = {
    pageKey: string
    digest: string
    selectionDigest?: string
    observedAt: number
  }

  export type ContextEvent = {
    id: string
    type: "page-enter" | "page-update" | "selection-update"
    pageKey?: string
    digest: string
    selectionDigest?: string
    observedAt: number
    source: string
    summary: string
    blocks: ContextBlock[]
    audit?: RuntimePlatformAdapterRegistry.PlatformSkipAudit[]
  }

  export type PreparedPageEvent = {
    event?: ContextEvent
    state: PageContextState
    deduped: boolean
  }

  export async function preparePageEvent(input: {
    sessionID: string
    projectID?: string
    page?: RequestPagePayload
  }): Promise<PreparedPageEvent | undefined> {
    if (!input.page) return undefined
    const page = normalizePagePayload(input.page)
    const observedAt = Date.now()
    const pageKey = pageKeyFor(page)
    const digest = RuntimeContextPipeline.digest(pageDigestPayload(page))
    const selectionDigest = page.selection ? RuntimeContextPipeline.textDigest(page.selection) : undefined
    const state: PageContextState = {
      pageKey,
      digest,
      selectionDigest,
      observedAt,
    }
    const previous = await readState(input)
    const blocks = blocksFromPagePayload(page, observedAt)
    const skippedPlatforms = RuntimePlatformAdapterRegistry.disabledAudits({ page })
    const type = eventType(previous, state)
    if (!type) {
      return {
        state,
        deduped: true,
      }
    }
    return {
      state,
      deduped: false,
      event: {
        id: ulid(),
        type,
        pageKey,
        digest,
        selectionDigest,
        observedAt,
        source: sourceFor(page, skippedPlatforms),
        summary: summaryFor(page, type, skippedPlatforms),
        blocks: type === "selection-update" ? blocks.filter((block) => block.id.includes("selection")) : blocks,
        audit: skippedPlatforms.length > 0 ? skippedPlatforms : undefined,
      },
    }
  }

  export async function commitPageEvent(input: {
    sessionID: string
    projectID?: string
    prepared: PreparedPageEvent
  }) {
    const projectID = input.projectID ?? Instance.project.id
    if (input.prepared.event) {
      await Storage.write(["context_event", projectID, input.sessionID, input.prepared.event.id], input.prepared.event)
    }
    await Storage.write(["context_state", projectID, input.sessionID], input.prepared.state)
  }

  export async function readState(input: { sessionID: string; projectID?: string }) {
    const projectID = input.projectID ?? Instance.project.id
    return Storage.read<PageContextState>(["context_state", projectID, input.sessionID]).catch((error) => {
      if (Storage.NotFoundError.isInstance(error) || Storage.CorruptedError.isInstance(error)) return undefined
      throw error
    })
  }

  export async function list(input: { sessionID: string; projectID?: string; limit?: number }) {
    const projectID = input.projectID ?? Instance.project.id
    const keys = await Storage.list(["context_event", projectID, input.sessionID])
    const events: ContextEvent[] = []
    for (const key of keys) {
      const event = await Storage.read<ContextEvent>(key).catch((error) => {
        if (Storage.NotFoundError.isInstance(error) || Storage.CorruptedError.isInstance(error)) return undefined
        throw error
      })
      if (event) events.push(event)
    }
    events.sort((a, b) => a.observedAt - b.observedAt)
    return input.limit ? events.slice(-input.limit) : events
  }

  export async function removeAll(input: { sessionID: string; projectID?: string }) {
    const projectID = input.projectID ?? Instance.project.id
    for (const key of await Storage.list(["context_event", projectID, input.sessionID])) {
      await Storage.remove(key)
    }
    await Storage.remove(["context_state", projectID, input.sessionID])
  }

  export function blocksFromEvents(events: ContextEvent[]): ContextBlock[] {
    return events.map((event) =>
      RuntimeContextPipeline.textBlock({
        id: `page:event:${event.id}`,
        layer: "page",
        source: event.source,
        content: renderEvent(event),
        lifecycle: "active",
        visibility: "developer-toggle",
        priority: 40,
        mergeKey: event.pageKey,
        observedAt: event.observedAt,
      }),
    )
  }

  export function blocksFromPagePayload(page: RequestPagePayload, observedAt = Date.now()): ContextBlock[] {
    const adapted = normalizePagePayload(page)
    const adapterBlocks = RuntimePlatformAdapterRegistry.blocksFromPage(adapted, observedAt)
    if (adapterBlocks) return adapterBlocks
    const skippedPlatforms = RuntimePlatformAdapterRegistry.disabledAudits({ page: adapted })
    const source = sourceFor(adapted, skippedPlatforms)

    const blocks: ContextBlock[] = [
      RuntimeContextPipeline.textBlock({
        id: `platform:${adapted.platform}`,
        layer: "platform",
        source,
        content: renderPage(adapted, skippedPlatforms),
        lifecycle: "turn",
        visibility: "developer-toggle",
        priority: 60,
        mergeKey: pageKeyFor(adapted),
        observedAt,
      }),
    ]
    if (adapted.selection?.trim()) {
      blocks.push(
        RuntimeContextPipeline.textBlock({
          id: `page:selection:${RuntimeContextPipeline.textDigest(adapted.selection).slice(0, 12)}`,
          layer: "page",
          source: skippedPlatforms.length > 0 ? `${source}.selection` : `page-context.${adapted.platform}.selection`,
          content: `Current page selection:\n${adapted.selection.trim()}`,
          lifecycle: "turn",
          visibility: "developer-toggle",
          priority: 55,
          mergeKey: `${pageKeyFor(adapted)}:selection`,
          observedAt,
        }),
      )
    }
    return blocks
  }

  export function normalizePagePayload(page: RequestPagePayload): RequestPagePayload {
    return RuntimePlatformAdapterRegistry.normalizePage(page) as RequestPagePayload
  }

  function eventType(previous: PageContextState | undefined, next: PageContextState): ContextEvent["type"] | undefined {
    if (!previous || previous.pageKey !== next.pageKey) return "page-enter"
    if (previous.digest !== next.digest) return "page-update"
    if (previous.selectionDigest !== next.selectionDigest) return "selection-update"
    return undefined
  }

  function pageKeyFor(page: RequestPagePayload) {
    return [page.platform, page.pageType || "page", page.objectKey || page.url || page.title || "unknown"].join(":")
  }

  function pageDigestPayload(page: RequestPagePayload) {
    return {
      platform: page.platform,
      url: page.url,
      pageType: page.pageType,
      title: page.title,
      objectKey: page.objectKey,
      visibleSummary: page.visibleSummary,
      raw: page.raw,
    }
  }

  function sourceFor(page: RequestPagePayload, audit: RuntimePlatformAdapterRegistry.PlatformSkipAudit[]) {
    return audit.length > 0
      ? `page-context.${page.platform}.platform-disabled-by-current-config`
      : `page-context.${page.platform}`
  }

  function renderPage(page: RequestPagePayload, audit: RuntimePlatformAdapterRegistry.PlatformSkipAudit[] = []) {
    return [
      `Platform: ${page.platform}`,
      ...audit.map((item) => `Platform adapter skipped: ${item.reason}. ${item.message}`),
      page.pageType ? `Page type: ${page.pageType}` : undefined,
      page.title ? `Title: ${page.title}` : undefined,
      page.url ? `URL: ${page.url}` : undefined,
      page.objectKey ? `Object key: ${page.objectKey}` : undefined,
      page.visibleSummary ? `Visible summary:\n${page.visibleSummary}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  }

  function renderEvent(event: ContextEvent) {
    return [
      `Context event: ${event.type}`,
      event.pageKey ? `Page key: ${event.pageKey}` : undefined,
      `Observed at: ${new Date(event.observedAt).toISOString()}`,
      ...(event.audit ?? []).map((item) => `Platform adapter skipped: ${item.reason}. ${item.message}`),
      event.summary,
    ]
      .filter(Boolean)
      .join("\n")
  }

  function summaryFor(
    page: RequestPagePayload,
    type: ContextEvent["type"],
    audit: RuntimePlatformAdapterRegistry.PlatformSkipAudit[] = [],
  ) {
    if (audit.length > 0) {
      const target = page.title || page.objectKey || page.url || page.platform
      return `Skipped platform-specific context for ${target}: ${audit[0]?.reason}.`
    }
    if (type === "selection-update") {
      return page.selection?.trim() ? `Selection changed on ${page.title ?? page.url ?? page.objectKey ?? page.platform}.` : "Selection cleared."
    }
    const target = page.title || page.objectKey || page.url || page.platform
    const summary = page.visibleSummary ? ` ${page.visibleSummary}` : ""
    return `${type === "page-enter" ? "Entered" : "Updated"} ${target}.${summary}`.trim()
  }
}
