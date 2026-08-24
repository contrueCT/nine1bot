import { buildGitLabDiffManifest } from '../review/diff-builder'
import { sanitizeGitLabSecrets } from '../review/sanitizer'
import type { GitLabDiffManifest, GitLabRawChange, GitLabRawChangesResponse } from '../review/types'
import { truncateUtf8 } from '../review/utf8-budget'
import { getGitLabCliStatus, gitLabCliMaxOutputBytes, runGlab } from './glab'
import type {
  GitLabBoundedDiff,
  GitLabCliRunner,
  GitLabCliRunOptions,
  GitLabMrSnapshot,
  GitLabPublishReviewDiscussionResult,
  GitLabPublishReviewNoteResult,
  GitLabProjectSnapshot,
  GitLabRepositoryHealthContext,
  GitLabTarget,
  PublishReviewDiscussionInput,
  PublishReviewNoteInput,
  RepositoryHealthContextInput,
} from './types'
import { GitLabCliToolError as ToolError } from './types'

export type GitLabCliClientOptions = {
  runner?: GitLabCliRunner
  cwd?: string
  signal?: AbortSignal
}

export function createGitLabCliClient(options: GitLabCliClientOptions = {}) {
  const runner = options.runner ?? runGlab
  const runApi = async (
    target: { host?: string } | undefined,
    endpoint: string,
    runOptions?: GitLabCliRunOptions & {
      method?: 'GET' | 'POST'
      body?: Record<string, unknown>
    },
  ) => {
    const args = ['api', endpoint]
    if (runOptions?.method && runOptions.method !== 'GET') args.push('--method', runOptions.method)
    const stdin = runOptions?.body === undefined ? undefined : JSON.stringify(runOptions.body)
    if (stdin !== undefined) args.push('--input', '-')
    if (target?.host) args.push('--hostname', target.host)
    const signal = runOptions?.signal ?? options.signal
    const result = await runner(args, {
      cwd: options.cwd,
      timeoutMs: runOptions?.timeoutMs,
      signal,
      stdin,
    })
    if (result.cancelled || signal?.aborted) {
      throw new ToolError('command_cancelled', 'GitLab CLI command was cancelled.', safeCommand(result.args))
    }
    if (result.outputTooLarge || Buffer.byteLength(result.stdout, 'utf8') > gitLabCliMaxOutputBytes) {
      throw new ToolError('output_too_large', 'GitLab CLI output exceeded the configured safety limit.', safeCommand(result.args))
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || 'GitLab CLI command failed.'
      throw new ToolError(
        isAuthenticationFailure(detail) ? 'glab_not_authenticated' : 'command_failed',
        trimError(detail),
        safeCommand(result.args),
      )
    }
    return parseJson(result.stdout, safeCommand(result.args))
  }

  const projectSnapshot = async (target: Extract<GitLabTarget, { kind: 'project' }>): Promise<GitLabProjectSnapshot> => {
    assertValidGitLabTarget(target)
    const project = recordValue(await runApi(target, projectEndpoint(target.projectPath)))
    return normalizeProjectSnapshot(target, project)
  }

  return {
    status: () => getGitLabCliStatus({ runner, cwd: options.cwd, signal: options.signal }),

    projectSnapshot,

    async mrSnapshot(target: Extract<GitLabTarget, { kind: 'merge_request' }>): Promise<GitLabMrSnapshot> {
      assertValidGitLabTarget(target)
      const mr = recordValue(await runApi(target, `${projectEndpoint(target.projectPath)}/merge_requests/${encodeURIComponent(target.iid)}`))
      return normalizeMrSnapshot(target, mr)
    },

    async mrDiff(input: {
      target: Extract<GitLabTarget, { kind: 'merge_request' }>
      maxFiles?: number
      maxBytes?: number
    }): Promise<GitLabBoundedDiff> {
      assertValidGitLabTarget(input.target)
      const response = recordValue(await runApi(
        input.target,
        `${projectEndpoint(input.target.projectPath)}/merge_requests/${encodeURIComponent(input.target.iid)}/changes`,
      ))
      const manifest = buildCliDiffManifest(arrayValue(response.changes), {
        maxFiles: input.maxFiles,
        maxBytes: input.maxBytes,
        overflow: response.overflow === true,
        diffRefs: recordOrUndefined(response.diff_refs),
      })
      return {
        target: input.target,
        manifest,
        truncated: Boolean(manifest.blocked || manifest.stats.truncated || manifest.stats.skippedFileCount > 0),
        coverage: diffCoverage(manifest.files.length, manifest.stats.skippedFileCount, manifest.blocked),
      }
    },

    async commitDiff(input: {
      target: Extract<GitLabTarget, { kind: 'commit' }>
      maxFiles?: number
      maxBytes?: number
    }): Promise<GitLabBoundedDiff> {
      assertValidGitLabTarget(input.target)
      const maxFiles = boundedInteger(input.maxFiles, 20, 1, 24)
      const commitDiff = await readBoundedCommitDiff(runApi, input.target, maxFiles)
      const manifest = buildCliDiffManifest(commitDiff.changes, {
        maxFiles,
        maxBytes: input.maxBytes,
      })
      if (commitDiff.additionalFilesOmitted || commitDiff.gitLabDiffLimited) manifest.stats.truncated = true
      return {
        target: input.target,
        manifest,
        truncated: Boolean(manifest.blocked || manifest.stats.truncated || manifest.stats.skippedFileCount > 0),
        coverage: diffCoverage(manifest.files.length, manifest.stats.skippedFileCount, manifest.blocked, {
          additionalCommitFiles: commitDiff.additionalFilesOmitted,
          gitLabDiffLimited: commitDiff.gitLabDiffLimited,
          maxFiles,
        }),
      }
    },

    async repositoryHealthContext(input: RepositoryHealthContextInput): Promise<GitLabRepositoryHealthContext> {
      assertValidGitLabTarget(input.target)
      const project = await projectSnapshot(input.target)
      const ref = input.ref ?? project.defaultBranch
      const rootTree = await readRootTree(runApi, input.target, ref)
      const contextFiles = await readImportantFiles(runApi, input, rootTree.entries, ref)
      const readme = contextFiles.importantFiles.find((file) => /^readme(\.|$)/i.test(file.path))?.contentPreview
      return {
        target: input.target,
        project,
        readme,
        rootTree: rootTree.entries,
        rootTreeTruncated: rootTree.truncated,
        importantFiles: contextFiles.importantFiles,
        skipped: contextFiles.skipped,
        coverage: repositoryHealthCoverage({
          projectPath: input.target.projectPath,
          ref,
          candidateCount: contextFiles.candidateCount,
          includedCount: contextFiles.importantFiles.length,
          skippedCount: contextFiles.skipped.length,
          usedBytes: contextFiles.usedBytes,
          maxBytes: contextFiles.maxBytes,
          rootTreeTruncated: rootTree.truncated,
        }),
      }
    },

    async publishReviewNote(input: PublishReviewNoteInput): Promise<GitLabPublishReviewNoteResult> {
      assertValidGitLabTarget(input.target)
      assertValidGitLabReviewBody(input.body)
      const bodyPreview = previewText(input.body)
      if (input.dryRun) {
        return {
          target: input.target,
          dryRun: true,
          published: false,
          bodyPreview,
        }
      }

      const endpoint = input.target.kind === 'merge_request'
        ? `${projectEndpoint(input.target.projectPath)}/merge_requests/${encodeURIComponent(input.target.iid)}/notes`
        : `${projectEndpoint(input.target.projectPath)}/repository/commits/${encodeURIComponent(input.target.sha)}/comments`
      const fieldName = input.target.kind === 'merge_request' ? 'body' : 'note'
      const note = await runApi(input.target, endpoint, {
        method: 'POST',
        body: { [fieldName]: input.body },
      })
      const noteRecord = recordValue(note)

      return {
        target: input.target,
        dryRun: false,
        published: true,
        noteId: numberValue(noteRecord.id),
        webUrl: stringValue(noteRecord.web_url),
        bodyPreview,
      }
    },

    async publishReviewDiscussion(input: PublishReviewDiscussionInput): Promise<GitLabPublishReviewDiscussionResult> {
      assertValidGitLabTarget(input.target)
      assertValidGitLabReviewBody(input.body)
      assertValidGitLabInlinePosition(input.position)
      const bodyPreview = previewText(input.body)
      if (input.dryRun) {
        return {
          target: input.target,
          dryRun: true,
          published: false,
          bodyPreview,
          position: input.position,
        }
      }

      const discussion = await runApi(
        input.target,
        `${projectEndpoint(input.target.projectPath)}/merge_requests/${encodeURIComponent(input.target.iid)}/discussions`,
        {
          method: 'POST',
          body: {
            body: input.body,
            position: input.position,
          },
        },
      )
      const discussionRecord = recordValue(discussion)

      return {
        target: input.target,
        dryRun: false,
        published: true,
        discussionId: exactBoundedStringValue(discussionRecord.id, 256),
        bodyPreview,
        position: input.position,
      }
    },
  }
}

