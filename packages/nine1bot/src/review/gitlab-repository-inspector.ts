import {
  decideGitLabReviewPathAccess,
  GitLabApiClient,
  GitLabApiError,
  normalizeGitLabAuthority,
  normalizeGitLabReviewSettings,
  resolveGitLabApiBaseUrl,
  type GitLabRepositoryTreeEntry,
} from '@nine1bot/platform-gitlab/review'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import type { PlatformManagerConfig } from '../platform/manager'
import {
  ReviewRunStore,
  type ReviewRunIdentity,
  type ReviewRunRecord,
} from './run-store'

export type GitLabRepositorySessionRequest =
  | {
      action: 'read_file'
      path: string
      startLine?: number
      maxLines?: number
    }
  | {
      action: 'search_text'
      query: string
      pathPrefix?: string
    }

type GitLabRepositoryMatch = {
  path: string
  line: number
  text: string
}

export type GitLabRepositoryToolOutput =
  | {
      ok: true
      action: 'read_file'
      headSha: string
      path: string
      content: string
      startLine: number
      endLine: number
      bytes: number
      truncated: boolean
      diagnostics: string[]
    }
  | {
      ok: true
      action: 'search_text'
      headSha: string
      query: string
      pathPrefix?: string
      matches: GitLabRepositoryMatch[]
      bytes: number
      truncated: boolean
      diagnostics: string[]
    }
  | {
      ok: false
      action: GitLabRepositorySessionRequest['action']
      diagnostic: string
    }

type GitLabRepositoryTarget = {
  host: string
  projectId: string | number
  headSha: string
}

const MAX_REPOSITORY_QUERIES = 12
const MAX_REPOSITORY_OUTPUT_BYTES = 128 * 1024
const MAX_REPOSITORY_API_REQUESTS = 64
const MAX_REPOSITORY_FILE_FETCHES = 48
const MAX_REPOSITORY_FETCHED_BYTES = 2 * 1024 * 1024
const MAX_REPOSITORY_SEARCH_DURATION_MS = 30_000
const MAX_TOOL_CONTENT_BYTES = 20 * 1024
const MAX_FILE_BLOB_BYTES = 256 * 1024
const MAX_READ_LINES = 200
const DEFAULT_READ_LINES = 120
const MAX_SEARCH_MATCHES = 50
const MAX_SEARCH_MATCH_TEXT_BYTES = 2 * 1024
const MAX_SEARCH_TREE_ENTRIES = 200
const MAX_SEARCH_PRIORITY_PREFIXES = 4
const MAX_SEARCH_PRIORITY_TREE_ENTRIES = 100
const MAX_SEARCH_FILES = 32
const MAX_SEARCH_FILE_BYTES = 64 * 1024
const MAX_SEARCH_SOURCE_BYTES = 512 * 1024
const MAX_GIT_PATH_BYTES = 1_024
const MAX_SEARCH_QUERY_BYTES = 256

