import {
  asRecord,
  normalizeFeishuPagePayload,
} from './shared'
import {
  getFeishuAuthStatus,
  resolveFeishuCliPath,
  runFeishuCliJsonWithFile,
  sanitizeCliError,
  type FeishuCliRunner,
} from './cli'
import type { PageContextPayload, PlatformContextBlock } from './types'

export type FeishuContextEnrichmentStatus =
  | 'not_applicable'
  | 'visible_only'
  | 'loaded'
  | 'missing_cli'
  | 'need_config'
  | 'need_login'
  | 'permission_denied'
  | 'timeout'
  | 'error'

export type FeishuContextEnrichmentSummary = {
  platform: 'feishu'
  status: FeishuContextEnrichmentStatus
  message: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}

export type FeishuContextEnrichmentMode = 'auto' | 'visible-only' | 'disabled'

export type FeishuMetadata = {
  api: 'wiki.spaces.get_node' | 'drive.metas.batch_query'
  title?: string
  url?: string
  objType?: string
  objToken?: string
  objectKey?: string
  wikiToken?: string
  spaceId?: string
  owner?: string
  creator?: string
  createdAt?: string
  updatedAt?: string
  latestModifyTime?: string
  raw?: Record<string, unknown>
}

export type FeishuPageContextEnrichmentResult = {
  page: PageContextPayload
  blocks: PlatformContextBlock[]
  summary?: FeishuContextEnrichmentSummary
  metadata?: FeishuMetadata
}

export type FeishuPageContextEnrichmentInput = {
  page?: PageContextPayload
  settings?: unknown
  env?: Record<string, string | undefined>
  observedAt?: number
  runner?: FeishuCliRunner
}

type FeishuSettings = {
  cliPath?: string
  contextEnrichment: FeishuContextEnrichmentMode
  metadataTimeoutMs: number
}

const DEFAULT_METADATA_TIMEOUT_MS = 2_000

export async function enrichFeishuPageContext(
  input: FeishuPageContextEnrichmentInput,
): Promise<FeishuPageContextEnrichmentResult> {
  const page = input.page ? normalizeFeishuPagePayload(input.page) : undefined
  if (!page) {
    return {
      page: input.page ?? { platform: 'generic-browser' },
      blocks: [],
      summary: summary('not_applicable'),
    }
  }

  const settings = readSettings(input.settings)
  if (settings.contextEnrichment === 'disabled') {
    return {
      page,
      blocks: [],
      summary: summary('not_applicable'),
    }
  }

  if (settings.contextEnrichment === 'visible-only') {
    return {
      page: withEnrichmentStatus(page, 'visible_only'),
      blocks: [],
      summary: summary('visible_only'),
    }
  }

  const cliPath = resolveFeishuCliPath(settings.cliPath, input.env)
  if (!cliPath) {
    return failed(page, 'missing_cli', input.observedAt)
  }

  const auth = await getFeishuAuthStatus({
    cliPath,
    env: input.env,
    timeoutMs: settings.metadataTimeoutMs,
    runner: input.runner,
  })
  if (auth.result.timedOut) return failed(page, 'timeout', input.observedAt)
  if (auth.state === 'need_config') return failed(page, 'need_config', input.observedAt)
  if (auth.state === 'need_login') return failed(page, 'need_login', input.observedAt)
  if (auth.state !== 'authenticated') return failed(page, 'need_login', input.observedAt)

  const feishu = asRecord(page.raw?.feishu)
  const token = stringValue(feishu?.token)
  if (!token) return failed(page, 'error', input.observedAt, 'No Feishu token was found in the page URL.')

  const timeoutMs = settings.metadataTimeoutMs
  const result = await fetchMetadata({
    cliPath,
    token,
    page,
    env: input.env,
    timeoutMs,
    runner: input.runner,
  })

  if (result.status !== 'loaded') {
    return failed(page, result.status, input.observedAt, result.message)
  }

  const metadata = result.metadata
  const enrichedPage = withLoadedMetadata(page, metadata)
  return {
    page: enrichedPage,
    blocks: [metadataBlock(enrichedPage, metadata, input.observedAt ?? Date.now())],
    summary: summary('loaded', metadata.title),
    metadata,
  }
}

export function readFeishuContextEnrichmentSettings(settings: unknown): FeishuSettings {
  return readSettings(settings)
}

async function fetchMetadata(input: {
  cliPath: string
  token: string
  page: PageContextPayload
  env?: Record<string, string | undefined>
  timeoutMs: number
  runner?: FeishuCliRunner
}): Promise<
  | { status: 'loaded'; metadata: FeishuMetadata }
  | { status: Exclude<FeishuContextEnrichmentStatus, 'loaded' | 'not_applicable' | 'visible_only' | 'missing_cli' | 'need_config'>; message?: string }