function projectEndpoint(projectPath: string) {
  return `projects/${encodeURIComponent(projectPath)}`
}

async function readBoundedCommitDiff(
  runApi: (target: { host?: string } | undefined, endpoint: string) => Promise<unknown>,
  target: Extract<GitLabTarget, { kind: 'commit' }>,
  maxFiles: number,
) {
  const endpoint = `${projectEndpoint(target.projectPath)}/repository/commits/${encodeURIComponent(target.sha)}/diff`
  const fetchLimit = maxFiles + 1
  const changes: unknown[] = []
  let page = 1
  let responseExceededRequest = false
  let gitLabDiffLimited = false

  while (changes.length < fetchLimit) {
    const perPage = Math.min(100, fetchLimit - changes.length)
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) })
    const pageChanges = arrayValue(await runApi(target, `${endpoint}?${params}`))
    gitLabDiffLimited ||= pageChanges.some(isGitLabLimitedDiff)
    const remaining = fetchLimit - changes.length
    changes.push(...pageChanges.slice(0, remaining))
    responseExceededRequest ||= pageChanges.length > remaining
    if (changes.length >= fetchLimit || pageChanges.length < perPage) break
    page += 1
  }

  return {
    changes,
    additionalFilesOmitted: changes.length > maxFiles || responseExceededRequest,
    gitLabDiffLimited,
  }
}