export async function inspectGitLabRepositoryForSession(input: {
  sessionId: string
  request: GitLabRepositorySessionRequest
  platforms: PlatformManagerConfig
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
  signal?: AbortSignal
  searchTimeoutMs?: number
}): Promise<GitLabRepositoryToolOutput> {
  const action = input.request.action
  const run = ReviewRunStore.findBySessionId(input.sessionId)
  if (!run) return failure(action, 'gitlab_review_session_not_bound')
  const identity: ReviewRunIdentity = {
    runId: run.id,
    sessionId: input.sessionId,
    generation: run.generation,
  }
  const lifecycleFailure = repositoryLifecycleFailure(identity, input.signal)
  if (lifecycleFailure) return failure(action, lifecycleFailure)

  const target = repositoryTargetForRun(run)
  if (!target) return failure(action, 'gitlab_review_head_identity_missing')
  if (!projectSnapshotMatches(run, target)) {
    return failure(action, 'gitlab_review_project_snapshot_missing')
  }

  const validatedRequest = validateRequest(input.request, run)
  if (!validatedRequest.ok) return failure(action, validatedRequest.diagnostic)

  const platform = input.platforms.gitlab
  const settings = normalizeGitLabReviewSettings(platform?.settings)
  if (!platform?.enabled || !settings.enabled) {
    return failure(action, 'gitlab_review_not_configured')
  }
  const resolvedBaseUrl = resolveGitLabApiBaseUrl({
    configuredBaseUrl: settings.baseUrl,
    triggerHost: target.host,
  })
  if (!resolvedBaseUrl.ok) return failure(action, resolvedBaseUrl.reason)

  let token: string | undefined
  try {
    token = await resolveSecret(settings.tokenSecretRef, input.secrets)
  } catch (error) {
    const interrupted = repositoryLifecycleFailure(identity, input.signal)
    if (interrupted) return failure(action, interrupted)
    return failure(action, `repository_token_unavailable:${errorName(error)}`)
  }
  const tokenLifecycleFailure = repositoryLifecycleFailure(identity, input.signal)
  if (tokenLifecycleFailure) return failure(action, tokenLifecycleFailure)
  if (!token) return failure(action, 'repository_token_missing')

  const reservation = reserveRepositoryQuery(identity, action)
  if (!reservation.ok) return failure(action, reservation.diagnostic)

  const client = new GitLabApiClient({
    baseUrl: resolvedBaseUrl.baseUrl,
    token,
    fetch: input.fetch,
  })
  if (validatedRequest.request.action === 'read_file') {
    const requestState: GitLabRepositoryRequestState = {}
    const requestGuard = repositoryRequestGuard(identity, input.signal, requestState)
    return await readFrozenFile({
      identity,
      client,
      target,
      request: validatedRequest.request,
      maxOutputBytes: reservation.maxOutputBytes,
      requestGuard,
      requestState,
      signal: input.signal,
    })
  }
  const deadline = repositorySearchDeadline(input.signal, input.searchTimeoutMs)
  const requestState: GitLabRepositoryRequestState = {}
  const requestGuard = repositoryRequestGuard(
    identity,
    deadline.signal,
    requestState,
    deadline.abortDiagnostic,
  )
  try {
    return await searchFrozenRepository({
      identity,
      client,
      target,
      run,
      request: validatedRequest.request,
      maxOutputBytes: reservation.maxOutputBytes,
      requestGuard,
      requestState,
      signal: deadline.signal,
    })
  } finally {
    deadline.dispose()
  }
}

async function readFrozenFile(input: {
  identity: ReviewRunIdentity
  client: GitLabApiClient
  target: GitLabRepositoryTarget
  request: Extract<GitLabRepositorySessionRequest, { action: 'read_file' }>
  maxOutputBytes: number
  requestGuard: () => void
  requestState: GitLabRepositoryRequestState
  signal?: AbortSignal
}): Promise<GitLabRepositoryToolOutput> {
  const requestBudget = repositoryFileRequestBoundary(input.identity, MAX_FILE_BLOB_BYTES + 1)
  let raw
  try {
    raw = await input.client.getRepositoryFileRaw(
      input.target.projectId,
      input.request.path,
      input.target.headSha,
      MAX_FILE_BLOB_BYTES + 1,
      {
        signal: input.signal,
        requestGuard: input.requestGuard,
        beforeRequest: requestBudget.beforeRequest,
      },
    )
  } catch (error) {
    return failure('read_file', repositoryApiDiagnostic('read_file', error, input.requestState, input.identity, input.signal))
  }
  const settlementFailure = settleRepositoryFileRequest(
    input.identity,
    requestBudget.reservedBytes(),
    raw.content.byteLength,
  )
  if (settlementFailure) return failure('read_file', settlementFailure)
  if (raw.truncated || raw.content.byteLength > MAX_FILE_BLOB_BYTES) {
    return failure('read_file', 'repository_file_too_large')
  }
  const source = decodeUtf8(raw.content)
  if (source === undefined || source.includes('\0')) return failure('read_file', 'repository_file_binary')

  const startLine = input.request.startLine ?? 1
  const maxLines = input.request.maxLines ?? DEFAULT_READ_LINES
  const lines = logicalLines(source)
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines)
  let content = selected.join('\n')
  const selectedThroughEnd = startLine - 1 + selected.length >= lines.length
  if (source.endsWith('\n') && selected.length > 0 && selectedThroughEnd) content += '\n'
  const bounded = boundedUtf8Prefix(content, input.maxOutputBytes)
  content = bounded.value
  const returnedLineCount = content.length === 0
    ? 0
    : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  const endLine = returnedLineCount > 0 ? startLine + returnedLineCount - 1 : startLine - 1
  const truncated = startLine > 1 || !selectedThroughEnd || bounded.truncated
  const bytes = utf8Bytes(content)
  const persistenceFailure = recordRepositoryOutput(input.identity, bytes)
  if (persistenceFailure) return failure('read_file', persistenceFailure)

  return {
    ok: true,
    action: 'read_file',
    headSha: input.target.headSha,
    path: input.request.path,
    content,
    startLine,
    endLine,
    bytes,
    truncated,
    diagnostics: truncated ? ['repository_file_output_truncated'] : [],
  }
}

