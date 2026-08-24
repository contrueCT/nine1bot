import type {
  AnyPlatformToolDefinition,
  PlatformToolAvailability,
  PlatformToolCallContext,
  PlatformToolResult,
} from '@nine1bot/platform-protocol'
import { sanitizeGitLabSecrets } from '../review/sanitizer'
import type { GitLabInlinePosition } from '../review/types'
import {
  assertValidGitLabInlinePosition,
  assertValidGitLabReviewBody,
  assertValidGitLabTarget,
  createGitLabCliClient,
} from './client'
import { getGitLabCliStatus } from './glab'
import { resolveGitLabTarget } from './target-resolver'
import {
  GitLabCliToolError,
  type GitLabBoundedDiff,
  type GitLabCliRunner,
  type GitLabCliStatus,
  type GitLabTarget,
} from './types'

export const gitLabCliToolIds = {
  status: 'gitlab_cli_status',
  resolveTarget: 'gitlab_cli_resolve_target',
  projectSnapshot: 'gitlab_cli_project_snapshot',
  mrSnapshot: 'gitlab_cli_mr_snapshot',
  mrDiff: 'gitlab_cli_mr_diff',
  commitDiff: 'gitlab_cli_commit_diff',
  repositoryHealthContext: 'gitlab_cli_repository_health_context',
  publishReviewNote: 'gitlab_cli_publish_review_note',
  publishReviewDiscussion: 'gitlab_cli_publish_review_discussion',
} as const

const defaultDiffFiles = 20
const maxDiffFiles = 24
const defaultDiffBytes = 24_000
const maxDiffBytes = 32_000
const defaultRepositoryFiles = 8
const maxRepositoryFiles = 24
const defaultRepositoryBytes = 16_000
const maxRepositoryBytes = 24_000

export type GitLabCliPlatformToolsOptions = {
  runner?: GitLabCliRunner
  statusCacheTtlMs?: number
  allowedHosts?: string[]
  allowedHostsInvalid?: boolean
}

