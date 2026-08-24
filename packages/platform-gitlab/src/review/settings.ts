import { normalizeGitLabAuthority } from './host'
import {
  gitLabReviewProjectProfileInputDescriptors,
  hasGitLabReviewProjectProfileRepresentation,
  selectGitLabReviewProjectProfileValue,
  validateGitLabReviewProjectProfileRepresentations,
  type GitLabReviewProjectProfileRepresentationIssue,
} from './project-profile-input'

export type GitLabReviewSettings = {
  enabled: boolean
  baseUrl?: string
  botMention: string
  allowedHosts: string[]
  allowedProjectIds: Array<string | number>
  scopeMode: GitLabReviewScopeMode
  includedProjects: GitLabProjectRef[]
  excludedProjects: GitLabProjectRef[]
  projects: GitLabReviewProjectProfile[]
  hookGroups: GitLabGroupRef[]
  webhookSecretRef?: GitLabReviewSecretRef
  tokenSecretRef?: GitLabReviewSecretRef
  manualMentionTrigger: boolean
  webhookAutoReview: boolean
  inlineComments: boolean
  dryRun: boolean
  maxDiffBytes: number
  maxFiles: number
  executionMode: 'dry-run' | 'runtime'
  modelProviderId?: string
  modelId?: string
  configurationErrors: string[]
}

export type GitLabReviewScopeMode = 'all-received' | 'selected-only'

export type GitLabProjectRef = {
  id: string | number
  pathWithNamespace?: string
  webUrl?: string
}