async function searchFrozenRepository(input: {
  identity: ReviewRunIdentity
  client: GitLabApiClient
  target: GitLabRepositoryTarget
  run: ReviewRunRecord
  request: Extract<GitLabRepositorySessionRequest, { action: 'search_text' }>
  maxOutputBytes: number
  requestGuard: () => void
  requestState: GitLabRepositoryRequestState
  signal?: AbortSignal
}): Promise<GitLabRepositoryToolOutput> {
  let discovery: RepositorySearchTreeDiscovery
  try {
    discovery = await discoverRepositorySearchTree({
      identity: input.identity,
      client: input.client,
      target: input.target,
      run: input.run,
      pathPrefix: input.request.pathPrefix,
      signal: input.signal,
      requestGuard: input.requestGuard,
    })
  } catch (error) {
    return failure('search_text', repositoryApiDiagnostic('search_text', error, input.requestState, input.identity, input.signal))
  }

  const candidates = prioritizedSearchCandidates(discovery.entries, input.run)
    .filter((entry) => searchCandidateAllowed(entry.path, input.run, input.request.pathPrefix))
  const selectedCandidates = candidates.slice(0, MAX_SEARCH_FILES)
  const matches: GitLabRepositoryMatch[] = []
  let inspectedBytes = 0
  let truncated = discovery.truncated || candidates.length > selectedCandidates.length

  for (const entry of selectedCandidates) {
    if (matches.length >= MAX_SEARCH_MATCHES || inspectedBytes >= MAX_SEARCH_SOURCE_BYTES) {
      truncated = true
      break
    }
    const remainingBytes = MAX_SEARCH_SOURCE_BYTES - inspectedBytes
    const maxBytes = Math.min(MAX_SEARCH_FILE_BYTES, remainingBytes)
    const requestBudget = repositoryFileRequestBoundary(input.identity, maxBytes + 1)
    let raw
    try {
      raw = await input.client.getRepositoryFileRaw(
        input.target.projectId,
        entry.path,
        input.target.headSha,
        maxBytes + 1,
        {
          signal: input.signal,
          requestGuard: input.requestGuard,
          beforeRequest: requestBudget.beforeRequest,
        },
      )
    } catch (error) {
      return failure('search_text', repositoryApiDiagnostic('search_text', error, input.requestState, input.identity, input.signal))
    }
    const settlementFailure = settleRepositoryFileRequest(
      input.identity,
      requestBudget.reservedBytes(),
      raw.content.byteLength,
    )
    if (settlementFailure) return failure('search_text', settlementFailure)

    let content = raw.content
    if (content.byteLength > maxBytes) content = content.slice(0, maxBytes)
    inspectedBytes += content.byteLength
    if (raw.truncated || raw.content.byteLength > maxBytes) truncated = true
    const source = decodeUtf8Prefix(content, raw.truncated || raw.content.byteLength > maxBytes)
    if (source === undefined || source.includes('\0')) continue

    const lines = logicalLines(source)
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]!.includes(input.request.query)) continue
      const access = decideGitLabReviewPathAccess(entry.path, {
        excludePathPatterns: input.run.project?.excludePathPatterns,
      })
      if (!access.allowed) continue
      const boundedText = boundedUtf8Prefix(lines[index]!, MAX_SEARCH_MATCH_TEXT_BYTES)
      matches.push({ path: entry.path, line: index + 1, text: boundedText.value })
      if (boundedText.truncated) truncated = true
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true
        break
      }
    }
  }

  while (matches.length > 0 && utf8Bytes(JSON.stringify(matches)) > input.maxOutputBytes) {
    matches.pop()
    truncated = true
  }
  const bytes = utf8Bytes(JSON.stringify(matches))
  const persistenceFailure = recordRepositoryOutput(input.identity, bytes)
  if (persistenceFailure) return failure('search_text', persistenceFailure)

  return {
    ok: true,
    action: 'search_text',
    headSha: input.target.headSha,
    query: input.request.query,
    ...(input.request.pathPrefix ? { pathPrefix: input.request.pathPrefix } : {}),
    matches,
    bytes,
    truncated,
    diagnostics: truncated ? ['repository_search_output_truncated'] : [],
  }
}