export function createGitLabCliPlatformTools(
  options: GitLabCliPlatformToolsOptions = {},
): AnyPlatformToolDefinition[] {
  const statusProbe = createStatusProbe(options)
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts)
  const denyAllHosts = options.allowedHostsInvalid === true
  const cliAvailability = (ctx: { directory: string }) => statusProbe.availability(ctx.directory)

  return [
    {
      id: gitLabCliToolIds.status,
      description: 'Check whether the local GitLab CLI is installed and authenticated. This is diagnostic and read-only.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({}),
      parse(input) {
        strictRecord(input, [])
        return {}
      },
      permission: () => permission(gitLabCliToolIds.status, 'status'),
      availability: () => availableNow(),
      execution: { timeoutMs: 30_000 },
      async execute(_input, ctx) {
        return await safeResult(async () => {
          const status = await statusProbe.get(ctx.directory, ctx.signal, { force: true })
          return okResult('GitLab CLI status', status)
        })
      },
    },
    {
      id: gitLabCliToolIds.resolveTarget,
      description: 'Resolve a GitLab project, merge request, or commit target from bounded text, URL, or page context. This is read-only.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({
        text: { type: 'string', maxLength: 4_000 },
        url: { type: 'string', maxLength: 2_000 },
        page: { type: 'object' },
      }),
      parse(input) {
        const record = strictRecord(input, ['text', 'url', 'page'])
        return {
          text: optionalString(record.text, 'text', 4_000),
          url: optionalString(record.url, 'url', 2_000),
          page: optionalPage(record.page),
        }
      },
      permission: () => permission(gitLabCliToolIds.resolveTarget, 'resolve'),
      availability: () => availableNow(),
      execution: { timeoutMs: 5_000 },
      async execute(input) {
        const target = resolveGitLabTarget(input)
        if (!target) {
          return failure('failed', 'gitlab-target-not-found', 'Could not resolve a GitLab target from the supplied context.', true)
        }
        try {
          assertValidGitLabTarget(target)
        } catch {
          return failure('failed', 'gitlab-target-invalid', 'The resolved GitLab target is invalid.', false)
        }
        try {
          assertAllowedHost(target, allowedHosts, denyAllHosts)
        } catch {
          return failure('failed', 'gitlab-target-not-allowed', 'The resolved GitLab host is outside the configured allowlist.', false)
        }
        return okResult('GitLab target resolved', { target })
      },
    },
    {
      id: gitLabCliToolIds.projectSnapshot,
      description: 'Load a bounded GitLab project metadata snapshot through the authenticated GitLab CLI. This is read-only.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({ target: projectTargetSchema }, ['target']),
      parse(input) {
        const record = strictRecord(input, ['target'])
        return { target: parseTarget(record.target, 'project', allowedHosts, denyAllHosts) }
      },
      permission: (input) => permission('gitlab_cli_read', targetPattern(input.target)),
      availability: cliAvailability,
      execution: { timeoutMs: 60_000 },
      execute: (input, ctx) => withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab project snapshot', (client) => (
        client.projectSnapshot(input.target)
      )),
    },
    {
      id: gitLabCliToolIds.mrSnapshot,
      description: 'Load bounded GitLab merge request metadata through the authenticated GitLab CLI. This is read-only.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({ target: mergeRequestTargetSchema }, ['target']),
      parse(input) {
        const record = strictRecord(input, ['target'])
        return { target: parseTarget(record.target, 'merge_request', allowedHosts, denyAllHosts) }
      },
      permission: (input) => permission('gitlab_cli_read', targetPattern(input.target)),
      availability: cliAvailability,
      execution: { timeoutMs: 60_000 },
      execute: (input, ctx) => withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab merge request snapshot', (client) => (
        client.mrSnapshot(input.target)
      )),
    },
    {
      id: gitLabCliToolIds.mrDiff,
      description: 'Load a bounded GitLab merge request diff. Raw diff text is omitted by default and requires includeDiff=true.',
      catalogVisibility: 'declared-only',
      inputSchema: diffInputSchema(mergeRequestTargetSchema),
      parse(input) {
        const record = strictRecord(input, ['target', 'maxFiles', 'maxBytes', 'includeDiff'])
        return {
          target: parseTarget(record.target, 'merge_request', allowedHosts, denyAllHosts),
          maxFiles: optionalInteger(record.maxFiles, 'maxFiles', 1, maxDiffFiles) ?? defaultDiffFiles,
          maxBytes: optionalInteger(record.maxBytes, 'maxBytes', 1, maxDiffBytes) ?? defaultDiffBytes,
          includeDiff: optionalBoolean(record.includeDiff, 'includeDiff') ?? false,
        }
      },
      permission: (input) => permission('gitlab_cli_read', targetPattern(input.target)),
      availability: cliAvailability,
      execution: { timeoutMs: 90_000 },
      execute: (input, ctx) => withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab merge request diff', async (client) => (
        summarizeDiff(await client.mrDiff(input), input.includeDiff)
      )),
    },
    {
      id: gitLabCliToolIds.commitDiff,
      description: 'Load a bounded GitLab commit diff. Raw diff text is omitted by default and requires includeDiff=true.',
      catalogVisibility: 'declared-only',
      inputSchema: diffInputSchema(commitTargetSchema),
      parse(input) {
        const record = strictRecord(input, ['target', 'maxFiles', 'maxBytes', 'includeDiff'])
        return {
          target: parseTarget(record.target, 'commit', allowedHosts, denyAllHosts),
          maxFiles: optionalInteger(record.maxFiles, 'maxFiles', 1, maxDiffFiles) ?? defaultDiffFiles,
          maxBytes: optionalInteger(record.maxBytes, 'maxBytes', 1, maxDiffBytes) ?? defaultDiffBytes,
          includeDiff: optionalBoolean(record.includeDiff, 'includeDiff') ?? false,
        }
      },
      permission: (input) => permission('gitlab_cli_read', targetPattern(input.target)),
      availability: cliAvailability,
      execution: { timeoutMs: 90_000 },
      execute: (input, ctx) => withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab commit diff', async (client) => (
        summarizeDiff(await client.commitDiff(input), input.includeDiff)
      )),
    },
    {
      id: gitLabCliToolIds.repositoryHealthContext,
      description: 'Build bounded repository health context from root metadata and selected important files. This is not a full repository audit.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({
        target: projectTargetSchema,
        ref: { type: 'string', maxLength: 512 },
        maxFiles: { type: 'integer', minimum: 1, maximum: maxRepositoryFiles },
        maxBytes: { type: 'integer', minimum: 1, maximum: maxRepositoryBytes },
        paths: {
          type: 'array',
          maxItems: maxRepositoryFiles,
          items: { type: 'string', maxLength: 1_024 },
        },
      }, ['target']),
      parse(input) {
        const record = strictRecord(input, ['target', 'ref', 'maxFiles', 'maxBytes', 'paths'])
        return {
          target: parseTarget(record.target, 'project', allowedHosts, denyAllHosts),
          ref: optionalString(record.ref, 'ref', 512),
          maxFiles: optionalInteger(record.maxFiles, 'maxFiles', 1, maxRepositoryFiles) ?? defaultRepositoryFiles,
          maxBytes: optionalInteger(record.maxBytes, 'maxBytes', 1, maxRepositoryBytes) ?? defaultRepositoryBytes,
          paths: optionalStringArray(record.paths, 'paths', maxRepositoryFiles, 1_024),
        }
      },
      permission: (input) => permission('gitlab_cli_read', targetPattern(input.target)),
      availability: cliAvailability,
      execution: { timeoutMs: 90_000 },
      execute: (input, ctx) => withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab repository health context', (client) => (
        client.repositoryHealthContext(input)
      )),
    },
    {
      id: gitLabCliToolIds.publishReviewNote,
      description: 'Preview or publish a GitLab merge request or commit review note. Non-dry-run execution is a permission-gated write.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({
        target: { oneOf: [mergeRequestTargetSchema, commitTargetSchema] },
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
        dryRun: { type: 'boolean' },
      }, ['target', 'body']),
      parse(input) {
        const record = strictRecord(input, ['target', 'body', 'dryRun'])
        const target = parseReviewTarget(record.target, allowedHosts, denyAllHosts)
        const body = requiredString(record.body, 'body', 20_000)
        assertValidGitLabReviewBody(body)
        return {
          target,
          body,
          dryRun: optionalBoolean(record.dryRun, 'dryRun') ?? false,
        }
      },
      permission: (input) => permission(
        input.dryRun ? 'gitlab_cli_preview' : gitLabCliToolIds.publishReviewNote,
        targetPattern(input.target),
      ),
      availability: () => availableNow(),
      execution: { timeoutMs: 60_000 },
      execute: (input, ctx) => input.dryRun
        ? withoutCliStatus(options, ctx, 'GitLab review note preview', (client) => client.publishReviewNote(input))
        : withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab review note published', (client) => client.publishReviewNote(input), true),
    },
    {
      id: gitLabCliToolIds.publishReviewDiscussion,
      description: 'Preview or publish a GitLab merge request inline discussion at a precomputed text position. Non-dry-run execution is a permission-gated write.',
      catalogVisibility: 'declared-only',
      inputSchema: objectSchema({
        target: mergeRequestTargetSchema,
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
        position: inlinePositionSchema,
        dryRun: { type: 'boolean' },
      }, ['target', 'body', 'position']),
      parse(input) {
        const record = strictRecord(input, ['target', 'body', 'position', 'dryRun'])
        const body = requiredString(record.body, 'body', 20_000)
        const position = parseInlinePosition(record.position)
        assertValidGitLabReviewBody(body)
        assertValidGitLabInlinePosition(position)
        return {
          target: parseTarget(record.target, 'merge_request', allowedHosts, denyAllHosts),
          body,
          position,
          dryRun: optionalBoolean(record.dryRun, 'dryRun') ?? false,
        }
      },
      permission: (input) => permission(
        input.dryRun ? 'gitlab_cli_preview' : gitLabCliToolIds.publishReviewDiscussion,
        targetPattern(input.target),
      ),
      availability: () => availableNow(),
      execution: { timeoutMs: 60_000 },
      execute: (input, ctx) => input.dryRun
        ? withoutCliStatus(options, ctx, 'GitLab inline discussion preview', (client) => client.publishReviewDiscussion(input))
        : withAuthenticatedCli(options, statusProbe, ctx, input.target.host, 'GitLab inline discussion published', (client) => client.publishReviewDiscussion(input), true),
    },
  ]
}

