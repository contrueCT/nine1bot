import type { FeishuBrand, FeishuObjType, FeishuRoute, FeishuUrlInfo, KnownFeishuPageType, PageContextPayload } from './types'

export function parseFeishuUrl(input?: string): FeishuUrlInfo | undefined {
  if (!input) return undefined

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }

  if (!isLikelyFeishuHost(url.hostname)) return undefined

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const host = url.hostname
  const brand = brandForHost(host)
  const tenant = tenantForHost(host)

  if (parts[0] === 'docx' && parts[1]) {
    return routeInfo({ host, brand, tenant, route: 'docx', token: parts[1], objType: 'docx', pageType: 'feishu-docx' })
  }

  if (parts[0] === 'wiki' && parts[1]) {
    return routeInfo({ host, brand, tenant, route: 'wiki', token: parts[1], objType: 'wiki', pageType: 'feishu-wiki' })
  }

  if (parts[0] === 'sheets' && parts[1]) {
    return routeInfo({ host, brand, tenant, route: 'sheets', token: parts[1], objType: 'sheet', pageType: 'feishu-sheet' })
  }

  if (parts[0] === 'base' && parts[1]) {
    const tableId = stringValue(url.searchParams.get('table'))
    const viewId = stringValue(url.searchParams.get('view'))
    const query = whitelistQuery({ table: tableId, view: viewId })
    return routeInfo({
      host,
      brand,
      tenant,
      route: 'base',
      token: parts[1],
      objType: 'bitable',
      pageType: 'feishu-bitable',
      tableId,
      viewId,
      query,
    })
  }

  if (parts[0] === 'drive' && parts[1] === 'folder' && parts[2]) {
    return routeInfo({ host, brand, tenant, route: 'drive/folder', token: parts[2], objType: 'folder', pageType: 'feishu-folder' })
  }

  if (parts[0] === 'slides' && parts[1]) {
    return routeInfo({ host, brand, tenant, route: 'slides', token: parts[1], objType: 'slides', pageType: 'feishu-slides' })
  }

  const pathKey = parts.length ? parts.join('/') : 'root'
  return {
    host,
    brand,
    tenant,
    pageType: 'feishu-unknown',
    objectKey: `feishu:unknown:${host}:${pathKey}`,
    route: 'unknown',
    objType: 'unknown',
  }
}

export function buildFeishuPageContextPayload(input: {
  url: string
  title: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}): PageContextPayload {
  const feishu = parseFeishuUrl(input.url)
  if (!feishu) {
    return {
      platform: 'generic-browser',
      url: input.url,
      title: input.title,
      selection: trimText(input.selection, 4000),
      visibleSummary: trimText(input.visibleSummary, 2000),
      raw: input.raw,
    }
  }

  return {
    platform: 'feishu',
    url: input.url,
    title: input.title,
    pageType: feishu.pageType,
    objectKey: feishu.objectKey,
    selection: trimText(input.selection, 4000),
    visibleSummary: trimText(input.visibleSummary, 2000),
    raw: {
      ...(input.raw ?? {}),
      feishu: {
        ...(asRecord(input.raw?.feishu) ?? {}),
        ...rawFeishu(feishu),
      },
    },
  }
}

export function normalizeFeishuPagePayload(page: PageContextPayload): PageContextPayload | undefined {
  const parsed = parseFeishuUrl(page.url)
  if (!parsed && page.platform !== 'feishu') return undefined
  const feishu = parsed ?? feishuInfoFromRaw(page)
  if (!feishu) return undefined

  return {
    ...page,
    platform: 'feishu',
    pageType: feishu.pageType,
    objectKey: feishu.objectKey,
    raw: {
      ...(page.raw ?? {}),
      feishu: {
        ...(asRecord(page.raw?.feishu) ?? {}),
        ...rawFeishu(feishu),
      },
    },
  }
}

export function feishuTemplateIdsForPage(page?: Pick<PageContextPayload, 'platform' | 'pageType' | 'url' | 'raw'>): string[] {
  const normalized = page ? normalizeFeishuPagePayload(page as PageContextPayload) : undefined
  if (!normalized) return []
  const ids = ['browser-feishu']
  if (normalized.pageType?.startsWith('feishu-') && normalized.pageType !== 'browser-feishu') ids.push(normalized.pageType)
  return ids
}