type RepositorySearchTreeDiscovery = {
  entries: GitLabRepositoryTreeEntry[]
  truncated: boolean
}

async function discoverRepositorySearchTree(input: {
  identity: ReviewRunIdentity
  client: GitLabApiClient
  target: GitLabRepositoryTarget
  run: ReviewRunRecord
  pathPrefix?: string
  signal?: AbortSignal
  requestGuard: () => void
}): Promise<RepositorySearchTreeDiscovery> {
  const beforeRequest = repositoryApiRequestBoundary(input.identity)
  if (input.pathPrefix) {
    const entries = await input.client.getRepositoryTree(input.target.projectId, input.target.headSha, {
      path: input.pathPrefix,
      recursive: true,
      maxItems: MAX_SEARCH_TREE_ENTRIES,
      signal: input.signal,
      requestGuard: input.requestGuard,
      beforeRequest,
    })
    return { entries, truncated: entries.length >= MAX_SEARCH_TREE_ENTRIES }
  }

  const entries: GitLabRepositoryTreeEntry[] = []
  const seenPaths = new Set<string>()
  let truncated = false
  const preferredPrefixes = preferredSearchPrefixes(input.run)
  const perPrefixLimit = preferredPrefixes.length > 0
    ? Math.max(1, Math.floor(MAX_SEARCH_PRIORITY_TREE_ENTRIES / preferredPrefixes.length))
    : 0
  for (const prefix of preferredPrefixes) {
    let preferredEntries: GitLabRepositoryTreeEntry[]
    try {
      preferredEntries = await input.client.getRepositoryTree(input.target.projectId, input.target.headSha, {
        path: prefix,
        recursive: true,
        maxItems: perPrefixLimit,
        signal: input.signal,
        requestGuard: input.requestGuard,
        beforeRequest,
      })
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) continue
      throw error
    }
    if (preferredEntries.length >= perPrefixLimit) truncated = true
    appendRepositoryTreeEntries(entries, preferredEntries, seenPaths, MAX_SEARCH_PRIORITY_TREE_ENTRIES)
  }

  const remaining = MAX_SEARCH_TREE_ENTRIES - entries.length
  if (remaining <= 0) return { entries, truncated: true }
  const fallbackEntries = await input.client.getRepositoryTree(input.target.projectId, input.target.headSha, {
    recursive: true,
    maxItems: remaining,
    signal: input.signal,
    requestGuard: input.requestGuard,
    beforeRequest,
  })
  if (fallbackEntries.length >= remaining) truncated = true
  appendRepositoryTreeEntries(entries, fallbackEntries, seenPaths, MAX_SEARCH_TREE_ENTRIES)
  return { entries, truncated }
}

function appendRepositoryTreeEntries(
  target: GitLabRepositoryTreeEntry[],
  source: GitLabRepositoryTreeEntry[],
  seenPaths: Set<string>,
  maximum: number,
) {
  for (const entry of source) {
    if (target.length >= maximum) return
    if (seenPaths.has(entry.path)) continue
    seenPaths.add(entry.path)
    target.push(entry)
  }
}