> {
  const feishu = asRecord(input.page.raw?.feishu)
  if (input.page.pageType === 'feishu-wiki') {
    const result = await runFeishuCliJsonWithFile({
      cliPath: input.cliPath,
      args: ['wiki', 'spaces', 'get_node'],
      fileFlag: '--params',
      fileName: 'params.json',
      payload: { token: input.token },
      env: input.env,
      timeoutMs: input.timeoutMs,
      runner: input.runner,
    })
    if (result.timedOut) return { status: 'timeout' }
    const errorStatus = classifyApiFailure(result)
    if (errorStatus) return errorStatus
    const node = wikiNodeFrom(result.json)
    if (!node) return { status: 'error', message: 'Could not parse wiki node metadata.' }
    return {
      status: 'loaded',
      metadata: metadataFromWikiNode(node, input.token),
    }
  }

  const docType = driveDocTypeForPage(input.page.pageType, stringValue(feishu?.objType))
  if (!docType) return { status: 'error', message: 'This Feishu page type is not supported for metadata enrichment yet.' }

  const result = await runFeishuCliJsonWithFile({
    cliPath: input.cliPath,
    args: ['drive', 'metas', 'batch_query'],
    fileFlag: '--data',
    fileName: 'data.json',
    payload: {
      request_docs: [
        {
          doc_token: input.token,
          doc_type: docType,
        },
      ],
      with_url: true,
    },
    env: input.env,
    timeoutMs: input.timeoutMs,
    runner: input.runner,
  })
  if (result.timedOut) return { status: 'timeout' }
  const errorStatus = classifyApiFailure(result)
  if (errorStatus) return errorStatus
  const meta = driveMetaFrom(result.json)
  if (!meta) return { status: 'error', message: 'Could not parse drive metadata.' }
  return {
    status: 'loaded',
    metadata: metadataFromDriveMeta(meta, input.token, docType),
  }
}

function failed(
  page: PageContextPayload,
  status: Exclude<FeishuContextEnrichmentStatus, 'loaded' | 'not_applicable' | 'visible_only'>,
  observedAt = Date.now(),
  reason?: string,
): FeishuPageContextEnrichmentResult {
  const enrichedPage = withEnrichmentStatus(page, status)
  return {
    page: enrichedPage,
    blocks: [statusBlock(enrichedPage, status, observedAt, reason)],
    summary: summary(status, undefined, reason),
  }
}

function withLoadedMetadata(page: PageContextPayload, metadata: FeishuMetadata): PageContextPayload {
  return withFeishuRaw(page, {
    metadata: metadataRaw(metadata),
    enrichment: {
      status: 'loaded',
      source: 'lark-cli',
      api: metadata.api,
      resolvedObjType: metadata.objType,
      resolvedObjToken: metadata.objToken,
      resolvedObjectKey: metadata.objectKey,
      spaceId: metadata.spaceId,
      checkedAt: new Date().toISOString(),
    },
  })
}

function withEnrichmentStatus(page: PageContextPayload, status: FeishuContextEnrichmentStatus): PageContextPayload {
  return withFeishuRaw(page, {
    enrichment: {
      status,
      source: 'lark-cli',
      checkedAt: new Date().toISOString(),
    },
  })
}

function withFeishuRaw(page: PageContextPayload, patch: Record<string, unknown>): PageContextPayload {
  return {
    ...page,
    raw: {
      ...(page.raw ?? {}),
      feishu: {
        ...(asRecord(page.raw?.feishu) ?? {}),
        ...patch,
      },
    },
  }
}

function metadataBlock(page: PageContextPayload, metadata: FeishuMetadata, observedAt: number): PlatformContextBlock {
  return {
    id: 'page:feishu-metadata',
    layer: 'page',
    source: `page-context.feishu.metadata.${metadata.api}`,
    content: renderMetadata(metadata),
    lifecycle: 'turn',
    visibility: 'developer-toggle',
    enabled: true,
    priority: 72,
    mergeKey: page.objectKey,
    observedAt,
  }
}

function statusBlock(
  page: PageContextPayload,
  status: FeishuContextEnrichmentStatus,
  observedAt: number,
  reason?: string,
): PlatformContextBlock {
  return {
    id: 'page:feishu-metadata',
    layer: 'page',
    source: 'page-context.feishu.metadata.status',
    content: [
      `Feishu metadata: ${status}`,
      'Using visible browser page context only.',
      reason ? `Reason: ${reason}` : summary(status).message,
    ].join('\n'),
    lifecycle: 'turn',
    visibility: 'developer-toggle',
    enabled: true,
    priority: 56,
    mergeKey: page.objectKey,
    observedAt,
  }
}

