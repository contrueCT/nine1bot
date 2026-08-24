import {
  GITLAB_REVIEW_PROJECT_CONTEXT_MAX_LENGTH,
} from '@nine1bot/platform-gitlab/review/limits'
import {
  gitLabReviewProjectProfileInputDescriptorList,
  gitLabReviewProjectProfileInputDescriptors,
  gitLabReviewProjectProfileSourceKeys,
  hasGitLabReviewProjectProfileRepresentation,
  selectGitLabReviewProjectProfileValue,
  validateGitLabReviewProjectProfileRepresentations,
  type GitLabReviewProjectProfileInputDescriptor,
  type GitLabReviewProjectProfileRepresentationIssue,
} from '@nine1bot/platform-gitlab/review/project-profile-input'
import {
  parseGitLabProjectProfiles,
  type GitLabProjectProfile,
} from './gitlab-project-profiles'

export type GitLabProjectProfileDiagnostic = {
  code: string
  message: string
  index?: number
  profileId?: string
  field?: string
}

export type GitLabProjectProfileDocument = {
  root: unknown
  entries: unknown[]
  editable: Array<{ index: number; profile: GitLabProjectProfile }>
  sourceText?: string
  parseError?: string
}

export type GitLabProjectProfileDocumentSerialization =
  | { ok: true; value: string }
  | { ok: false; diagnostics: GitLabProjectProfileDiagnostic[] }

export function gitLabProjectProfileDiagnosticKey(diagnostic: GitLabProjectProfileDiagnostic) {
  return [
    diagnostic.code,
    diagnostic.index ?? 'root',
    diagnostic.profileId ?? '',
    diagnostic.field ?? '',
  ].join(':')
}

export function gitLabProjectProfileDiagnosticLabel(diagnostic: GitLabProjectProfileDiagnostic) {
  const entry = diagnostic.index === undefined ? '配置' : `条目 ${diagnostic.index + 1}`
  const profile = diagnostic.profileId ? `（${diagnostic.profileId}）` : ''
  const field = diagnostic.field ? `（字段：${diagnostic.field}）` : ''
  return `${entry}${profile}${field}：${diagnostic.message}`
}

export function parseGitLabProjectProfileDocument(input: string | unknown): GitLabProjectProfileDocument {
  let root: unknown = input
  const sourceText = typeof input === 'string' ? input : undefined
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input.trim() || '[]')
    } catch (error) {
      return {
        root: input,
        entries: [],
        editable: [],
        sourceText: input,
        parseError: error instanceof Error ? error.message : 'Invalid JSON',
      }
    }
  }

  const entries = Array.isArray(root) ? [...root] : []
  return {
    root,
    entries,
    editable: entries.flatMap((entry, index) => {
      const profile = parseGitLabProjectProfiles([entry])[0]
      return profile ? [{ index, profile }] : []
    }),
    sourceText,
  }
}

export function validateGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
): GitLabProjectProfileDiagnostic[] {
  if (document.parseError) {
    return [{ code: 'json_invalid', message: `JSON 格式错误：${document.parseError}` }]
  }
  if (!Array.isArray(document.root)) {
    return [{ code: 'profiles_not_array', message: '项目审查档案必须是 JSON 数组。' }]
  }

  const diagnostics: GitLabProjectProfileDiagnostic[] = []
  const ids = new Set<string>()
  const identities = new Set<string>()
  for (const [index, entry] of document.entries.entries()) {
    if (!isRecord(entry)) {
      diagnostics.push(diagnostic('profile_invalid', '该条目必须是对象。', index))
      continue
    }

    const representationIssues = validateGitLabReviewProjectProfileRepresentations(entry)
    const id = selectGitLabReviewProjectProfileValue(
      entry,
      gitLabReviewProjectProfileInputDescriptors.id,
    )?.value
    for (const issue of representationIssues) {
      diagnostics.push(representationDiagnostic(issue, index, id))
    }
    if (!id) {
      if (!hasGitLabReviewProjectProfileRepresentation(entry, gitLabReviewProjectProfileInputDescriptors.id)) {
        diagnostics.push(diagnostic('profile_id_missing', '缺少有效的档案 ID。', index))
      }
      continue
    }
    const projectId = selectGitLabReviewProjectProfileValue(
      entry,
      gitLabReviewProjectProfileInputDescriptors.projectId,
    )?.value
    if (projectId === undefined) {
      if (!hasGitLabReviewProjectProfileRepresentation(entry, gitLabReviewProjectProfileInputDescriptors.projectId)) {
        diagnostics.push(diagnostic('profile_project_id_missing', '缺少有效的 GitLab 项目 ID。', index, id))
      }
      continue
    }

    const host = selectGitLabReviewProjectProfileValue(
      entry,
      gitLabReviewProjectProfileInputDescriptors.host,
    )?.value
    if (!host && !hasGitLabReviewProjectProfileRepresentation(entry, gitLabReviewProjectProfileInputDescriptors.host)) {
      diagnostics.push(diagnostic('profile_host_invalid', 'GitLab host 无效。', index, id))
    }
    const binding = selectGitLabReviewProjectProfileValue(
      entry,
      gitLabReviewProjectProfileInputDescriptors.nine1botProjectID,
    )?.value
    if (
      !binding
      && !hasGitLabReviewProjectProfileRepresentation(entry, gitLabReviewProjectProfileInputDescriptors.nine1botProjectID)
    ) {
      diagnostics.push(diagnostic('profile_binding_missing', '尚未绑定 Nine1Bot 项目。', index, id))
    }

    if (ids.has(id)) diagnostics.push(diagnostic('profile_id_duplicate', `档案 ID ${id} 重复。`, index, id))
    ids.add(id)
    if (host) {
      const identity = `${host}:${String(projectId)}`
      if (identities.has(identity)) {
        diagnostics.push(diagnostic('profile_identity_duplicate', `GitLab 项目标识 ${identity} 重复。`, index, id))
      }
      identities.add(identity)
    }

  }
  return diagnostics
}