function repositoryTargetForRun(run: ReviewRunRecord): GitLabRepositoryTarget | undefined {
  const trigger = run.trigger
  if (!trigger || typeof trigger.host !== 'string') return undefined
  const host = normalizeGitLabAuthority(trigger.host)
  if (!host || !isId(trigger.projectId)) return undefined
  const candidate = trigger.objectType === 'mr'
    ? trigger.headSha
    : trigger.objectType === 'commit'
      ? trigger.commitSha
      : undefined
  if (typeof candidate !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate)) {
    return undefined
  }
  return {
    host,
    projectId: trigger.projectId,
    headSha: candidate.toLowerCase(),
  }
}

function projectSnapshotMatches(run: ReviewRunRecord, target: GitLabRepositoryTarget) {
  return Boolean(
    run.project?.nine1botProjectID
    && String(run.project.projectId) === String(target.projectId)
    && run.project.host
    && normalizeGitLabAuthority(run.project.host) === target.host,
  )
}

function validateRequest(
  request: GitLabRepositorySessionRequest,
  run: ReviewRunRecord,
):
  | { ok: true; request: GitLabRepositorySessionRequest }
  | { ok: false; diagnostic: string } {
  if (request.action === 'read_file') {
    if (!validGitPath(request.path)) return { ok: false, diagnostic: 'repository_path_invalid' }
    const policyDiagnostic = repositoryPathPolicyDiagnostic(request.path, run)
    if (policyDiagnostic) return { ok: false, diagnostic: policyDiagnostic }
    if (request.startLine !== undefined && !boundedPositiveInteger(request.startLine, 100_000)) {
      return { ok: false, diagnostic: 'repository_line_range_invalid' }
    }
    if (request.maxLines !== undefined && !boundedPositiveInteger(request.maxLines, MAX_READ_LINES)) {
      return { ok: false, diagnostic: 'repository_line_range_invalid' }
    }
    return { ok: true, request }
  }
  if (
    !request.query
    || utf8Bytes(request.query) > MAX_SEARCH_QUERY_BYTES
    || /[\u0000-\u001f\u007f]/.test(request.query)
  ) {
    return { ok: false, diagnostic: 'repository_search_query_invalid' }
  }
  if (request.pathPrefix !== undefined) {
    if (!validGitPath(request.pathPrefix)) return { ok: false, diagnostic: 'repository_path_invalid' }
    const policyDiagnostic = repositoryPathPrefixPolicyDiagnostic(request.pathPrefix, run)
    if (policyDiagnostic) return { ok: false, diagnostic: policyDiagnostic }
  }
  return { ok: true, request }
}

function repositoryPathPolicyDiagnostic(path: string, run: ReviewRunRecord) {
  const decision = decideGitLabReviewPathAccess(path, {
    excludePathPatterns: run.project?.excludePathPatterns,
  })
  if (decision.allowed) return undefined
  return decision.reason === 'profile-excluded'
    ? 'repository_path_excluded'
    : 'repository_path_blacklisted'
}

function repositoryPathPrefixPolicyDiagnostic(pathPrefix: string, run: ReviewRunRecord) {
  return repositoryPathPolicyDiagnostic(pathPrefix, run)
    ?? repositoryPathPolicyDiagnostic(`${pathPrefix}/__nine1bot_path_probe__`, run)
}

function searchCandidateAllowed(path: string, run: ReviewRunRecord, pathPrefix?: string) {
  if (!validGitPath(path)) return false
  if (pathPrefix && path !== pathPrefix && !path.startsWith(`${pathPrefix}/`)) return false
  return !repositoryPathPolicyDiagnostic(path, run)
}

function prioritizedSearchCandidates(tree: GitLabRepositoryTreeEntry[], run: ReviewRunRecord) {
  const includePathPrefixes = preferredSearchPrefixes(run)
  return tree
    .map((entry, index) => ({
      entry,
      index,
      priority: includePathPrefixes.some((prefix) => pathWithinPrefix(entry.path, prefix)) ? 0 : 1,
    }))
    .filter(({ entry }) => entry.type === 'blob')
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ entry }) => entry)
}