type StatusProbe = ReturnType<typeof createStatusProbe>

function createStatusProbe(options: GitLabCliPlatformToolsOptions) {
  const ttlMs = Math.max(0, options.statusCacheTtlMs ?? 10_000)
  const cache = new Map<string, { status: GitLabCliStatus; checkedAt: number }>()

  return {
    availability(directory: string): PlatformToolAvailability {
      const cached = cache.get(statusCacheKey(directory))
      if (!cached || Date.now() - cached.checkedAt > ttlMs) {
        return { status: 'unknown', reason: 'GitLab CLI status is checked when the wrapper is invoked.' }
      }
      return availabilityFromStatus(cached.status, cached.checkedAt)
    },
    async get(
      directory: string,
      signal: AbortSignal,
      request: { host?: string; force?: boolean } = {},
    ) {
      if (signal.aborted) throw new GitLabCliToolError('command_cancelled', 'GitLab CLI command was cancelled.')
      const key = statusCacheKey(directory, request.host)
      const cached = cache.get(key)
      if (!request.force && cached && Date.now() - cached.checkedAt <= ttlMs) return cached.status
      const status = await getGitLabCliStatus({
        runner: options.runner,
        cwd: directory,
        host: request.host,
        signal,
        timeoutMs: 10_000,
      })
      if (signal.aborted) throw new GitLabCliToolError('command_cancelled', 'GitLab CLI command was cancelled.')
      cache.set(key, { status, checkedAt: Date.now() })
      return status
    },
  }
}