function renderMetadata(metadata: FeishuMetadata) {
  return [
    'Feishu metadata: loaded',
    `Metadata API: ${metadata.api}`,
    metadata.title ? `Title: ${metadata.title}` : undefined,
    metadata.url ? `URL: ${metadata.url}` : undefined,
    metadata.objType ? `Object type: ${metadata.objType}` : undefined,
    metadata.objectKey ? `Object key: ${metadata.objectKey}` : undefined,
    metadata.spaceId ? `Wiki space: ${metadata.spaceId}` : undefined,
    metadata.owner ? `Owner: ${metadata.owner}` : undefined,
    metadata.creator ? `Creator: ${metadata.creator}` : undefined,
    metadata.createdAt ? `Created at: ${metadata.createdAt}` : undefined,
    metadata.updatedAt ? `Updated at: ${metadata.updatedAt}` : undefined,
    metadata.latestModifyTime ? `Latest modify time: ${metadata.latestModifyTime}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function summary(
  status: FeishuContextEnrichmentStatus,
  title?: string,
  reason?: string,
): FeishuContextEnrichmentSummary {
  if (status === 'loaded') {
    return {
      platform: 'feishu',
      status,
      message: title ? `Feishu metadata loaded: ${title}` : 'Feishu metadata loaded.',
      tone: 'success',
    }
  }
  const messages: Record<FeishuContextEnrichmentStatus, string> = {
    not_applicable: 'No Feishu page metadata was needed.',
    visible_only: 'Using visible Feishu page context only.',
    loaded: 'Feishu metadata loaded.',
    missing_cli: 'lark-cli was not found; using visible Feishu page context only.',
    need_config: 'lark-cli needs configuration before Feishu metadata can be loaded.',
    need_login: 'lark-cli needs Feishu login before metadata can be loaded.',
    permission_denied: 'Feishu metadata permission was denied; using visible page context only.',
    timeout: 'Feishu metadata lookup timed out; using visible page context only.',
    error: 'Feishu metadata lookup failed; using visible page context only.',
  }
  return {
    platform: 'feishu',
    status,
    message: reason ?? messages[status],
    tone: status === 'visible_only' || status === 'not_applicable' ? 'neutral' : 'warning',
  }
}

function classifyApiFailure(result: { exitCode: number | null; stdout: string; stderr: string; json?: unknown }) {
  const record = asRecord(result.json)
  const error = sanitizeCliError(record) ?? sanitizeCliError(parseMaybeJson(result.stderr))
  const code = stringValue(error?.code)
  const message = stringValue(error?.message) ?? stringValue(error?.msg)
  const output = `${result.stdout}\n${result.stderr}\n${message ?? ''}`.toLowerCase()
  if (result.exitCode !== 0 || error || isFailedEnvelope(record)) {
    if (isPermissionDenied(code, output)) {
      return { status: 'permission_denied' as const, message: message ?? 'Permission denied.' }
    }
    if (output.includes('login') || output.includes('unauthorized')) {
      return { status: 'need_login' as const, message: message ?? 'lark-cli login is required.' }
    }
    return { status: 'error' as const, message: message ?? 'lark-cli metadata request failed.' }
  }
  const failedItem = firstFailedItem(record)
  if (failedItem) {
    const failedCode = stringValue(failedItem.code)
    const failedMessage = stringValue(failedItem.msg) ?? stringValue(failedItem.message)
    if (isPermissionDenied(failedCode, failedMessage?.toLowerCase() ?? '')) {
      return { status: 'permission_denied' as const, message: failedMessage ?? 'Permission denied.' }
    }
    return { status: 'error' as const, message: failedMessage ?? 'lark-cli metadata request failed.' }
  }
  return undefined
}

function wikiNodeFrom(input: unknown): Record<string, unknown> | undefined {
  const root = asRecord(input)
  const data = asRecord(root?.data) ?? root
  return asRecord(data?.node) ?? asRecord(data?.item) ?? data
}

function driveMetaFrom(input: unknown): Record<string, unknown> | undefined {
  const root = asRecord(input)
  const data = asRecord(root?.data) ?? root
  const metas = Array.isArray(data?.metas)
    ? data.metas
    : Array.isArray(data?.docs)
      ? data.docs
      : Array.isArray(data?.items)
        ? data.items
        : undefined
  return asRecord(metas?.[0])
}

function metadataFromWikiNode(node: Record<string, unknown>, wikiToken: string): FeishuMetadata {
  const objType = stringValue(node.obj_type) ?? stringValue(node.objType)
  const objToken = stringValue(node.obj_token) ?? stringValue(node.objToken)
  return {
    api: 'wiki.spaces.get_node',
    title: stringValue(node.title),
    objType,
    objToken,
    objectKey: objType && objToken ? `feishu:${objType}:${objToken}` : undefined,
    wikiToken,
    spaceId: stringValue(node.space_id) ?? stringValue(node.spaceId),
    owner: personValue(node.owner) ?? personValue(node.node_creator) ?? personValue(node.creator),
    creator: personValue(node.node_creator) ?? personValue(node.creator),
    createdAt: timeValue(node.obj_create_time) ?? timeValue(node.create_time),
    updatedAt: timeValue(node.obj_edit_time) ?? timeValue(node.edit_time),
    raw: compactRecord({
      nodeToken: stringValue(node.node_token) ?? stringValue(node.nodeToken),
      objType,
      objToken,
      spaceId: stringValue(node.space_id) ?? stringValue(node.spaceId),
    }),
  }
}

function metadataFromDriveMeta(meta: Record<string, unknown>, token: string, docType: string): FeishuMetadata {
  const objType = stringValue(meta.doc_type) ?? stringValue(meta.docType) ?? docType
  const objToken = stringValue(meta.doc_token) ?? stringValue(meta.docToken) ?? token
  return {
    api: 'drive.metas.batch_query',
    title: stringValue(meta.title) ?? stringValue(meta.name),
    url: stringValue(meta.url),
    objType,
    objToken,
    objectKey: objType && objToken ? `feishu:${objType}:${objToken}` : undefined,
    owner: personValue(meta.owner) ?? stringValue(meta.owner_id) ?? stringValue(meta.ownerId),
    latestModifyTime: timeValue(meta.latest_modify_time) ?? timeValue(meta.latestModifyTime),
    raw: compactRecord({
      docType: objType,
      docToken: objToken,
    }),
  }
}

function metadataRaw(metadata: FeishuMetadata): Record<string, unknown> {
  return compactRecord({
    api: metadata.api,
    title: metadata.title,
    url: metadata.url,
    objType: metadata.objType,
    objToken: metadata.objToken,
    objectKey: metadata.objectKey,
    wikiToken: metadata.wikiToken,
    spaceId: metadata.spaceId,
    owner: metadata.owner,
    creator: metadata.creator,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    latestModifyTime: metadata.latestModifyTime,
  })
}

function driveDocTypeForPage(pageType?: string, objType?: string): string | undefined {
  if (pageType === 'feishu-docx' || objType === 'docx') return 'docx'
  if (pageType === 'feishu-sheet' || objType === 'sheet') return 'sheet'
  if (pageType === 'feishu-bitable' || objType === 'bitable') return 'bitable'
  if (pageType === 'feishu-slides' || objType === 'slides') return 'slides'
  if (pageType === 'feishu-folder' || objType === 'folder') return 'folder'
  return undefined
}

function readSettings(settings: unknown): FeishuSettings {
  const record = asRecord(settings)
  const contextEnrichment = record?.contextEnrichment === 'disabled'
    ? 'disabled'
    : record?.contextEnrichment === 'visible-only'
      ? 'visible-only'
      : 'auto'
  return {
    cliPath: stringValue(record?.cliPath),
    contextEnrichment,
    metadataTimeoutMs: clampNumber(numberValue(record?.metadataTimeoutMs) ?? DEFAULT_METADATA_TIMEOUT_MS, 500, 15_000),
  }
}

function firstFailedItem(record?: Record<string, unknown>) {
  const data = asRecord(record?.data)
  const failed = Array.isArray(data?.failed_list)
    ? data.failed_list
    : Array.isArray(data?.failedList)
      ? data.failedList
      : undefined
  return asRecord(failed?.[0])
}

function isFailedEnvelope(record?: Record<string, unknown>) {
  const code = record?.code
  if (typeof code === 'number') return code !== 0
  if (typeof code === 'string' && code !== '0') return true
  return record?.ok === false || record?.success === false
}

function isPermissionDenied(code: string | undefined, output: string) {
  return code === '99991663'
    || code === '99991664'
    || code === '970003'
    || output.includes('permission')
    || output.includes('forbidden')
    || output.includes('scope')
    || output.includes('no permission')
}

function parseMaybeJson(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function personValue(input: unknown): string | undefined {
  const record = asRecord(input)
  return stringValue(record?.name)
    ?? stringValue(record?.en_name)
    ?? stringValue(record?.user_id)
    ?? stringValue(record?.open_id)
    ?? stringValue(input)
}

function timeValue(input: unknown): string | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const ms = input > 10_000_000_000 ? input : input * 1000
    return new Date(ms).toISOString()
  }
  if (typeof input === 'string' && input.trim()) {
    if (/^\d+$/.test(input.trim())) return timeValue(Number(input))
    return input.trim()
  }
  return undefined
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function numberValue(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && input.trim() && Number.isFinite(Number(input))) return Number(input)
  return undefined
}

function clampNumber(input: number, min: number, max: number) {
  return Math.min(max, Math.max(min, input))
}