function preferredSearchPrefixes(run: ReviewRunRecord) {
  const prefixes: string[] = []
  for (const configuredPrefix of run.project?.includePathPrefixes ?? []) {
    if (typeof configuredPrefix !== 'string') continue
    const prefix = configuredPrefix.replace(/\/+$/, '')
    if (!validGitPath(prefix) || repositoryPathPrefixPolicyDiagnostic(prefix, run)) continue
    if (prefixes.some((existing) => pathWithinPrefix(prefix, existing))) continue
    prefixes.push(prefix)
    if (prefixes.length >= MAX_SEARCH_PRIORITY_PREFIXES) break
  }
  return prefixes
}

function pathWithinPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function validGitPath(path: string) {
  if (!path || utf8Bytes(path) > MAX_GIT_PATH_BYTES) return false
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false
  const segments = path.split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..' && segment !== '.git')
}

function boundedPositiveInteger(value: number, maximum: number) {
  return Number.isInteger(value) && value > 0 && value <= maximum
}

class GitLabRepositoryBoundaryError extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic)
    this.name = 'GitLabRepositoryBoundaryError'
  }
}

function repositoryApiRequestBoundary(identity: ReviewRunIdentity) {
  return () => {
    const diagnostic = reserveRepositoryApiRequest(identity)
    if (diagnostic) throw new GitLabRepositoryBoundaryError(diagnostic)
  }
}

function repositoryFileRequestBoundary(identity: ReviewRunIdentity, requestedBytes: number) {
  let firstRequest = true
  let reservation = 0
  return {
    beforeRequest() {
      if (firstRequest) {
        const diagnostic = reserveRepositoryFileRequest(identity, requestedBytes)
        if (diagnostic) throw new GitLabRepositoryBoundaryError(diagnostic)
        firstRequest = false
        reservation = requestedBytes
        return
      }
      const diagnostic = reserveRepositoryApiRequest(identity)
      if (diagnostic) throw new GitLabRepositoryBoundaryError(diagnostic)
    },
    reservedBytes() {
      return reservation
    },
  }
}

function reserveRepositoryApiRequest(identity: ReviewRunIdentity) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const repository = currentResult.run.repository
  if (!repository) return 'repository_inspection_not_initialized'
  const apiRequestCount = normalizedCounter(repository.apiRequestCount)
  if (apiRequestCount >= MAX_REPOSITORY_API_REQUESTS) {
    return 'repository_api_request_limit_reached'
  }
  return ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      apiRequestCount: apiRequestCount + 1,
    },
  }) ? undefined : 'repository_review_attempt_stale'
}

function reserveRepositoryFileRequest(identity: ReviewRunIdentity, requestedBytes: number) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const repository = currentResult.run.repository
  if (!repository) return 'repository_inspection_not_initialized'
  const apiRequestCount = normalizedCounter(repository.apiRequestCount)
  const fileFetchCount = normalizedCounter(repository.fileFetchCount)
  const fetchedBytes = normalizedCounter(repository.fetchedBytes)
  if (apiRequestCount >= MAX_REPOSITORY_API_REQUESTS) {
    return 'repository_api_request_limit_reached'
  }
  if (fileFetchCount >= MAX_REPOSITORY_FILE_FETCHES) {
    return 'repository_file_fetch_limit_reached'
  }
  if (requestedBytes > MAX_REPOSITORY_FETCHED_BYTES - fetchedBytes) {
    return 'repository_fetch_byte_limit_reached'
  }
  return ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      apiRequestCount: apiRequestCount + 1,
      fileFetchCount: fileFetchCount + 1,
      fetchedBytes: fetchedBytes + requestedBytes,
    },
  }) ? undefined : 'repository_review_attempt_stale'
}

function settleRepositoryFileRequest(
  identity: ReviewRunIdentity,
  reservedBytes: number,
  fetchedBytes: number,
) {
  if (reservedBytes <= 0) return 'repository_request_budget_not_reserved'
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const repository = currentResult.run.repository
  if (!repository) return 'repository_inspection_not_initialized'
  const releaseBytes = Math.max(0, reservedBytes - fetchedBytes)
  if (releaseBytes === 0) return undefined
  const currentBytes = normalizedCounter(repository.fetchedBytes)
  return ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      fetchedBytes: Math.max(0, currentBytes - releaseBytes),
    },
  }) ? undefined : 'repository_review_attempt_stale'
}