async function withAuthenticatedCli<T>(
  options: GitLabCliPlatformToolsOptions,
  statusProbe: StatusProbe,
  ctx: PlatformToolCallContext,
  host: string | undefined,
  title: string,
  task: (client: ReturnType<typeof createGitLabCliClient>) => Promise<T>,
  write = false,
): Promise<PlatformToolResult> {
  return await safeResult(async () => {
    const status = await statusProbe.get(ctx.directory, ctx.signal, { host })
    if (!status.available) {
      return failure('unavailable', 'gitlab-cli-not-installed', status.message, true, {
        type: 'retry',
        label: 'Retry after installing GitLab CLI',
      })
    }
    if (!status.authenticated) {
      return failure('auth-required', 'gitlab-cli-auth-required', status.message, true, {
        type: 'retry',
        label: 'Retry after GitLab CLI login',
      })
    }
    const client = createGitLabCliClient({
      runner: options.runner,
      cwd: ctx.directory,
      signal: ctx.signal,
    })
    return okResult(title, await task(client))
  }, { write })
}

function statusCacheKey(directory: string, host?: string) {
  return JSON.stringify([directory, host?.toLowerCase() ?? null])
}

async function withoutCliStatus<T>(
  options: GitLabCliPlatformToolsOptions,
  ctx: PlatformToolCallContext,
  title: string,
  task: (client: ReturnType<typeof createGitLabCliClient>) => Promise<T>,
): Promise<PlatformToolResult> {
  return await safeResult(async () => {
    if (ctx.signal.aborted) throw new GitLabCliToolError('command_cancelled', 'GitLab CLI command was cancelled.')
    const client = createGitLabCliClient({
      runner: options.runner,
      cwd: ctx.directory,
      signal: ctx.signal,
    })
    return okResult(title, await task(client))
  })
}

async function safeResult(
  task: () => Promise<PlatformToolResult>,
  options: { write?: boolean } = {},
): Promise<PlatformToolResult> {
  try {
    return await task()
  } catch (error) {
    if (error instanceof GitLabCliToolError) return cliFailure(error, options.write === true)
    if (options.write) {
      return uncertainWriteFailure()
    }
    return failure('failed', 'gitlab-cli-execution-failed', 'GitLab CLI wrapper execution failed.', false)
  }
}

function cliFailure(error: GitLabCliToolError, write = false): PlatformToolResult {
  if (write && ['command_cancelled', 'command_failed', 'invalid_output', 'output_too_large'].includes(error.code)) {
    return uncertainWriteFailure()
  }
  const message = safeMessage(error.message)
  switch (error.code) {
    case 'glab_not_installed':
      return failure('unavailable', 'gitlab-cli-not-installed', message, true)
    case 'glab_not_authenticated':
      return failure('auth-required', 'gitlab-cli-auth-required', message, true)
    case 'command_cancelled':
      return failure('failed', 'gitlab-cli-command-cancelled', message, true)
    case 'invalid_input':
      return failure('failed', 'gitlab-cli-invalid-input', message, true)
    case 'invalid_output':
      return failure('failed', 'gitlab-cli-invalid-output', message, true)
    case 'output_too_large':
      return failure('failed', 'gitlab-cli-output-too-large', message, true)
    case 'target_not_found':
      return failure('failed', 'gitlab-target-not-found', message, true)
    default:
      return failure('failed', 'gitlab-cli-command-failed', message, true)
  }
}

function uncertainWriteFailure(): PlatformToolResult {
  return failure(
    'failed',
    'gitlab-cli-write-outcome-uncertain',
    'The GitLab write did not return a confirmed result. Do not retry automatically; verify the target first.',
    false,
  )
}

function okResult(title: string, data: unknown): PlatformToolResult {
  return {
    status: 'ok',
    title,
    output: JSON.stringify({ ok: true, data }, null, 2),
  }
}

