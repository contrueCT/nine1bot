import { normalizeGitLabAuthority } from './host'
import { GITLAB_REVIEW_PROJECT_CONTEXT_MAX_LENGTH } from './limits'

export type GitLabReviewProjectProfileLogicalField =
  | 'id'
  | 'host'
  | 'projectId'
  | 'nine1botProjectID'
  | 'pathWithNamespace'
  | 'displayName'
  | 'enabled'
  | 'reviewContextMarkdown'
  | 'reviewFocus'
  | 'includePathPrefixes'
  | 'excludePathPatterns'
  | 'maxContextBytes'
  | 'maxFiles'
  | 'ci'
  | 'maxJobLogs'
  | 'maxJobLogBytes'

export type GitLabReviewProjectProfileRepresentationIssue = {
  code: string
  logicalField: GitLabReviewProjectProfileLogicalField
  sourceKey: string
}

export type GitLabReviewProjectProfileInputDescriptor<T = unknown> = Readonly<{
  logicalField: GitLabReviewProjectProfileLogicalField
  canonicalKey: string
  aliases: readonly string[]
  scope: 'profile' | 'ci'
  issueCode: (value: unknown) => string | undefined
  normalize: (value: unknown) => T
}>

export type GitLabReviewProjectProfileValueSelection<T> = Readonly<{
  sourceKey: string
  value: T
}>

const id = profileDescriptor('id', 'id', [], textIssue('project_profile_id_missing'), normalizedText)
const host = profileDescriptor(
  'host',
  'host',
  [],
  (value) => normalizeGitLabAuthority(typeof value === 'string' ? value : undefined)
    ? undefined
    : 'project_profile_host_invalid',
  (value) => normalizeGitLabAuthority(value as string)!,
)
const projectId = profileDescriptor(
  'projectId',
  'projectId',
  ['project_id'],
  (value) => isProjectId(value) ? undefined : 'project_profile_project_id_missing',
  (value) => value as string | number,
)
const nine1botProjectID = profileDescriptor(
  'nine1botProjectID',
  'nine1botProjectID',
  ['nine1bot_project_id'],
  textIssue('project_binding_missing'),
  normalizedText,
)
const pathWithNamespace = profileDescriptor(
  'pathWithNamespace',
  'pathWithNamespace',
  ['path_with_namespace'],
  textIssue('project_profile_path_with_namespace_invalid'),
  normalizedText,
)
const displayName = profileDescriptor(
  'displayName',
  'displayName',
  ['display_name'],
  textIssue('project_profile_display_name_invalid'),
  normalizedText,
)
const enabled = profileDescriptor(
  'enabled',
  'enabled',
  [],
  (value) => typeof value === 'boolean' ? undefined : 'project_profile_enabled_invalid',
  (value) => value as boolean,
)
const reviewContextMarkdown = profileDescriptor(
  'reviewContextMarkdown',
  'reviewContextMarkdown',
  ['review_context_markdown', 'contextMarkdown', 'context_markdown'],
  (value) => {
    if (!isNonEmptyText(value)) return 'project_profile_review_context_invalid'
    return value.length <= GITLAB_REVIEW_PROJECT_CONTEXT_MAX_LENGTH
      ? undefined
      : 'project_profile_review_context_too_large'
  },
  normalizedText,
)
const reviewFocus = profileDescriptor(
  'reviewFocus',
  'reviewFocus',
  ['review_focus'],
  textListIssue('project_profile_review_focus_invalid'),
  normalizedTextList,
)
const includePathPrefixes = profileDescriptor(
  'includePathPrefixes',
  'includePathPrefixes',
  ['include_path_prefixes'],
  textListIssue('project_profile_include_path_prefixes_invalid'),
  normalizedTextList,
)
const excludePathPatterns = profileDescriptor(
  'excludePathPatterns',
  'excludePathPatterns',
  ['exclude_path_patterns'],
  textListIssue('project_profile_exclude_path_patterns_invalid'),
  normalizedTextList,
)
const maxContextBytes = profileDescriptor(
  'maxContextBytes',
  'maxContextBytes',
  ['max_context_bytes'],
  positiveNumberIssue('project_profile_max_context_bytes_invalid'),
  normalizedNumber,
)
const maxFiles = profileDescriptor(
  'maxFiles',
  'maxFiles',
  ['max_files'],
  positiveNumberIssue('project_profile_max_files_invalid'),
  normalizedNumber,
)
const ci = profileDescriptor(
  'ci',
  'ci',
  [],
  (value) => isRecord(value) ? undefined : 'project_profile_ci_invalid',
  (value) => value as Record<string, unknown>,
)
const maxJobLogs = ciDescriptor(
  'maxJobLogs',
  'maxJobLogs',
  ['max_job_logs', 'maxFailedJobs', 'max_failed_jobs'],
  positiveNumberIssue('project_profile_ci_max_job_logs_invalid'),
  normalizedNumber,
)
const maxJobLogBytes = ciDescriptor(
  'maxJobLogBytes',
  'maxJobLogBytes',
  ['max_job_log_bytes'],
  positiveNumberIssue('project_profile_ci_max_job_log_bytes_invalid'),
  normalizedNumber,
)