function reserveRepositoryQuery(
  identity: ReviewRunIdentity,
  action: GitLabRepositorySessionRequest['action'],
):
  | { ok: true; maxOutputBytes: number }
  | { ok: false; diagnostic: string } {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return { ok: false, diagnostic: currentResult.diagnostic }
  const current = currentResult.run
  const repository = current.repository
  if (!repository) return { ok: false, diagnostic: 'repository_inspection_not_initialized' }
  const queryCount = normalizedCounter(repository.queryCount)
  const outputBytes = normalizedCounter(repository.outputBytes)
  if (queryCount >= MAX_REPOSITORY_QUERIES) {
    return { ok: false, diagnostic: 'repository_query_limit_reached' }
  }
  if (outputBytes >= MAX_REPOSITORY_OUTPUT_BYTES) {
    return { ok: false, diagnostic: 'repository_output_limit_reached' }
  }
  const updated = ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      queryCount: queryCount + 1,
      readCount: normalizedCounter(repository.readCount) + (action === 'read_file' ? 1 : 0),
      searchCount: normalizedCounter(repository.searchCount) + (action === 'search_text' ? 1 : 0),
      outputBytes,
    },
  })
  return updated
    ? { ok: true, maxOutputBytes: Math.min(MAX_TOOL_CONTENT_BYTES, MAX_REPOSITORY_OUTPUT_BYTES - outputBytes) }
    : { ok: false, diagnostic: 'repository_review_attempt_stale' }
}

function recordRepositoryOutput(identity: ReviewRunIdentity, bytes: number) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const repository = currentResult.run.repository
  if (!repository) return 'repository_inspection_not_initialized'
  const currentBytes = normalizedCounter(repository.outputBytes)
  if (bytes > MAX_REPOSITORY_OUTPUT_BYTES - currentBytes) return 'repository_output_limit_reached'
  return ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      outputBytes: currentBytes + bytes,
    },
  }) ? undefined : 'repository_review_attempt_stale'
}

function normalizedCounter(value: number | undefined) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

type RepositoryLifecycleDiagnostic =
  | 'repository_review_attempt_stale'
  | 'repository_review_run_not_active'
  | 'repository_request_aborted'

type RepositoryRequestDiagnostic =
  | RepositoryLifecycleDiagnostic
  | 'repository_search_timeout'

type GitLabRepositoryRequestState = {
  diagnostic?: RepositoryRequestDiagnostic
}

class GitLabRepositoryLifecycleError extends Error {
  constructor(readonly diagnostic: RepositoryRequestDiagnostic) {
    super(diagnostic)
    this.name = 'GitLabRepositoryLifecycleError'
  }
}

function repositoryRequestGuard(
  identity: ReviewRunIdentity,
  signal: AbortSignal | undefined,
  state: GitLabRepositoryRequestState,
  abortDiagnostic: () => RepositoryRequestDiagnostic = () => 'repository_request_aborted',
) {
  return () => {
    const diagnostic = signal?.aborted
      ? abortDiagnostic()
      : repositoryLifecycleFailure(identity)
    if (!diagnostic) return
    state.diagnostic ??= diagnostic
    throw new GitLabRepositoryLifecycleError(state.diagnostic)
  }
}

function repositoryApiDiagnostic(
  action: GitLabRepositorySessionRequest['action'],
  error: unknown,
  state: GitLabRepositoryRequestState,
  identity: ReviewRunIdentity,
  signal?: AbortSignal,
) {
  const interrupted = state.diagnostic
    ?? repositoryLifecycleFailure(identity, signal)
    ?? (error instanceof Error && error.name === 'AbortError' ? 'repository_request_aborted' : undefined)
  if (interrupted) return interrupted
  if (error instanceof GitLabRepositoryBoundaryError) return error.diagnostic
  if (error instanceof GitLabApiError && error.status === 404) {
    return action === 'read_file' ? 'repository_file_not_found' : 'repository_search_path_not_found'
  }
  if (error instanceof GitLabApiError && (error.status === 401 || error.status === 403)) {
    return 'repository_access_denied'
  }
  return `repository_api_unavailable:${errorName(error)}`
}