function isGitLabLimitedDiff(input: unknown) {
  const change = recordOrUndefined(input)
  return change?.collapsed === true || change?.too_large === true || change?.overflow === true
}

async function readRootTree(
  runApi: (target: { host?: string } | undefined, endpoint: string) => Promise<unknown>,
  target: Extract<GitLabTarget, { kind: 'project' }>,
  ref?: string,
) {
  const params = new URLSearchParams({ per_page: '100' })
  if (ref) params.set('ref', ref)
  const tree = arrayValue(await runApi(target, `${projectEndpoint(target.projectPath)}/repository/tree?${params}`))
  const entries = tree.slice(0, 60).flatMap((item) => {
    const record = recordOrUndefined(item)
    if (!record) return []
    const path = exactBoundedStringValue(record.path, 256) ?? exactBoundedStringValue(record.name, 256)
    if (!path) return []
    return [{
      path,
      type: record.type === 'tree' ? 'tree' as const : 'file' as const,
    }]
  })
  return {
    entries,
    truncated: tree.length > entries.length,
  }
}

async function readImportantFiles(
  runApi: (target: { host?: string } | undefined, endpoint: string) => Promise<unknown>,
  input: RepositoryHealthContextInput,
  rootTree: Array<{ path: string; type: 'file' | 'tree' }>,
  ref?: string,
) {
  const maxFiles = boundedInteger(input.maxFiles, 8, 1, 32)
  const maxBytes = boundedInteger(input.maxBytes, 16_000, 1, 32_000)
  let usedBytes = 0
  const candidates = [...new Set([
    ...(input.paths ?? []),
    ...rootTree.filter((item) => item.type === 'file' && isImportantRootFile(item.path)).map((item) => item.path),
  ])]
  const paths = candidates.slice(0, maxFiles)
  const skipped = candidates.slice(maxFiles).map((path) => ({
    path,
    reason: 'max-files-limit',
  }))

  const results: GitLabRepositoryHealthContext['importantFiles'] = []
  for (const path of paths) {
    if (usedBytes >= maxBytes) {
      skipped.push({ path, reason: 'byte-budget-exhausted' })
      continue
    }
    try {
      const params = new URLSearchParams()
      if (ref) params.set('ref', ref)
      const file = recordValue(await runApi(
        input.target,
        `${projectEndpoint(input.target.projectPath)}/repository/files/${encodeURIComponent(path)}${params.size ? `?${params}` : ''}`,
      ))
      const decoded = decodeGitLabFileContent(file)
      const remaining = Math.max(0, maxBytes - usedBytes)
      const preview = truncateUtf8(decoded, remaining)
      if (!preview) {
        skipped.push({ path, reason: decoded ? 'byte-budget-exhausted' : 'empty-or-unsupported-content' })
        continue
      }
      usedBytes += Buffer.byteLength(preview, 'utf8')
      results.push({ path, reason: importantFileReason(path), contentPreview: preview })
      if (decoded.length > preview.length) {
        skipped.push({ path, reason: 'content-preview-truncated-by-byte-budget' })
      }
    } catch (error) {
      if (error instanceof ToolError && [
        'command_cancelled',
        'glab_not_authenticated',
        'output_too_large',
      ].includes(error.code)) {
        throw error
      }
      skipped.push({ path, reason: 'read-failed' })
    }
  }
  return {
    importantFiles: results,
    skipped,
    candidateCount: candidates.length,
    usedBytes,
    maxBytes,
  }
}

