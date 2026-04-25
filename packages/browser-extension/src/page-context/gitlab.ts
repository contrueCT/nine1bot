export interface BrowserPageContextPayload {
  platform: 'gitlab' | 'generic-browser'
  url: string
  title: string
  pageType?: string
  objectKey?: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}

export interface GitLabUrlInfo {
  host: string
  projectPath: string
  pageType: 'gitlab-repo' | 'gitlab-file' | 'gitlab-mr' | 'gitlab-issue'
  objectKey: string
  ref?: string
  filePath?: string
  treePath?: string
  iid?: string
  route: 'repo' | 'blob' | 'tree' | 'merge_request' | 'issue'
}

export function buildPageContextPayload(input: {
  url: string
  title: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}): BrowserPageContextPayload {
  const gitlab = parseGitLabUrl(input.url)
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
      },
    },
  }
}

export function parseGitLabUrl(input?: string): GitLabUrlInfo | undefined {
  if (!input) return undefined

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }

  if (!isLikelyGitLabHost(url.hostname)) return undefined

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length === 0) return undefined

  const dashIndex = parts.indexOf('-')
  const projectParts = dashIndex === -1 ? parts : parts.slice(0, dashIndex)
  const projectPath = projectParts.join('/')
  if (!projectPath) return undefined

  if (dashIndex === -1) {
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-repo',
      objectKey: objectKey(url.hostname, projectPath, 'repo'),
      route: 'repo',
    }
  }

  const route = parts[dashIndex + 1]
  const rest = parts.slice(dashIndex + 2)

  if (route === 'merge_requests' && rest[0]) {
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-mr',
      objectKey: objectKey(url.hostname, projectPath, 'merge_request', rest[0]),
      route: 'merge_request',
      iid: rest[0],
    }
  }

  if (route === 'issues' && rest[0]) {
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-issue',
      objectKey: objectKey(url.hostname, projectPath, 'issue', rest[0]),
      route: 'issue',
      iid: rest[0],
    }
  }

  if (route === 'blob' && rest[0]) {
    const ref = rest[0]
    const filePath = rest.slice(1).join('/')
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-file',
      objectKey: objectKey(url.hostname, projectPath, 'file', ref, filePath),
      route: 'blob',
      ref,
      filePath,
    }
  }

  if (route === 'tree') {
    const ref = rest[0]
    const treePath = rest.slice(1).join('/')
    return {
      host: url.hostname,
      projectPath,
      pageType: 'gitlab-repo',
      objectKey: objectKey(url.hostname, projectPath, 'tree', ref, treePath),
      route: 'tree',
      ref,
      treePath,
    }
  }

  return {
    host: url.hostname,
    projectPath,
    pageType: 'gitlab-repo',
    objectKey: objectKey(url.hostname, projectPath, 'repo'),
    route: 'repo',
  }
}

function isLikelyGitLabHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'gitlab.com' || normalized.includes('gitlab')
}

function objectKey(host: string, projectPath: string, ...parts: Array<string | undefined>) {
  return [host, projectPath, ...parts.filter((part) => part && part.trim())].join(':')
}

function trimText(input: string | undefined, maxLength: number): string | undefined {
  const normalized = input?.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}