function repositoryLifecycleFailure(
  identity: ReviewRunIdentity,
  signal?: AbortSignal,
): RepositoryLifecycleDiagnostic | undefined {
  if (signal?.aborted) return 'repository_request_aborted'
  const currentResult = currentActiveReviewRun(identity)
  return 'diagnostic' in currentResult ? currentResult.diagnostic : undefined
}

function repositorySearchDeadline(upstreamSignal: AbortSignal | undefined, requestedTimeoutMs?: number) {
  const controller = new AbortController()
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const onUpstreamAbort = () => {
    if (timeout) clearTimeout(timeout)
    controller.abort(upstreamSignal?.reason)
  }
  if (upstreamSignal?.aborted) onUpstreamAbort()
  else upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true })

  const timeoutMs = typeof requestedTimeoutMs === 'number'
    && Number.isFinite(requestedTimeoutMs)
    && requestedTimeoutMs > 0
    ? Math.min(MAX_REPOSITORY_SEARCH_DURATION_MS, Math.floor(requestedTimeoutMs))
    : MAX_REPOSITORY_SEARCH_DURATION_MS
  if (!controller.signal.aborted) {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new GitLabRepositoryLifecycleError('repository_search_timeout'))
    }, timeoutMs)
  }
  return {
    signal: controller.signal,
    abortDiagnostic: (): RepositoryRequestDiagnostic => timedOut
      ? 'repository_search_timeout'
      : 'repository_request_aborted',
    dispose() {
      if (timeout) clearTimeout(timeout)
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
    },
  }
}

function currentActiveReviewRun(identity: ReviewRunIdentity):
  | { run: ReviewRunRecord }
  | { diagnostic: Exclude<RepositoryLifecycleDiagnostic, 'repository_request_aborted'> } {
  const current = ReviewRunStore.get(identity.runId)
  if (
    !current
    || current.generation !== identity.generation
    || current.sessionId !== identity.sessionId
    || ReviewRunStore.findLatestByTriggerKey(current.triggerKey)?.id !== current.id
  ) {
    return { diagnostic: 'repository_review_attempt_stale' }
  }
  if (current.status !== 'accepted' && current.status !== 'running') {
    return { diagnostic: 'repository_review_run_not_active' }
  }
  return { run: current }
}

function logicalLines(source: string) {
  if (!source) return []
  const lines = source.split('\n')
  if (source.endsWith('\n')) lines.pop()
  return lines
}

function boundedUtf8Prefix(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false }
  let low = 0
  let high = value.length
  let best = ''
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2)
    const candidate = safeCodeUnitPrefix(value, midpoint)
    if (utf8Bytes(candidate) <= maxBytes) {
      best = candidate
      low = midpoint + 1
    } else {
      high = midpoint - 1
    }
  }
  return { value: best, truncated: true }
}

function safeCodeUnitPrefix(value: string, length: number) {
  let end = Math.min(value.length, Math.max(0, length))
  if (
    end > 0
    && end < value.length
    && /[\uD800-\uDBFF]/.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/.test(value[end]!)
  ) end -= 1
  return value.slice(0, end)
}

function decodeUtf8(value: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    return undefined
  }
}

function decodeUtf8Prefix(value: Uint8Array, mayEndMidCharacter: boolean) {
  const attempts = mayEndMidCharacter ? Math.min(3, value.byteLength) : 0
  for (let removed = 0; removed <= attempts; removed += 1) {
    const decoded = decodeUtf8(removed === 0 ? value : value.slice(0, value.byteLength - removed))
    if (decoded !== undefined) return decoded
  }
  return undefined
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

async function resolveSecret(
  ref: string | PlatformSecretRef | undefined,
  secrets: PlatformSecretAccess,
) {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  return await secrets.get(ref)
}

function isId(input: unknown): input is string | number {
  return (typeof input === 'string' && input.length > 0)
    || (typeof input === 'number' && Number.isFinite(input))
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

function failure(
  action: GitLabRepositorySessionRequest['action'],
  diagnostic: string,
): GitLabRepositoryToolOutput {
  return { ok: false, action, diagnostic }
}