function normalizeProjectSnapshot(target: Extract<GitLabTarget, { kind: 'project' }>, project: Record<string, unknown>): GitLabProjectSnapshot {
  return {
    target,
    id: numberValue(project.id),
    name: boundedStringValue(project.name, 256),
    pathWithNamespace: exactBoundedStringValue(project.path_with_namespace, 512) ?? target.projectPath,
    defaultBranch: exactBoundedStringValue(project.default_branch, 512),
    webUrl: boundedStringValue(project.web_url, 2_000),
    description: boundedStringValue(project.description, 2_000),
  }
}

function normalizeMrSnapshot(target: Extract<GitLabTarget, { kind: 'merge_request' }>, mr: Record<string, unknown>): GitLabMrSnapshot {
  return {
    target,
    id: numberValue(mr.id),
    title: boundedStringValue(mr.title, 1_000) ?? `Merge request !${target.iid}`,
    state: boundedStringValue(mr.state, 64),
    author: boundedStringValue(recordOrUndefined(mr.author)?.username, 256),
    sourceBranch: exactBoundedStringValue(mr.source_branch, 512),
    targetBranch: exactBoundedStringValue(mr.target_branch, 512),
    webUrl: boundedStringValue(mr.web_url, 2_000),
    changedFiles: numberValue(mr.changes_count),
    additions: numberValue(mr.additions),
    deletions: numberValue(mr.deletions),
  }
}

function buildCliDiffManifest(
  rawChanges: unknown[],
  options: {
    maxFiles?: number
    maxBytes?: number
    overflow?: boolean
    diffRefs?: Record<string, unknown>
  },
): GitLabDiffManifest {
  const maxFiles = boundedInteger(options.maxFiles, 20, 1, 24)
  const maxBytes = boundedInteger(options.maxBytes, 24_000, 1, 32_000)
  const normalizedChanges = rawChanges
    .slice(0, 48)
    .flatMap((change) => {
      const normalized = normalizeRawChange(change)
      return normalized ? [normalized] : []
    })
  const response: GitLabRawChangesResponse = {
    changes: normalizedChanges,
    overflow: options.overflow,
    diff_refs: options.diffRefs
      ? {
          base_sha: exactBoundedStringValue(options.diffRefs.base_sha, 64),
          start_sha: exactBoundedStringValue(options.diffRefs.start_sha, 64),
          head_sha: exactBoundedStringValue(options.diffRefs.head_sha, 64),
        }
      : undefined,
  }
  const manifest = buildGitLabDiffManifest(response, {
    maxFiles,
    maxDiffBytes: maxBytes,
    blockOnOverflow: false,
  })
  const omittedCount = rawChanges.length - normalizedChanges.length
  if (omittedCount > 0) {
    manifest.skipped.push({
      path: `[${omittedCount} additional changed file(s) omitted]`,
      reason: 'budget-exceeded',
    })
    manifest.stats.fileCount = rawChanges.length
    manifest.stats.skippedFileCount = Math.max(0, rawChanges.length - manifest.stats.includedFileCount)
    manifest.stats.truncated = true
  }
  if (options.overflow) {
    manifest.skipped.push({
      path: '[additional changed files omitted by GitLab]',
      reason: 'too-large',
    })
    manifest.stats.skippedFileCount = Math.max(
      manifest.stats.skippedFileCount,
      rawChanges.length - manifest.stats.includedFileCount,
    ) + 1
    manifest.stats.truncated = true
  }
  return manifest
}

