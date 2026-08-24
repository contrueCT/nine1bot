import type { GitLabUrlInfo, PageContextPayload } from './types'

export type GitLabHostPolicy = {
  allowedHosts: readonly string[]
  allowedHostsInvalid?: boolean
}

export function parseGitLabUrl(input?: string, hostPolicy?: GitLabHostPolicy): GitLabUrlInfo | undefined {
  if (!input) return undefined

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || !isGitLabHostAllowed(url.host, hostPolicy)
  ) return undefined

  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
  if (parts.length === 0) return undefined

  const dashIndex = parts.indexOf('-')
  const projectParts = dashIndex === -1 ? parts : parts.slice(0, dashIndex)
  const projectPath = projectParts.join('/')
  if (!projectPath) return undefined

  if (dashIndex === -1) {
    return {
      host: url.host,
      projectPath,
      pageType: 'gitlab-repo',
      objectKey: objectKey(url.host, projectPath, 'repo'),
      route: 'repo',
    }
  }

  const route = parts[dashIndex + 1]
  const rest = parts.slice(dashIndex + 2)

  if (route === 'merge_requests' && rest[0]) {
    return {
      host: url.host,
      projectPath,
      pageType: 'gitlab-mr',
      objectKey: objectKey(url.host, projectPath, 'merge_request', rest[0]),
      route: 'merge_request',
      iid: rest[0],
    }
  }

  if (route === 'issues' && rest[0]) {
    return {
      host: url.host,
      projectPath,
      pageType: 'gitlab-issue',
      objectKey: objectKey(url.host, projectPath, 'issue', rest[0]),
      route: 'issue',
      iid: rest[0],
    }
  }

  if (route === 'commit' && rest[0]) {
    return {
      host: url.host,
      projectPath,
      pageType: 'gitlab-commit',
      objectKey: objectKey(url.host, projectPath, 'commit', rest[0]),
      route: 'commit',
      sha: rest[0],
    }
  }

  if (route === 'blob' && rest[0]) {
    const ref = rest[0]
    const filePath = rest.slice(1).join('/')
    return {
      host: url.host,
      projectPath,
      pageType: 'gitlab-file',
      objectKey: objectKey(url.host, projectPath, 'file', ref, filePath),
      route: 'blob',
      ref,
      filePath,
    }
  }

  if (route === 'tree') {
    const ref = rest[0]
    const treePath = rest.slice(1).join('/')
    return {
      host: url.host,
      projectPath,
      pageType: 'gitlab-repo',
      objectKey: objectKey(url.host, projectPath, 'tree', ref, treePath),
      route: 'tree',
      ref,
      treePath,
    }
  }

  return {
    host: url.host,
    projectPath,
    pageType: 'gitlab-repo',
    objectKey: objectKey(url.host, projectPath, 'repo'),
    route: 'repo',
  }
}

export function buildGitLabPageContextPayload(input: {
  url: string
  title: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}, hostPolicy?: GitLabHostPolicy): PageContextPayload {
  const gitlab = parseGitLabUrl(input.url, hostPolicy)
  if (!gitlab) {
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
    platform: 'gitlab',
    url: input.url,
    title: input.title,
    pageType: gitlab.pageType,
    objectKey: gitlab.objectKey,
    selection: trimText(input.selection, 4000),
    visibleSummary: trimText(input.visibleSummary, 2000),
    raw: {
      ...(input.raw ?? {}),
      gitlab: {
        ...(asRecord(input.raw?.gitlab) ?? {}),
        host: gitlab.host,
        projectPath: gitlab.projectPath,
        route: gitlab.route,
        ref: gitlab.ref,
        filePath: gitlab.filePath,
        treePath: gitlab.treePath,
        iid: gitlab.iid,
        sha: gitlab.sha,
      },
    },
  }
}

export function normalizeGitLabPagePayload(
  page: PageContextPayload,
  hostPolicy?: GitLabHostPolicy,
): PageContextPayload | undefined {
  const parsed = parseGitLabUrl(page.url, hostPolicy)
  if (!parsed && page.platform !== 'gitlab') return undefined
  const gitlab = parsed ?? gitLabInfoFromRaw(page, hostPolicy)
  if (!gitlab) return undefined

  return {
    ...page,
    platform: 'gitlab',
    pageType: gitlab.pageType,
    objectKey: gitlab.objectKey,
    raw: {
      ...(page.raw ?? {}),
      gitlab: {
        ...(asRecord(page.raw?.gitlab) ?? {}),
        host: gitlab.host,
        projectPath: gitlab.projectPath,
        route: gitlab.route,
        ref: gitlab.ref,
        filePath: gitlab.filePath,
        treePath: gitlab.treePath,
        iid: gitlab.iid,
        sha: gitlab.sha,
      },
    },
  }
}

