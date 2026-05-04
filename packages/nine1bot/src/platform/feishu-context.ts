import {
  enrichFeishuPageContext,
  type FeishuContextEnrichmentSummary,
  type FeishuCliRunner,
} from '@nine1bot/platform-feishu/node'
import { normalizeFeishuPagePayload } from '@nine1bot/platform-feishu/runtime'
import { getBuiltinPlatformManager } from './builtin'
import type { RuntimeControllerProtocol } from '../../../../opencode/packages/opencode/src/runtime/controller/protocol'
import type { PlatformPagePayload } from '@nine1bot/platform-protocol'

export type FeishuControllerMessageContextResult = {
  body: RuntimeControllerProtocol.MessageSendRequest
  contextEnrichment?: FeishuContextEnrichmentSummary
}

export type FeishuControllerMessageContextOptions = {
  env?: Record<string, string | undefined>
  runner?: FeishuCliRunner
  cacheScope?: string
  cacheTtlMs?: number
}

const DEFAULT_ENRICHMENT_CACHE_TTL_MS = 30_000
type CachedFeishuEnrichment = {
  page: PlatformPagePayload
  blocks: unknown[]
  contextEnrichment?: FeishuContextEnrichmentSummary
}
const enrichmentCache = new Map<string, {
  expiresAt: number
  value: Promise<CachedFeishuEnrichment>
}>()

export async function prepareFeishuControllerMessageContext(
  body: RuntimeControllerProtocol.MessageSendRequest,
  options: FeishuControllerMessageContextOptions = {},
): Promise<FeishuControllerMessageContextResult> {
  if (!shouldEnhance(body.entry)) return { body }
  const page = body.context?.page as PlatformPagePayload | undefined
  if (!page || !isFeishuPage(page)) return { body }

  const manager = getBuiltinPlatformManager()
  const record = manager.get('feishu')
  if (!record?.enabled) return { body }
  if (!isFeishuMetadataSupportedPage(page)) return { body }

  const cacheKey = options.cacheScope ? cacheKeyFor(options.cacheScope, page, record.settings) : undefined
  if (cacheKey) {
    const cached = getCached(cacheKey)
    if (cached) return applyCachedResult(body, await cached)
  }

  const enrichment = enrichPage(page, record.settings, options)
  if (cacheKey) {
    setCached(cacheKey, enrichment, options.cacheTtlMs ?? DEFAULT_ENRICHMENT_CACHE_TTL_MS)
  }
  return applyCachedResult(body, await enrichment)
}

export function clearFeishuControllerMessageContextCacheForTesting() {
  enrichmentCache.clear()
}

async function enrichPage(
  page: PlatformPagePayload,
  settings: unknown,
  options: FeishuControllerMessageContextOptions,
): Promise<CachedFeishuEnrichment> {
  const result = await enrichFeishuPageContext({
    page,
    settings,
    env: options.env ?? process.env,
    runner: options.runner,
  })

  return {
    page: result.page,
    blocks: result.blocks,
    contextEnrichment: result.summary && result.summary.status !== 'not_applicable'
      ? result.summary
      : undefined,
  }
}

function getCached(cacheKey: string) {
  const cached = enrichmentCache.get(cacheKey)
  if (!cached) return undefined
  if (cached.expiresAt <= Date.now()) {
    enrichmentCache.delete(cacheKey)
    return undefined
  }
  return cached.value
}

function setCached(
  cacheKey: string,
  value: Promise<CachedFeishuEnrichment>,
  ttlMs: number,
) {
  const expiresAt = Date.now() + Math.max(0, ttlMs)
  enrichmentCache.set(cacheKey, { expiresAt, value })
  value.catch(() => {
    if (enrichmentCache.get(cacheKey)?.value === value) enrichmentCache.delete(cacheKey)
  })
}

function applyCachedResult(
  body: RuntimeControllerProtocol.MessageSendRequest,
  cached: CachedFeishuEnrichment,
): FeishuControllerMessageContextResult {
  return {
    body: {
      ...body,
      context: {
        ...(body.context ?? {}),
        page: cached.page,
        blocks: [
          ...((body.context?.blocks ?? []) as unknown[]),
          ...cached.blocks,
        ],
      },
    },
    contextEnrichment: cached.contextEnrichment,
  }
}

function cacheKeyFor(scope: string, page: PlatformPagePayload, settings: unknown) {
  const normalized = normalizeFeishuPagePayload(page)
  return JSON.stringify({
    scope,
    url: normalized?.url ?? page.url,
    objectKey: normalized?.objectKey ?? page.objectKey,
    pageType: normalized?.pageType ?? page.pageType,
    settings,
  })
}

function shouldEnhance(entry?: RuntimeControllerProtocol.Entry) {
  return entry?.source === 'browser-extension' || entry?.mode === 'browser-sidepanel'
}

function isFeishuPage(page: PlatformPagePayload) {
  return page.platform === 'feishu' || Boolean(page.url && isFeishuUrl(page.url))
}

function isFeishuMetadataSupportedPage(page: PlatformPagePayload) {
  const normalized = normalizeFeishuPagePayload(page)
  return normalized?.pageType === 'feishu-docx'
    || normalized?.pageType === 'feishu-wiki'
    || normalized?.pageType === 'feishu-sheet'
    || normalized?.pageType === 'feishu-bitable'
    || normalized?.pageType === 'feishu-folder'
    || normalized?.pageType === 'feishu-slides'
}

function isFeishuUrl(input: string) {
  try {
    const hostname = new URL(input).hostname.toLowerCase()
    return hostname === 'feishu.cn'
      || hostname.endsWith('.feishu.cn')
      || hostname === 'larksuite.com'
      || hostname.endsWith('.larksuite.com')
  } catch {
    return false
  }
}