export function updateGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
  index: number,
  profile: GitLabProjectProfile,
) {
  if (!Array.isArray(document.root) || index < 0 || index >= document.entries.length) return document
  const current = document.editable.find((entry) => entry.index === index)
  if (!current) return document
  const entries = [...document.entries]
  entries[index] = updateRawProfile(entries[index], current.profile, profile)
  return parseGitLabProjectProfileDocument(entries)
}

export function appendGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
  profile: GitLabProjectProfile,
) {
  if (!Array.isArray(document.root)) return document
  return parseGitLabProjectProfileDocument([...document.entries, canonicalProfileEntry({}, profile)])
}

export function removeGitLabProjectProfileDocument(document: GitLabProjectProfileDocument, index: number) {
  if (!Array.isArray(document.root) || index < 0 || index >= document.entries.length) return document
  return parseGitLabProjectProfileDocument(document.entries.filter((_, entryIndex) => entryIndex !== index))
}

export function renderGitLabProjectProfileDocument(document: GitLabProjectProfileDocument) {
  if (document.parseError) return document.sourceText ?? ''
  return JSON.stringify(Array.isArray(document.root) ? document.entries : document.root, null, 2)
}

export function serializeGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
): GitLabProjectProfileDocumentSerialization {
  const diagnostics = validateGitLabProjectProfileDocument(document)
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const profiles = new Map(document.editable.map((entry) => [entry.index, entry.profile]))
  const entries = document.entries.map((entry, index) => canonicalProfileEntry(entry, profiles.get(index)!))
  return { ok: true, value: JSON.stringify(entries, null, 2) }
}

function representationDiagnostic(
  issue: GitLabReviewProjectProfileRepresentationIssue,
  index: number,
  profileId?: string,
) {
  const details: Record<string, { code: string; message: string }> = {
    project_profile_id_missing: { code: 'profile_id_missing', message: '缺少有效的档案 ID。' },
    project_profile_host_invalid: { code: 'profile_host_invalid', message: 'GitLab host 无效。' },
    project_profile_project_id_missing: {
      code: 'profile_project_id_missing',
      message: '缺少有效的 GitLab 项目 ID。',
    },
    project_binding_missing: { code: 'profile_binding_missing', message: '尚未绑定 Nine1Bot 项目。' },
    project_profile_path_with_namespace_invalid: {
      code: 'profile_path_with_namespace_invalid',
      message: '项目路径必须是非空字符串。',
    },
    project_profile_display_name_invalid: {
      code: 'profile_display_name_invalid',
      message: '显示名称必须是非空字符串。',
    },
    project_profile_enabled_invalid: { code: 'profile_enabled_invalid', message: '启用状态必须是布尔值。' },
    project_profile_review_context_invalid: {
      code: 'profile_review_context_invalid',
      message: '项目审查上下文必须是非空字符串。',
    },
    project_profile_review_context_too_large: {
      code: 'profile_review_context_too_large',
      message: `项目审查上下文不能超过 ${GITLAB_REVIEW_PROJECT_CONTEXT_MAX_LENGTH} 个字符。`,
    },
    project_profile_review_focus_invalid: {
      code: 'profile_review_focus_invalid',
      message: '审查重点必须是非空字符串数组。',
    },
    project_profile_include_path_prefixes_invalid: {
      code: 'profile_include_path_prefixes_invalid',
      message: '包含路径必须是非空字符串数组。',
    },
    project_profile_exclude_path_patterns_invalid: {
      code: 'profile_exclude_path_patterns_invalid',
      message: '排除路径必须是非空字符串数组。',
    },
    project_profile_max_context_bytes_invalid: {
      code: 'profile_max_context_bytes_invalid',
      message: '上下文预算必须是有限正数。',
    },
    project_profile_max_files_invalid: {
      code: 'profile_max_files_invalid',
      message: '文件上限必须是有限正数。',
    },
    project_profile_ci_invalid: { code: 'profile_ci_invalid', message: 'CI 配置必须是对象。' },
    project_profile_ci_max_job_logs_invalid: {
      code: 'profile_ci_max_job_logs_invalid',
      message: 'CI 日志数量必须是正数。',
    },
    project_profile_ci_max_job_log_bytes_invalid: {
      code: 'profile_ci_max_job_log_bytes_invalid',
      message: 'CI 日志字节上限必须是正数。',
    },
  }
  const detail = details[issue.code] ?? { code: 'profile_invalid', message: '项目档案字段无效。' }
  return diagnostic(detail.code, detail.message, index, profileId, issue.sourceKey)
}