function normalizeRawChange(input: unknown): GitLabRawChange | undefined {
  const change = recordOrUndefined(input)
  if (!change) return undefined
  const rawOldPath = stringValue(change.old_path)
  const rawNewPath = stringValue(change.new_path)
  const exactOldPath = exactBoundedStringValue(change.old_path, 256)
  const exactNewPath = exactBoundedStringValue(change.new_path, 256)
  if ((rawOldPath && !exactOldPath) || (rawNewPath && !exactNewPath)) return undefined
  const oldPath = exactOldPath ?? exactNewPath
  const newPath = exactNewPath ?? exactOldPath
  if (!oldPath || !newPath) return undefined
  return {
    old_path: oldPath,
    new_path: newPath,
    diff: typeof change.diff === 'string' ? change.diff : undefined,
    new_file: change.new_file === true,
    renamed_file: change.renamed_file === true,
    deleted_file: change.deleted_file === true,
    generated_file: change.generated_file === true,
    collapsed: change.collapsed === true,
    too_large: change.too_large === true,
    overflow: change.overflow === true,
  }
}

function decodeGitLabFileContent(file: Record<string, unknown>) {
  const content = stringValue(file.content)
  if (!content) return ''
  if (file.encoding === 'base64') {
    return Buffer.from(content, 'base64').toString('utf8')
  }
  return content
}

function parseJson(output: string, command: string) {
  try {
    return JSON.parse(output)
  } catch {
    throw new ToolError('invalid_output', 'GitLab CLI returned non-JSON output.', command)
  }
}

function recordValue(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>
  throw new ToolError('invalid_output', 'GitLab CLI returned an unexpected JSON object.', undefined)
}

function recordOrUndefined(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function arrayValue(input: unknown): unknown[] {
  if (Array.isArray(input)) return input
  throw new ToolError('invalid_output', 'GitLab CLI returned an unexpected JSON array.', undefined)
}

function diffCoverage(
  included: number,
  skipped: number,
  blocked?: boolean,
  options: { additionalCommitFiles?: boolean; gitLabDiffLimited?: boolean; maxFiles?: number } = {},
) {
  if (blocked) return 'Diff review context is blocked because GitLab reported overflow or configured limits were exceeded.'
  const lines = [options.additionalCommitFiles
    ? `Included ${included} changed file(s); skipped at least ${skipped}.`
    : `Included ${included} changed file(s); skipped ${skipped}.`]
  if (options.additionalCommitFiles) {
    lines.push(`Additional commit diff files were omitted after the local ${options.maxFiles}-file limit.`)
  }
  if (options.gitLabDiffLimited) {
    lines.push('GitLab diff limits omitted content for one or more commit files.')
  }
  return lines.join(' ')
}

function repositoryHealthCoverage(input: {
  projectPath: string
  ref?: string
  candidateCount: number
  includedCount: number
  skippedCount: number
  usedBytes: number
  maxBytes: number
  rootTreeTruncated: boolean
}) {
  const lines = [
    `Read ${input.includedCount}/${input.candidateCount} important file preview(s) from ${input.projectPath}${input.ref ? ` at ${input.ref}` : ''}.`,
    `Skipped ${input.skippedCount}.`,
    `Byte budget used ${input.usedBytes}/${input.maxBytes}.`,
  ]
  if (input.rootTreeTruncated) lines.push('Root tree was truncated to 60 entries.')
  return lines.join(' ')
}

function safeCommand(args: string[]) {
  const sanitized: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      sanitized.push(redactRawField(arg))
      redactNext = false
      continue
    }
    sanitized.push(arg)
    if (arg === '--raw-field' || arg === '-f' || arg === '--field' || arg === '-F') {
      redactNext = true
    }
  }
  return ['glab', ...sanitized].join(' ')
}

function trimError(input: string) {
  const sanitized = sanitizeGitLabSecrets(input, {
    maxInputCodeUnits: 4_000,
    maxInputUtf8Bytes: 8_000,
    maxOutputCodeUnits: 500,
    maxOutputUtf8Bytes: 1_000,
  })
  return truncateUtf8(sanitized.replace(/\s+/g, ' ').trim(), 500)
}

function redactRawField(input: string) {
  const index = input.indexOf('=')
  if (index < 0) return '<redacted>'
  const key = input.slice(0, index)
  const value = input.slice(index + 1)
  return `${key}=<redacted length=${value.length}>`
}