function failure(
  status: 'failed' | 'unavailable' | 'auth-required',
  code: string,
  message: string,
  recoverable: boolean,
  action?: PlatformToolAvailability['action'],
): PlatformToolResult {
  return {
    status,
    code,
    message: safeMessage(message),
    recoverable,
    ...(action ? { action } : {}),
  }
}

function safeMessage(input: string) {
  return sanitizeGitLabSecrets(input, {
    maxInputCodeUnits: 2_000,
    maxInputUtf8Bytes: 4_000,
    maxOutputCodeUnits: 500,
    maxOutputUtf8Bytes: 1_000,
  }).replace(/\s+/g, ' ').trim() || 'GitLab CLI wrapper execution failed.'
}

function summarizeDiff(diff: GitLabBoundedDiff, includeDiff: boolean) {
  if (includeDiff) return diff
  return {
    ...diff,
    manifest: {
      ...diff.manifest,
      files: diff.manifest.files.map(({ diff: rawDiff, ...file }) => ({
        ...file,
        diffBytes: Buffer.byteLength(rawDiff, 'utf8'),
        hunkCount: (rawDiff.match(/^@@/gm) ?? []).length,
      })),
    },
    diffSummary: {
      rawDiffIncluded: false,
      instruction: 'Call this wrapper again with includeDiff=true only after confirming the target and review scope.',
    },
  }
}

function permission(permissionName: string, pattern: string) {
  return { permission: permissionName, patterns: [pattern] }
}

function targetPattern(target: GitLabTarget) {
  const host = target.host ?? 'gitlab'
  if (target.kind === 'merge_request') return `${host}:${target.projectPath}!${target.iid}`
  if (target.kind === 'commit') return `${host}:${target.projectPath}@${target.sha}`
  return `${host}:${target.projectPath}`
}

function availabilityFromStatus(status: GitLabCliStatus, checkedAt: number): PlatformToolAvailability {
  if (!status.available) {
    return { status: 'unavailable', reason: status.message, checkedAt, action: { type: 'retry', label: 'Retry GitLab CLI detection' } }
  }
  if (!status.authenticated) {
    return { status: 'auth-required', reason: status.message, checkedAt, action: { type: 'retry', label: 'Retry after GitLab CLI login' } }
  }
  return { status: 'available', reason: status.message, checkedAt }
}

function availableNow(): PlatformToolAvailability {
  return { status: 'available', checkedAt: Date.now() }
}

function parseTarget<K extends GitLabTarget['kind']>(
  input: unknown,
  kind: K,
  allowedHosts: ReadonlySet<string>,
  denyAllHosts = false,
): Extract<GitLabTarget, { kind: K }> {
  const record = strictRecord(input, kind === 'project'
    ? ['kind', 'host', 'projectPath']
    : kind === 'merge_request'
      ? ['kind', 'host', 'projectPath', 'iid']
      : ['kind', 'host', 'projectPath', 'sha'])
  if (record.kind !== kind) throw new Error(`target.kind must be ${kind}`)
  const target = {
    kind,
    host: requiredString(record.host, 'target.host', 255),
    projectPath: requiredString(record.projectPath, 'target.projectPath', 512),
    ...(kind === 'merge_request' ? { iid: requiredString(record.iid, 'target.iid', 32) } : {}),
    ...(kind === 'commit' ? { sha: requiredString(record.sha, 'target.sha', 64) } : {}),
  } as Extract<GitLabTarget, { kind: K }>
  assertValidGitLabTarget(target)
  assertAllowedHost(target, allowedHosts, denyAllHosts)
  return target
}

function parseReviewTarget(
  input: unknown,
  allowedHosts: ReadonlySet<string>,
  denyAllHosts = false,
): Extract<GitLabTarget, { kind: 'merge_request' | 'commit' }> {
  const record = recordOnly(input)
  if (record.kind === 'merge_request') return parseTarget(input, 'merge_request', allowedHosts, denyAllHosts)
  if (record.kind === 'commit') return parseTarget(input, 'commit', allowedHosts, denyAllHosts)
  throw new Error('target.kind must be merge_request or commit')
}

function normalizeAllowedHosts(input: string[] | undefined) {
  return new Set((input ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))
}