function updateRawProfile(raw: unknown, previous: GitLabProjectProfile, next: GitLabProjectProfile) {
  const output = isRecord(raw) ? { ...raw } : {}
  const descriptors = gitLabReviewProjectProfileInputDescriptors
  updateField(output, previous.id, next.id, descriptors.id)
  updateField(output, previous.host, next.host, descriptors.host)
  updateField(output, previous.projectId, next.projectId, descriptors.projectId)
  updateField(output, previous.nine1botProjectID, next.nine1botProjectID, descriptors.nine1botProjectID)
  updateField(output, previous.pathWithNamespace, next.pathWithNamespace, descriptors.pathWithNamespace)
  updateField(output, previous.displayName, next.displayName, descriptors.displayName)
  updateField(output, previous.enabled, next.enabled, descriptors.enabled)
  updateField(
    output,
    previous.reviewContextMarkdown,
    next.reviewContextMarkdown,
    descriptors.reviewContextMarkdown,
  )
  updateField(output, previous.reviewFocus, next.reviewFocus, descriptors.reviewFocus)
  updateField(output, previous.includePathPrefixes, next.includePathPrefixes, descriptors.includePathPrefixes)
  updateField(output, previous.excludePathPatterns, next.excludePathPatterns, descriptors.excludePathPatterns)
  updateField(output, previous.maxContextBytes, next.maxContextBytes, descriptors.maxContextBytes)
  updateField(output, previous.maxFiles, next.maxFiles, descriptors.maxFiles)

  const maxJobLogsChanged = !sameValue(previous.ci.maxJobLogs, next.ci.maxJobLogs)
  const maxJobLogBytesChanged = !sameValue(previous.ci.maxJobLogBytes, next.ci.maxJobLogBytes)
  if (maxJobLogsChanged || maxJobLogBytesChanged) {
    const ci = isRecord(output.ci) ? { ...output.ci } : {}
    if (maxJobLogsChanged) {
      updateField(ci, previous.ci.maxJobLogs, next.ci.maxJobLogs, descriptors.maxJobLogs)
    }
    if (maxJobLogBytesChanged) {
      updateField(ci, previous.ci.maxJobLogBytes, next.ci.maxJobLogBytes, descriptors.maxJobLogBytes)
    }
    output.ci = ci
  }
  return output
}

function canonicalProfileEntry(raw: unknown, profile: GitLabProjectProfile) {
  const output = isRecord(raw) ? { ...raw } : {}
  for (const descriptor of gitLabReviewProjectProfileInputDescriptorList) {
    if (descriptor.scope !== 'profile') continue
    for (const key of gitLabReviewProjectProfileSourceKeys(descriptor)) delete output[key]
  }

  const rawCi = isRecord((raw as Record<string, unknown> | undefined)?.ci)
    ? { ...(raw as Record<string, unknown>).ci as Record<string, unknown> }
    : {}
  for (const descriptor of [
    gitLabReviewProjectProfileInputDescriptors.maxJobLogs,
    gitLabReviewProjectProfileInputDescriptors.maxJobLogBytes,
  ]) {
    for (const key of gitLabReviewProjectProfileSourceKeys(descriptor)) delete rawCi[key]
  }
  for (const key of ['enabled', 'includeFailedJobLogs', 'include_failed_job_logs']) delete rawCi[key]

  return {
    ...output,
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
      ...rawCi,
      maxJobLogs: profile.ci.maxJobLogs,
      maxJobLogBytes: profile.ci.maxJobLogBytes,
    },
  }
}

function updateField(
  output: Record<string, unknown>,
  previous: unknown,
  next: unknown,
  descriptor: GitLabReviewProjectProfileInputDescriptor,
) {
  if (sameValue(previous, next)) return
  for (const key of gitLabReviewProjectProfileSourceKeys(descriptor)) delete output[key]
  if (next !== undefined) output[descriptor.canonicalKey] = next
}

function diagnostic(code: string, message: string, index: number, profileId?: string, field?: string) {
  return {
    code,
    message,
    index,
    ...(profileId ? { profileId } : {}),
    ...(field ? { field } : {}),
  }
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