export type GitLabReviewProjectProfile = {
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

export type GitLabReviewProjectSnapshot = GitLabReviewProjectProfile & {
  source: 'configured' | 'unconfigured'
  matchedAt: number
}

export type GitLabGroupRef = {
  id: string | number
  fullPath?: string
  webUrl?: string
}

export type GitLabReviewSecretRef = string | {
  provider: 'nine1bot-local' | 'env' | 'external'
  key: string
}

export const GITLAB_REVIEW_INVALID_CONFIGURATION = 'invalid-review-configuration'

export const defaultGitLabWebhookSecretRef: GitLabReviewSecretRef = {
  provider: 'nine1bot-local',
  key: 'platform:gitlab:default:review.webhookSecretRef',
}

export const defaultGitLabReviewSettings: GitLabReviewSettings = {
  enabled: false,
  baseUrl: undefined,
  botMention: '@Nine1bot',
  allowedHosts: [],
  allowedProjectIds: [],
  scopeMode: 'all-received',
  includedProjects: [],
  excludedProjects: [],
  projects: [],
  hookGroups: [],
  webhookSecretRef: defaultGitLabWebhookSecretRef,
  manualMentionTrigger: true,
  webhookAutoReview: false,
  inlineComments: true,
  dryRun: true,
  maxDiffBytes: 240_000,
  maxFiles: 80,
  executionMode: 'dry-run',
  modelProviderId: undefined,
  modelId: undefined,
  configurationErrors: [],
}

export function normalizeGitLabReviewSettings(input: unknown): GitLabReviewSettings {
  const record = isRecord(input) ? input : {}
  const allowedHosts = allowedHostList(setting(record, 'allowedHosts'))
  const parsedProjects = parseGitLabReviewProjectProfiles(setting(record, 'review.projects', 'projects'))
  const legacyAllowedProjectIds = idList(setting(record, 'review.allowedProjectIds', 'allowedProjectIds'))
  const explicitScopeMode = scopeModeValue(setting(record, 'review.scopeMode', 'scopeMode'))
  const includedProjects = projectRefList(setting(record, 'review.includedProjects', 'includedProjects'))
  const scopeMode = explicitScopeMode ?? (legacyAllowedProjectIds.length > 0 && includedProjects.length === 0 ? 'selected-only' : defaultGitLabReviewSettings.scopeMode)
  const settings: GitLabReviewSettings = {
    ...defaultGitLabReviewSettings,
    enabled: booleanValue(setting(record, 'review.enabled', 'enabled'), defaultGitLabReviewSettings.enabled),
    baseUrl: optionalString(setting(record, 'review.baseUrl', 'baseUrl')),
    botMention: stringValue(setting(record, 'review.botMention', 'botMention'), defaultGitLabReviewSettings.botMention),
    allowedHosts: allowedHosts.hosts,
    allowedProjectIds: legacyAllowedProjectIds,
    scopeMode,
    includedProjects: includedProjects.length > 0 ? includedProjects : legacyAllowedProjectIds.map((id) => ({ id })),
    excludedProjects: projectRefList(setting(record, 'review.excludedProjects', 'excludedProjects')),
    projects: parsedProjects.profiles,
    hookGroups: groupRefList(setting(record, 'review.hookGroups', 'hookGroups')),
    webhookSecretRef: optionalSecretRef(setting(record, 'review.webhookSecretRef', 'webhookSecretRef')) ?? defaultGitLabReviewSettings.webhookSecretRef,
    tokenSecretRef: optionalSecretRef(setting(record, 'review.tokenSecretRef', 'tokenSecretRef')),
    manualMentionTrigger: booleanValue(setting(record, 'review.manualMentionTrigger', 'manualMentionTrigger'), defaultGitLabReviewSettings.manualMentionTrigger),
    webhookAutoReview: booleanValue(setting(record, 'review.webhookAutoReview', 'webhookAutoReview'), defaultGitLabReviewSettings.webhookAutoReview),
    inlineComments: booleanValue(setting(record, 'review.inlineComments', 'inlineComments'), defaultGitLabReviewSettings.inlineComments),
    dryRun: booleanValue(setting(record, 'review.dryRun', 'dryRun'), defaultGitLabReviewSettings.dryRun),
    maxDiffBytes: positiveNumber(setting(record, 'review.maxDiffBytes', 'maxDiffBytes'), defaultGitLabReviewSettings.maxDiffBytes),
    maxFiles: positiveNumber(setting(record, 'review.maxFiles', 'maxFiles'), defaultGitLabReviewSettings.maxFiles),
    executionMode: setting(record, 'review.executionMode', 'executionMode') === 'runtime' ? 'runtime' : 'dry-run',
    modelProviderId: optionalString(setting(record, 'review.modelProviderId', 'modelProviderId')),
    modelId: optionalString(setting(record, 'review.modelId', 'modelId')),
    configurationErrors: [
      ...(allowedHosts.valid ? [] : ['allowed_hosts_invalid']),
      ...parsedProjects.errors,
    ],
  }
  if (settings.enabled && !hasUsableGitLabReviewProjectProfile(settings)) {
    settings.configurationErrors.push('project_profile_usable_missing:review.projects')
  }
  return settings
}

export function parseGitLabReviewProjectProfiles(input: unknown): {
  profiles: GitLabReviewProjectProfile[]
  errors: string[]
} {
  if (input === undefined) return { profiles: [], errors: [] }
  if (!Array.isArray(input)) {
    return { profiles: [], errors: ['project_profiles_not_array:review.projects'] }
  }

  const profiles: GitLabReviewProjectProfile[] = []
  const errors: string[] = []
  const ids = new Set<string>()
  const identities = new Set<string>()

  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) {
      errors.push(`project_profile_invalid:index:${index}`)
      continue
    }

    const representationIssues = validateGitLabReviewProjectProfileRepresentations(item)
    const id = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.id,
    )?.value
    for (const issue of representationIssues) {
      errors.push(projectProfileRepresentationError(issue, id, index))
    }
    if (!id) {
      if (!hasGitLabReviewProjectProfileRepresentation(item, gitLabReviewProjectProfileInputDescriptors.id)) {
        errors.push(`project_profile_id_missing:index:${index}`)
      }
      continue
    }

    const projectId = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.projectId,
    )?.value
    if (projectId === undefined) {
      if (!hasGitLabReviewProjectProfileRepresentation(item, gitLabReviewProjectProfileInputDescriptors.projectId)) {
        errors.push(`project_profile_project_id_missing:${id}`)
      }
      continue
    }

    const host = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.host,
    )?.value
    if (!host && !hasGitLabReviewProjectProfileRepresentation(item, gitLabReviewProjectProfileInputDescriptors.host)) {
      errors.push(`project_profile_host_invalid:${id}`)
    }
    const binding = selectGitLabReviewProjectProfileValue(
      item,
      gitLabReviewProjectProfileInputDescriptors.nine1botProjectID,
    )?.value

    const profile: GitLabReviewProjectProfile = {
      id,
      host,
      projectId,
      nine1botProjectID: binding ?? '',
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
    }

    if (ids.has(profile.id)) errors.push(`project_profile_id_duplicate:${profile.id}`)
    ids.add(profile.id)
    if (profile.host) {
      const identity = projectProfileIdentity(profile)
      if (identities.has(identity)) errors.push(`project_profile_identity_duplicate:${identity}`)
      identities.add(identity)
    }
    if (
      !profile.nine1botProjectID
      && !hasGitLabReviewProjectProfileRepresentation(item, gitLabReviewProjectProfileInputDescriptors.nine1botProjectID)
    ) {
      errors.push(`project_binding_missing:${profile.id}`)
    }
    profiles.push(profile)
  }

  return { profiles, errors }
}

export function hasUsableGitLabReviewProjectProfile(settings: GitLabReviewSettings) {
  const idCounts = new Map<string, number>()
  const identityCounts = new Map<string, number>()
  for (const profile of settings.projects) {
    idCounts.set(profile.id, (idCounts.get(profile.id) ?? 0) + 1)
    if (profile.host) {
      const identity = projectProfileIdentity(profile)
      identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1)
    }
  }
  return settings.projects.some((profile) => {
    if (!profile.enabled || !profile.host || !profile.nine1botProjectID) return false
    return idCounts.get(profile.id) === 1 && identityCounts.get(projectProfileIdentity(profile)) === 1
  })
}