export const gitLabReviewProjectProfileInputDescriptors = Object.freeze({
  id,
  host,
  projectId,
  nine1botProjectID,
  pathWithNamespace,
  displayName,
  enabled,
  reviewContextMarkdown,
  reviewFocus,
  includePathPrefixes,
  excludePathPatterns,
  maxContextBytes,
  maxFiles,
  ci,
  maxJobLogs,
  maxJobLogBytes,
})

export const gitLabReviewProjectProfileInputDescriptorList = Object.freeze([
  id,
  host,
  projectId,
  nine1botProjectID,
  pathWithNamespace,
  displayName,
  enabled,
  reviewContextMarkdown,
  reviewFocus,
  includePathPrefixes,
  excludePathPatterns,
  maxContextBytes,
  maxFiles,
  ci,
  maxJobLogs,
  maxJobLogBytes,
])

export function validateGitLabReviewProjectProfileRepresentations(
  entry: unknown,
): GitLabReviewProjectProfileRepresentationIssue[] {
  if (!isRecord(entry)) return []
  const issues: GitLabReviewProjectProfileRepresentationIssue[] = []
  for (const descriptor of gitLabReviewProjectProfileInputDescriptorList) {
    const source = descriptorSource(entry, descriptor)
    if (!source) continue
    for (const sourceKey of gitLabReviewProjectProfileSourceKeys(descriptor)) {
      if (!hasOwn(source, sourceKey)) continue
      const code = descriptor.issueCode(source[sourceKey])
      if (code) issues.push({ code, logicalField: descriptor.logicalField, sourceKey })
    }
  }
  return issues
}

export function selectGitLabReviewProjectProfileValue<T>(
  entry: unknown,
  descriptor: GitLabReviewProjectProfileInputDescriptor<T>,
): GitLabReviewProjectProfileValueSelection<T> | undefined
export function selectGitLabReviewProjectProfileValue(
  entry: unknown,
  descriptor: GitLabReviewProjectProfileInputDescriptor,
): GitLabReviewProjectProfileValueSelection<unknown> | undefined
export function selectGitLabReviewProjectProfileValue(
  entry: unknown,
  descriptor: GitLabReviewProjectProfileInputDescriptor,
): GitLabReviewProjectProfileValueSelection<unknown> | undefined {
  if (!isRecord(entry)) return undefined
  const source = descriptorSource(entry, descriptor)
  if (!source) return undefined
  for (const sourceKey of gitLabReviewProjectProfileSourceKeys(descriptor)) {
    if (!hasOwn(source, sourceKey)) continue
    const value = source[sourceKey]
    if (!descriptor.issueCode(value)) {
      return { sourceKey, value: descriptor.normalize(value) }
    }
  }
  return undefined
}

export function hasGitLabReviewProjectProfileRepresentation(
  entry: unknown,
  descriptor: GitLabReviewProjectProfileInputDescriptor,
) {
  if (!isRecord(entry)) return false
  const source = descriptorSource(entry, descriptor)
  return Boolean(source && gitLabReviewProjectProfileSourceKeys(descriptor).some((key) => hasOwn(source, key)))
}

export function gitLabReviewProjectProfileSourceKeys(
  descriptor: GitLabReviewProjectProfileInputDescriptor,
) {
  return [descriptor.canonicalKey, ...descriptor.aliases]
}

function profileDescriptor<T>(
  logicalField: GitLabReviewProjectProfileLogicalField,
  canonicalKey: string,
  aliases: readonly string[],
  issueCode: (value: unknown) => string | undefined,
  normalize: (value: unknown) => T,
): GitLabReviewProjectProfileInputDescriptor<T> {
  return { logicalField, canonicalKey, aliases, scope: 'profile', issueCode, normalize }
}

function ciDescriptor<T>(
  logicalField: GitLabReviewProjectProfileLogicalField,
  canonicalKey: string,
  aliases: readonly string[],
  issueCode: (value: unknown) => string | undefined,
  normalize: (value: unknown) => T,
): GitLabReviewProjectProfileInputDescriptor<T> {
  return { logicalField, canonicalKey, aliases, scope: 'ci', issueCode, normalize }
}

function descriptorSource(
  entry: Record<string, unknown>,
  descriptor: GitLabReviewProjectProfileInputDescriptor,
) {
  if (descriptor.scope === 'profile') return entry
  if (!hasOwn(entry, 'ci') || !isRecord(entry.ci)) return undefined
  return entry.ci
}

function textIssue(code: string) {
  return (value: unknown) => isNonEmptyText(value) ? undefined : code
}

function textListIssue(code: string) {
  return (value: unknown) => Array.isArray(value) && value.every(isNonEmptyText) ? undefined : code
}

function positiveNumberIssue(code: string) {
  return (value: unknown) => isPositiveNumber(value) ? undefined : code
}

function normalizedText(value: unknown) {
  return (value as string).trim()
}

function normalizedTextList(value: unknown) {
  return (value as string[]).map((item) => item.trim())
}

function normalizedNumber(value: unknown) {
  return value as number
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isProjectId(value: unknown): value is string | number {
  return isNonEmptyText(value) || (typeof value === 'number' && Number.isFinite(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}
