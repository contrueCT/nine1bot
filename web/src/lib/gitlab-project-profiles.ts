import {
  gitLabReviewProjectProfileInputDescriptors,
  selectGitLabReviewProjectProfileValue,
} from '@nine1bot/platform-gitlab/review/project-profile-input'

export type GitLabProjectRef = {
  id: string | number
  pathWithNamespace?: string
  webUrl?: string
}

export type GitLabProjectProfile = {
  id: string
  host?: string
  projectId: string | number
  nine1botProjectID: string
  pathWithNamespace?: string
  displayName?: string
  enabled: boolean
  reviewContextMarkdown?: string
  reviewFocus: string[]
  includePathPrefixes: string[]
  excludePathPatterns: string[]
  maxContextBytes?: number
  maxFiles?: number
  ci: {
    maxJobLogs: number
    maxJobLogBytes: number
  }
}

export function validateGitLabProjectBindings(
  profiles: readonly GitLabProjectProfile[],
  projects: readonly { id: string }[],
): string | undefined {
  for (const profile of profiles) {
    const label = profile.displayName || profile.pathWithNamespace || profile.id
    if (!profile.nine1botProjectID) {
      return `项目档案 ${label} 尚未绑定 Nine1Bot 项目。`
    }
    if (!projects.some((project) => project.id === profile.nine1botProjectID)) {
      return `项目档案 ${label} 绑定的 Nine1Bot 项目不存在。`
    }
  }
  return undefined
}

export function parseGitLabProjectProfiles(input: string | unknown): GitLabProjectProfile[] {
  let parsed: unknown
  try {
    parsed = typeof input === 'string' ? JSON.parse(input || '[]') : input
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const ids = new Set<string>()
  const identities = new Set<string>()
  return parsed.flatMap((item): GitLabProjectProfile[] => {
    if (!isRecord(item)) return []
    const id = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.id,
    )?.value
    const projectId = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.projectId,
    )?.value
    if (!id || projectId === undefined || ids.has(id)) return []

    const host = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.host,
    )?.value
    const identity = gitLabProjectIdentityKey(host, projectId)
    if (identities.has(identity)) return []
    ids.add(id)
    identities.add(identity)

    return [{
      id,
      host,
      projectId,
      nine1botProjectID: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.nine1botProjectID,
      )?.value ?? '',
      pathWithNamespace: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.pathWithNamespace,
      )?.value,
      displayName: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.displayName,
      )?.value,
      enabled: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.enabled,
      )?.value ?? true,
      reviewContextMarkdown: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.reviewContextMarkdown,
      )?.value,
      reviewFocus: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.reviewFocus,
      )?.value ?? [],
      includePathPrefixes: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.includePathPrefixes,
      )?.value ?? [],
      excludePathPatterns: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.excludePathPatterns,
      )?.value ?? [],
      maxContextBytes: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.maxContextBytes,
      )?.value,
      maxFiles: selectGitLabReviewProjectProfileValue(
        item,
        gitLabReviewProjectProfileInputDescriptors.maxFiles,
      )?.value,
      ci: {
        maxJobLogs: selectGitLabReviewProjectProfileValue(
          item,
          gitLabReviewProjectProfileInputDescriptors.maxJobLogs,
        )?.value ?? 3,
        maxJobLogBytes: selectGitLabReviewProjectProfileValue(
          item,
          gitLabReviewProjectProfileInputDescriptors.maxJobLogBytes,
        )?.value ?? 8_000,
      },
    }]
  })
}

export function serializeGitLabProjectProfiles(profiles: GitLabProjectProfile[]) {
  const canonical = parseGitLabProjectProfiles(profiles).map((profile) => ({
    id: profile.id,
    host: profile.host,
    projectId: profile.projectId,
    nine1botProjectID: profile.nine1botProjectID,
    pathWithNamespace: profile.pathWithNamespace,
    displayName: profile.displayName,
    enabled: profile.enabled,
    reviewContextMarkdown: profile.reviewContextMarkdown,
    reviewFocus: profile.reviewFocus,
    includePathPrefixes: profile.includePathPrefixes,
    excludePathPatterns: profile.excludePathPatterns,
    maxContextBytes: profile.maxContextBytes,
    maxFiles: profile.maxFiles,
    ci: {
      maxJobLogs: profile.ci.maxJobLogs,
      maxJobLogBytes: profile.ci.maxJobLogBytes,
    },
  }))
  return JSON.stringify(canonical, null, 2)
}

export function createGitLabProjectProfile(
  project: GitLabProjectRef,
  configuredBaseUrl?: string,
): GitLabProjectProfile {
  const host = gitLabProjectHost(project.webUrl) ?? gitLabProjectHost(configuredBaseUrl)
  return {
    id: gitLabProjectProfileId(host, project.id),
    host,
    projectId: project.id,
    nine1botProjectID: '',
    pathWithNamespace: project.pathWithNamespace,
    displayName: project.pathWithNamespace,
    enabled: true,
    reviewContextMarkdown: undefined,
    reviewFocus: [],
    includePathPrefixes: [],
    excludePathPatterns: [],
    maxContextBytes: undefined,
    maxFiles: undefined,
    ci: { maxJobLogs: 3, maxJobLogBytes: 8_000 },
  }
}

export function gitLabProjectIdentityKey(host: string | undefined, projectId: string | number) {
  return `${gitLabProjectHost(host) ?? ''}:${String(projectId)}`
}

export function gitLabProjectHost(value?: unknown) {
  const text = optionalGitLabProfileText(value)
  if (!text) return undefined
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`)
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}

export function optionalGitLabProfileNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function positiveGitLabProfileNumber(value: unknown, fallback: number) {
  return optionalGitLabProfileNumber(value) ?? fallback
}

function gitLabProjectProfileId(host: string | undefined, projectId: string | number) {
  const authority = (host || 'gitlab').replace(/[^a-z0-9.-]/gi, '-')
  const id = String(projectId).replace(/[^a-z0-9.-]/gi, '-')
  return `project-${authority}-${id}`
}

function optionalGitLabProfileText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
