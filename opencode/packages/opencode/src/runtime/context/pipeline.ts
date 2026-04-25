import { createHash } from "crypto"
import type { ContextBlock, ContextSpec } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimeContextPipeline {
  export type ResolvedContextBlock = ContextBlock & {
    resolvedText: string
    tokenEstimate?: number
  }

  export type DroppedContextBlock = {
    id: string
    reason: "disabled" | "stale" | "budget" | "resolver-error"
    message?: string
  }

  export type CompiledContext = {
    blocks: ResolvedContextBlock[]
    rendered: string[]
    dropped: DroppedContextBlock[]
    audit: Array<{
      id: string
      layer: ContextBlock["layer"]
      lifecycle: ContextBlock["lifecycle"]
      source: string
      enabled: boolean
      rendered: boolean
      droppedReason?: DroppedContextBlock["reason"]
    }>
    tokenEstimate: number
  }

  const layerOrder: ContextBlock["layer"][] = [
    "base",
    "project",
    "user",
    "business",
    "platform",
    "page",
    "runtime",
    "turn",
    "loop",
  ]

  export function digest(input: unknown) {
    return createHash("sha256").update(stableStringify(input)).digest("hex")
  }

  export function textDigest(text: string) {
    return digest(text.trim())
  }

  export function textBlock(input: {
    id: string
    layer: ContextBlock["layer"]
    source: string
    content: string
    lifecycle?: ContextBlock["lifecycle"]
    visibility?: ContextBlock["visibility"]
    priority?: number
    mergeKey?: string
    observedAt?: number
  }): ContextBlock {
    return {
      id: input.id,
      layer: input.layer,
      source: input.source,
      enabled: true,
      priority: input.priority ?? 0,
      lifecycle: input.lifecycle ?? "session",
      visibility: input.visibility ?? "developer-toggle",
      mergeKey: input.mergeKey,
      digest: textDigest(input.content),
      observedAt: input.observedAt,
      content: input.content,
    }
  }

  export async function compile(input: {
    blocks: ContextBlock[]
    policy?: ContextSpec["policy"]
    now?: number
  }): Promise<CompiledContext> {
    const now = input.now ?? Date.now()
    const resolved: ResolvedContextBlock[] = []
    const dropped: DroppedContextBlock[] = []

    for (const block of input.blocks) {
      if (!block.enabled) {
        dropped.push({ id: block.id, reason: "disabled" })
        continue
      }
      if (block.staleAfterMs && block.observedAt && block.observedAt + block.staleAfterMs < now) {
        dropped.push({ id: block.id, reason: "stale" })
        continue
      }

      const text = resolveText(block)
      if (text === undefined) {
        dropped.push({
          id: block.id,
          reason: "resolver-error",
          message: "Unsupported context resolver in compatibility pipeline",
        })
        continue
      }
      if (!text.trim()) continue
      resolved.push({
        ...block,
        resolvedText: text,
        tokenEstimate: estimateTokens(text),
      })
    }

    const sorted = resolved.toSorted(compareBlocks)
    const rendered: ResolvedContextBlock[] = []
    const budgetDropped: DroppedContextBlock[] = []
    let tokenEstimate = 0
    const tokenBudget = input.policy?.tokenBudget
    for (const block of sorted) {
      const nextEstimate = tokenEstimate + (block.tokenEstimate ?? 0)
      if (
        tokenBudget &&
        nextEstimate > tokenBudget &&
        block.visibility !== "system-required" &&
        block.layer !== "base" &&
        block.layer !== "project" &&
        block.layer !== "user"
      ) {
        budgetDropped.push({ id: block.id, reason: "budget" })
        continue
      }
      rendered.push(block)
      tokenEstimate = nextEstimate
    }

    const allDropped = [...dropped, ...budgetDropped]
    const droppedByID = new Map(allDropped.map((item) => [item.id, item.reason]))
    return {
      blocks: rendered,
      rendered: rendered.map(renderBlock),
      dropped: allDropped,
      audit: [
        ...input.blocks.map((block) => ({
          id: block.id,
          layer: block.layer,
          lifecycle: block.lifecycle,
          source: block.source,
          enabled: block.enabled,
          rendered: rendered.some((item) => item.id === block.id),
          droppedReason: droppedByID.get(block.id),
        })),
      ],
      tokenEstimate,
    }
  }

  function resolveText(block: ContextBlock) {
    if (typeof block.content === "string") return block.content
    if (block.content.resolver === "static-text") {
      const text = block.content.params?.["text"]
      return typeof text === "string" ? text : undefined
    }
    return undefined
  }

  function renderBlock(block: ResolvedContextBlock) {
    return [
      `<context_block id="${escapeAttribute(block.id)}" layer="${block.layer}" source="${escapeAttribute(block.source)}">`,
      block.resolvedText.trim(),
      "</context_block>",
    ].join("\n")
  }

  function compareBlocks(a: ContextBlock, b: ContextBlock) {
    const layer = layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer)
    if (layer !== 0) return layer
    const visibility = visibilityRank(a.visibility) - visibilityRank(b.visibility)
    if (visibility !== 0) return visibility
    const priority = b.priority - a.priority
    if (priority !== 0) return priority
    return a.id.localeCompare(b.id)
  }

  function visibilityRank(visibility: ContextBlock["visibility"]) {
    if (visibility === "system-required") return 0
    if (visibility === "developer-toggle") return 1
    return 2
  }

  function estimateTokens(text: string) {
    return Math.ceil(text.length / 4)
  }

  function stableStringify(input: unknown): string {
    if (input === null || typeof input !== "object") return JSON.stringify(input)
    if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`
    const record = input as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }

  function escapeAttribute(value: string) {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
  }
}