export function isGitLabReviewConfigurationExecutable(
  settings: Pick<GitLabReviewSettings, 'configurationErrors'>,
) {
  return settings.configurationErrors.length === 0
}

export function isGitLabReviewProjectInScope(
  settings: GitLabReviewSettings,
  project: { id: string | number; pathWithNamespace?: string },
) {
  if (projectRefMatches(settings.excludedProjects, project)) return false
  if (settings.scopeMode === 'selected-only') {
    return projectRefMatches(settings.includedProjects, project)
  }
  return true
}

export function gitLabReviewProjectIdsForHookSync(settings: GitLabReviewSettings): Array<string | number> {
  const candidates = settings.scopeMode === 'selected-only'
    ? settings.includedProjects
    : settings.includedProjects.length > 0
      ? settings.includedProjects
      : settings.allowedProjectIds.map((id) => ({ id }))
  return uniqueIds(candidates.map((project) => project.id))
}

function projectProfileRepresentationError(
  issue: GitLabReviewProjectProfileRepresentationIssue,
  profileId: string | undefined,
  index: number,
) {
  return `${issue.code}:${profileId ?? `index:${index}`}:${issue.sourceKey}`
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function projectRefMatches(projects: GitLabProjectRef[], project: { id: string | number; pathWithNamespace?: string }) {
  return projects.some((candidate) => {
    if (String(candidate.id) === String(project.id)) return true
    return Boolean(candidate.pathWithNamespace && project.pathWithNamespace && candidate.pathWithNamespace === project.pathWithNamespace)
  })
}

function uniqueIds(ids: Array<string | number>) {
  const seen = new Set<string>()
  const output: Array<string | number> = []
  for (const id of ids) {
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(id)
  }
  return output
}

function booleanValue(input: unknown, fallback: boolean) {
  return typeof input === 'boolean' ? input : fallback
}

function stringValue(input: unknown, fallback: string) {
  return typeof input === 'string' && input.trim() ? input.trim() : fallback
}

function optionalString(input: unknown) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function optionalSecretRef(input: unknown): GitLabReviewSecretRef | undefined {
  if (typeof input === 'string' && input.trim()) return input.trim()
  if (!isRecord(input)) return undefined
  if (
    (input.provider === 'nine1bot-local' || input.provider === 'env' || input.provider === 'external') &&
    typeof input.key === 'string'
  ) {
    return {
      provider: input.provider,
      key: input.key,
    }
  }
  return undefined
}

function allowedHostList(input: unknown) {
  if (input === undefined) return { hosts: [] as string[], valid: true }
  if (!Array.isArray(input)) return { hosts: [] as string[], valid: false }
  const hosts: string[] = []
  let valid = true
  for (const item of input) {
    if (typeof item !== 'string' || !item.trim()) {
      valid = false
      continue
    }
    const normalized = normalizeGitLabAuthority(item)
    if (!normalized) {
      valid = false
      continue
    }
    if (!hosts.includes(normalized)) hosts.push(normalized)
  }
  return { hosts, valid }
}

function idList(input: unknown) {
  return Array.isArray(input)
    ? input.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    : []
}

function scopeModeValue(input: unknown): GitLabReviewScopeMode | undefined {
  return input === 'selected-only' || input === 'all-received' ? input : undefined
}

function projectRefList(input: unknown): GitLabProjectRef[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return { id: item }
      if (!isRecord(item)) return undefined
      const id = item.id
      if (typeof id !== 'string' && typeof id !== 'number') return undefined
      return {
        id,
        pathWithNamespace: optionalString(item.pathWithNamespace) ?? optionalString(item.path_with_namespace),
        webUrl: optionalString(item.webUrl) ?? optionalString(item.web_url),
      }
    })
    .filter((item): item is GitLabProjectRef => Boolean(item))
}

function projectProfileIdentity(project: Pick<GitLabReviewProjectProfile, 'host' | 'projectId'>) {
  return `${project.host}:${String(project.projectId)}`
}

function groupRefList(input: unknown): GitLabGroupRef[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return { id: item }
      if (!isRecord(item)) return undefined
      const id = item.id
      if (typeof id !== 'string' && typeof id !== 'number') return undefined
      return {
        id,
        fullPath: optionalString(item.fullPath) ?? optionalString(item.full_path),
        webUrl: optionalString(item.webUrl) ?? optionalString(item.web_url),
      }
    })
    .filter((item): item is GitLabGroupRef => Boolean(item))
}

function positiveNumber(input: unknown, fallback: number) {
  return isPositiveNumber(input) ? input : fallback
}

function isPositiveNumber(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input > 0
}

function setting(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key]
  }
  return undefined
}