export function gitLabTemplateIdsForPage(
  page?: Pick<PageContextPayload, 'platform' | 'pageType' | 'url'>,
  hostPolicy?: GitLabHostPolicy,
): string[] {
  const normalized = page ? normalizeGitLabPagePayload(page as PageContextPayload, hostPolicy) : undefined
  if (!normalized) return []
  const ids = ['browser-gitlab']
  if (normalized.pageType?.startsWith('gitlab-')) ids.push(normalized.pageType)
  return ids
}

export function isGitLabPagePayload(
  page?: Pick<PageContextPayload, 'platform' | 'url'>,
  hostPolicy?: GitLabHostPolicy,
): boolean {
  if (!page) return false
  if (parseGitLabUrl(page.url, hostPolicy)) return true
  return page.platform === 'gitlab' && isGitLabPageUrlAllowed(page.url, hostPolicy)
}

export function trimText(input: string | undefined, maxLength: number): string | undefined {
  const normalized = input?.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized
}

export function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function isLikelyGitLabHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'gitlab.com' || normalized.includes('gitlab')
}

function isGitLabHostAllowed(authority: string, hostPolicy?: GitLabHostPolicy) {
  if (!hostPolicy) return isLikelyGitLabHost(authority.split(':')[0] ?? authority)
  if (hostPolicy.allowedHostsInvalid) return false

  const normalizedAuthority = normalizeGitLabAuthority(authority)
  if (!normalizedAuthority) return false
  const allowedHosts = hostPolicy.allowedHosts.length > 0 ? hostPolicy.allowedHosts : ['gitlab.com']
  const normalizedAllowedHosts = allowedHosts.map(normalizeGitLabAuthority)
  if (normalizedAllowedHosts.some((host) => !host)) return false
  return normalizedAllowedHosts.includes(normalizedAuthority)
}

function isGitLabPageUrlAllowed(input: string | undefined, hostPolicy?: GitLabHostPolicy) {
  const authority = gitLabAuthorityFromUrl(input)
  return Boolean(authority && isGitLabHostAllowed(authority, hostPolicy))
}

function objectKey(host: string, projectPath: string, ...parts: Array<string | undefined>) {
  return [host, projectPath, ...parts.filter((part) => part && part.trim())].join(':')
}

function gitLabInfoFromRaw(page: PageContextPayload, hostPolicy?: GitLabHostPolicy): GitLabUrlInfo | undefined {
  const raw = asRecord(page.raw?.gitlab)
  const host = normalizeGitLabAuthority(stringValue(raw?.host))
  const projectPath = stringValue(raw?.projectPath)
  const route = stringValue(raw?.route)
  if (!host || !projectPath || !isGitLabHostAllowed(host, hostPolicy)) return undefined

  const pageAuthority = gitLabAuthorityFromUrl(page.url)
  if (pageAuthority && pageAuthority !== host) return undefined

  const pageType = page.pageType?.startsWith('gitlab-')
    ? page.pageType as GitLabUrlInfo['pageType']
    : route === 'merge_request'
      ? 'gitlab-mr'
      : route === 'issue'
        ? 'gitlab-issue'
        : route === 'commit'
          ? 'gitlab-commit'
          : route === 'blob'
            ? 'gitlab-file'
            : 'gitlab-repo'

  return {
    host,
    projectPath,
    pageType,
    objectKey: page.objectKey || objectKey(host, projectPath, route || 'repo', stringValue(raw?.iid) ?? stringValue(raw?.sha)),
    route: route === 'merge_request' || route === 'issue' || route === 'commit' || route === 'blob' || route === 'tree' ? route : 'repo',
    ref: stringValue(raw?.ref),
    filePath: stringValue(raw?.filePath),
    treePath: stringValue(raw?.treePath),
    iid: stringValue(raw?.iid),
    sha: stringValue(raw?.sha),
  }
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function normalizeGitLabAuthority(input?: string) {
  if (!input?.trim()) return undefined
  const value = input.trim()
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || !url.hostname
    ) return undefined
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}

function gitLabAuthorityFromUrl(input?: string) {
  if (!input) return undefined
  try {
    const url = new URL(input)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || !url.hostname
    ) return undefined
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}