function previewText(input: string) {
  const normalized = sanitizeGitLabSecrets(input).replace(/\s+/g, ' ').trim()
  const preview = truncateUtf8(normalized, 500)
  return preview === normalized ? preview : `${preview}...`
}

function isAuthenticationFailure(input: string) {
  return /(?:\b401\b|\bunauthorized\b|not authenticated|authentication required|glab auth login|no authentication token)/i.test(input)
}

function isImportantRootFile(path: string) {
  return [
    /^readme(\.|$)/i,
    /^package\.json$/i,
    /^pnpm-lock\.yaml$/i,
    /^bun\.lockb?$/i,
    /^yarn\.lock$/i,
    /^package-lock\.json$/i,
    /^\.gitlab-ci\.ya?ml$/i,
    /^dockerfile$/i,
    /^docker-compose\.ya?ml$/i,
    /^tsconfig\.json$/i,
    /^vite\.config\./i,
  ].some((pattern) => pattern.test(path))
}

function importantFileReason(path: string) {
  if (/^readme(\.|$)/i.test(path)) return 'project overview'
  if (/^\.gitlab-ci\.ya?ml$/i.test(path)) return 'GitLab CI configuration'
  if (/package|lock|tsconfig|vite|docker/i.test(path)) return 'build/dependency/runtime configuration'
  return 'user requested'
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function boundedStringValue(input: unknown, maxBytes: number) {
  const value = stringValue(input)
  return value === undefined ? undefined : truncateUtf8(value, maxBytes)
}

function exactBoundedStringValue(input: unknown, maxBytes: number) {
  const value = stringValue(input)
  if (value === undefined || Buffer.byteLength(value, 'utf8') > maxBytes) return undefined
  return value
}

function numberValue(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && input.trim() && Number.isFinite(Number(input))) return Number(input)
  return undefined
}

function boundedInteger(input: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (input === undefined) return fallback
  if (!Number.isSafeInteger(input)) return fallback
  return Math.min(maximum, Math.max(minimum, input))
}

export function assertValidGitLabTarget(target: GitLabTarget) {
  if (!validProjectPath(target.projectPath)) {
    throw new ToolError('invalid_input', 'GitLab project path is invalid.')
  }
  if (target.host && !validHost(target.host)) {
    throw new ToolError('invalid_input', 'GitLab host is invalid.')
  }
  if (target.kind === 'merge_request' && !/^[1-9]\d*$/.test(target.iid)) {
    throw new ToolError('invalid_input', 'GitLab merge request IID is invalid.')
  }
  if (target.kind === 'commit' && !/^[0-9a-f]{6,64}$/i.test(target.sha)) {
    throw new ToolError('invalid_input', 'GitLab commit SHA is invalid.')
  }
}

function validProjectPath(input: string) {
  if (input.length > 512) return false
  if (/^\d+$/.test(input)) return true
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(input)) return false
  return input.split('/').every((segment) => segment !== '.' && segment !== '..')
}

function validHost(input: string) {
  if (!input || input.length > 255 || input.startsWith('-') || /[\s/?#@]/.test(input)) return false
  try {
    const url = new URL(`https://${input}`)
    if (url.host.toLowerCase() !== input.toLowerCase()) return false
    return /^\[[0-9a-f:.]+\]$/i.test(url.hostname)
      || /^[A-Za-z0-9._-]+$/.test(url.hostname)
  } catch {
    return false
  }
}

export function assertValidGitLabReviewBody(body: string) {
  const bytes = Buffer.byteLength(body, 'utf8')
  if (!body.trim() || bytes > 20_000) {
    throw new ToolError('invalid_input', 'GitLab review body must contain between 1 and 20000 UTF-8 bytes.')
  }
}

export function assertValidGitLabInlinePosition(position: PublishReviewDiscussionInput['position']) {
  if (position.position_type !== 'text') {
    throw new ToolError('invalid_input', 'GitLab inline position type must be text.')
  }
  for (const path of [position.old_path, position.new_path]) {
    if (!path || path.length > 1_024 || /[\u0000-\u001F\u007F]/.test(path)) {
      throw new ToolError('invalid_input', 'GitLab inline position path is invalid.')
    }
  }
  const lines = [position.old_line, position.new_line].filter((line) => line !== undefined)
  if (lines.length === 0 || lines.some((line) => !Number.isSafeInteger(line) || Number(line) <= 0)) {
    throw new ToolError('invalid_input', 'GitLab inline position requires a positive old or new line.')
  }
}