export function isFeishuPagePayload(page?: Pick<PageContextPayload, 'platform' | 'url'>): boolean {
  return Boolean(page && (page.platform === 'feishu' || parseFeishuUrl(page.url)))
}

export function trimText(input: string | undefined, maxLength: number): string | undefined {
  const normalized = input?.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized
}

export function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function routeInfo(input: {
  host: string
  brand: FeishuBrand
  tenant?: string
  route: FeishuRoute
  token: string
  objType: FeishuObjType
  pageType: KnownFeishuPageType
  tableId?: string
  viewId?: string
  query?: Record<string, string>
}): FeishuUrlInfo {
  return {
    ...input,
    objectKey: `feishu:${input.objType}:${input.token}`,
  }
}

function rawFeishu(info: FeishuUrlInfo): Record<string, unknown> {
  return dropUndefined({
    host: info.host,
    brand: info.brand,
    tenant: info.tenant,
    route: info.route,
    token: info.token,
    objType: info.objType,
    tableId: info.tableId,
    viewId: info.viewId,
    query: info.query,
  })
}

function feishuInfoFromRaw(page: PageContextPayload): FeishuUrlInfo | undefined {
  const raw = asRecord(page.raw?.feishu)
  const host = stringValue(raw?.host)
  const brand = brandValue(raw?.brand) ?? (host ? brandForHost(host) : undefined)
  const route = routeValue(raw?.route)
  const objType = objTypeValue(raw?.objType)
  if (!host || !brand || !route || !objType) return undefined

  const token = stringValue(raw?.token)
  const pageType = pageTypeFor(route, objType, page.pageType)
  const objectKey = page.objectKey || (token ? `feishu:${objType}:${token}` : `feishu:unknown:${host}:${route}`)
  const tableId = stringValue(raw?.tableId)
  const viewId = stringValue(raw?.viewId)
  const query = whitelistQuery({ table: tableId, view: viewId })

  return {
    host,
    brand,
    tenant: stringValue(raw?.tenant),
    pageType,
    objectKey,
    route,
    token,
    objType,
    tableId,
    viewId,
    query,
  }
}

function pageTypeFor(route: FeishuRoute, objType: FeishuObjType, existing?: string): KnownFeishuPageType {
  if (existing?.startsWith('feishu-')) return existing as KnownFeishuPageType
  if (route === 'docx' || objType === 'docx') return 'feishu-docx'
  if (route === 'wiki' || objType === 'wiki') return 'feishu-wiki'
  if (route === 'sheets' || objType === 'sheet') return 'feishu-sheet'
  if (route === 'base' || objType === 'bitable') return 'feishu-bitable'
  if (route === 'drive/folder' || objType === 'folder') return 'feishu-folder'
  if (route === 'slides' || objType === 'slides') return 'feishu-slides'
  return 'feishu-unknown'
}

function isLikelyFeishuHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'feishu.cn'
    || normalized.endsWith('.feishu.cn')
    || normalized === 'larksuite.com'
    || normalized.endsWith('.larksuite.com')
}

function brandForHost(hostname: string): FeishuBrand {
  return hostname.toLowerCase().includes('larksuite') ? 'lark' : 'feishu'
}

function tenantForHost(hostname: string): string | undefined {
  const normalized = hostname.toLowerCase()
  const parts = normalized.split('.')
  if (parts.length <= 2) return undefined
  const first = parts[0]
  return first && first !== 'www' ? first : undefined
}

function whitelistQuery(input: Record<string, string | undefined>): Record<string, string> | undefined {
  const query = dropUndefined(input) as Record<string, string>
  return Object.keys(query).length ? query : undefined
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function brandValue(input: unknown): FeishuBrand | undefined {
  return input === 'feishu' || input === 'lark' ? input : undefined
}

function routeValue(input: unknown): FeishuRoute | undefined {
  return input === 'docx'
    || input === 'wiki'
    || input === 'sheets'
    || input === 'base'
    || input === 'drive/folder'
    || input === 'slides'
    || input === 'unknown'
    ? input
    : undefined
}

function objTypeValue(input: unknown): FeishuObjType | undefined {
  return input === 'docx'
    || input === 'wiki'
    || input === 'sheet'
    || input === 'bitable'
    || input === 'folder'
    || input === 'slides'
    || input === 'unknown'
    ? input
    : undefined
}
