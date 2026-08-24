export function gitLabAuthorityFromUrl(input?: string) {
  const url = parseGitLabHttpUrl(input)
  if (!url || url.username || url.password) return undefined
  return url.host.toLowerCase()
}

export function normalizeGitLabAuthority(input?: string) {
  if (!input?.trim()) return undefined
  const value = input.trim()
  return gitLabAuthorityFromUrl(value.includes('://') ? value : `https://${value}`)
}

export type GitLabApiBaseUrlResolution =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: 'gitlab_host_invalid' | 'gitlab_host_mismatch' }

export function resolveGitLabApiBaseUrl(input: {
  configuredBaseUrl?: string
  triggerHost: string
}): GitLabApiBaseUrlResolution {
  const triggerAuthority = normalizeGitLabAuthority(input.triggerHost)
  if (!triggerAuthority) return { ok: false, reason: 'gitlab_host_invalid' }
  if (!input.configuredBaseUrl) return { ok: true, baseUrl: `https://${triggerAuthority}` }
  const configured = parseGitLabHttpUrl(input.configuredBaseUrl)
  if (!configured || configured.username || configured.password) {
    return { ok: false, reason: 'gitlab_host_invalid' }
  }
  if (configured.host.toLowerCase() !== triggerAuthority) {
    return { ok: false, reason: 'gitlab_host_mismatch' }
  }
  const path = configured.pathname.replace(/\/+$/, '')
  return { ok: true, baseUrl: `${configured.origin}${path === '/' ? '' : path}` }
}

function parseGitLabHttpUrl(input?: string) {
  if (!input) return undefined
  try {
    const url = new URL(input)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}