function assertAllowedHost(target: GitLabTarget, allowedHosts: ReadonlySet<string>, denyAllHosts = false) {
  if (denyAllHosts) throw new Error('GitLab host allowlist configuration is invalid')
  if (allowedHosts.size === 0) return
  if (!target.host || !allowedHosts.has(target.host.toLowerCase())) {
    throw new Error('GitLab target host is outside the configured allowlist')
  }
}

function parseInlinePosition(input: unknown): GitLabInlinePosition {
  const record = strictRecord(input, [
    'position_type',
    'base_sha',
    'start_sha',
    'head_sha',
    'old_path',
    'new_path',
    'old_line',
    'new_line',
  ])
  if (record.position_type !== 'text') throw new Error('position.position_type must be text')
  return {
    position_type: 'text',
    base_sha: optionalString(record.base_sha, 'position.base_sha', 64),
    start_sha: optionalString(record.start_sha, 'position.start_sha', 64),
    head_sha: optionalString(record.head_sha, 'position.head_sha', 64),
    old_path: requiredString(record.old_path, 'position.old_path', 1_024),
    new_path: requiredString(record.new_path, 'position.new_path', 1_024),
    old_line: optionalInteger(record.old_line, 'position.old_line', 1, Number.MAX_SAFE_INTEGER),
    new_line: optionalInteger(record.new_line, 'position.new_line', 1, Number.MAX_SAFE_INTEGER),
  }
}

function strictRecord(input: unknown, allowedKeys: string[]) {
  const record = recordOnly(input)
  const allowed = new Set(allowedKeys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('input contains unsupported fields')
  return record
}

function recordOnly(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object')
  return input as Record<string, unknown>
}

function requiredString(input: unknown, field: string, maxLength: number) {
  if (typeof input !== 'string' || !input.trim() || input.length > maxLength || /\u0000/.test(input)) {
    throw new Error(`${field} is invalid`)
  }
  return input
}

function optionalString(input: unknown, field: string, maxLength: number) {
  if (input === undefined) return undefined
  return requiredString(input, field, maxLength)
}

function optionalBoolean(input: unknown, field: string) {
  if (input === undefined) return undefined
  if (typeof input !== 'boolean') throw new Error(`${field} must be boolean`)
  return input
}

function optionalInteger(input: unknown, field: string, minimum: number, maximum: number) {
  if (input === undefined) return undefined
  if (!Number.isSafeInteger(input) || Number(input) < minimum || Number(input) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(input)
}

function optionalStringArray(input: unknown, field: string, maxItems: number, maxLength: number) {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.length > maxItems) throw new Error(`${field} is invalid`)
  return input.map((item, index) => requiredString(item, `${field}[${index}]`, maxLength))
}

function optionalPage(input: unknown) {
  if (input === undefined) return undefined
  const page = recordOnly(input)
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 16_000) throw new Error('page context is too large')
  return page
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function diffInputSchema(target: Record<string, unknown>) {
  return objectSchema({
    target,
    maxFiles: { type: 'integer', minimum: 1, maximum: maxDiffFiles },
    maxBytes: { type: 'integer', minimum: 1, maximum: maxDiffBytes },
    includeDiff: { type: 'boolean' },
  }, ['target'])
}

const projectTargetSchema = objectSchema({
  kind: { const: 'project' },
  host: { type: 'string', maxLength: 255 },
  projectPath: { type: 'string', maxLength: 512 },
}, ['kind', 'host', 'projectPath'])

const mergeRequestTargetSchema = objectSchema({
  kind: { const: 'merge_request' },
  host: { type: 'string', maxLength: 255 },
  projectPath: { type: 'string', maxLength: 512 },
  iid: { type: 'string', pattern: '^[1-9]\\d*$' },
}, ['kind', 'host', 'projectPath', 'iid'])

const commitTargetSchema = objectSchema({
  kind: { const: 'commit' },
  host: { type: 'string', maxLength: 255 },
  projectPath: { type: 'string', maxLength: 512 },
  sha: { type: 'string', pattern: '^[0-9a-fA-F]{6,64}$' },
}, ['kind', 'host', 'projectPath', 'sha'])

const inlinePositionSchema = objectSchema({
  position_type: { const: 'text' },
  base_sha: { type: 'string', maxLength: 64 },
  start_sha: { type: 'string', maxLength: 64 },
  head_sha: { type: 'string', maxLength: 64 },
  old_path: { type: 'string', maxLength: 1_024 },
  new_path: { type: 'string', maxLength: 1_024 },
  old_line: { type: 'integer', minimum: 1 },
  new_line: { type: 'integer', minimum: 1 },
}, ['position_type', 'old_path', 'new_path'])
