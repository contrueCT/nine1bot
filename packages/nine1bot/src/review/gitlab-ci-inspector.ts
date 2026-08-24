import {
  GitLabApiClient,
  inspectGitLabCi,
  normalizeGitLabAuthority,
  normalizeGitLabReviewSettings,
  readGitLabCiJobLog,
  resolveGitLabApiBaseUrl,
  type GitLabCiJob,
  type GitLabCiPipeline,
} from '@nine1bot/platform-gitlab/review'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import type { PlatformManagerConfig } from '../platform/manager'
import {
  ReviewRunStore,
  type ReviewRunCiSummary,
  type ReviewRunIdentity,
  type ReviewRunRecord,
} from './run-store'

export type GitLabCiSessionRequest =
  | { action: 'list' }
  | { action: 'read_job_log'; jobId: number }

type GitLabCiTarget = {
  host: string
  projectId: string | number
  mrIid: string | number
  headSha: string
  mrUrl?: string
}

const MAX_TOOL_OUTPUT_BYTES = 32 * 1024
const MAX_GITLAB_CI_LIST_QUERIES = 1

export type GitLabCiToolOutput =
  | {
      ok: true
      action: 'list'
      observedAt: number
      target: GitLabCiTarget
      pipeline?: GitLabCiPipeline
      jobs: GitLabCiJob[]
      diagnostics: string[]
      truncated: boolean
      totalJobs: number
      returnedJobs: number
    }
  | {
      ok: true
      action: 'read_job_log'
      observedAt: number
      target: GitLabCiTarget
      job: GitLabCiJob
      trace: string
      bytes: number
      truncated: boolean
      diagnostics: string[]
    }
  | {
      ok: false
      action: GitLabCiSessionRequest['action']
      diagnostic: string
    }

export async function inspectGitLabCiForSession(input: {
  sessionId: string
  request: GitLabCiSessionRequest
  platforms: PlatformManagerConfig
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
  signal?: AbortSignal
}): Promise<GitLabCiToolOutput> {
  const run = ReviewRunStore.findBySessionId(input.sessionId)
  if (!run) return failure(input.request.action, 'gitlab_review_session_not_bound')
  const identity: ReviewRunIdentity = {
    runId: run.id,
    sessionId: input.sessionId,
    generation: run.generation,
  }
  const initialLifecycleFailure = reviewRunLifecycleFailure(identity, input.signal)
  if (initialLifecycleFailure) return failure(input.request.action, initialLifecycleFailure)

  const target = targetForRun(run)
  if (!target) return failure(input.request.action, 'gitlab_review_mr_identity_missing')
  if (!projectSnapshotMatches(run, target)) {
    return failure(input.request.action, 'gitlab_review_project_snapshot_missing')
  }

  const platform = input.platforms.gitlab
  const settings = normalizeGitLabReviewSettings(platform?.settings)
  if (!platform?.enabled || !settings.enabled) {
    return failure(input.request.action, 'gitlab_review_not_configured')
  }

  const resolvedBaseUrl = resolveGitLabApiBaseUrl({
    configuredBaseUrl: settings.baseUrl,
    triggerHost: target.host,
  })
  if (!resolvedBaseUrl.ok) return failure(input.request.action, resolvedBaseUrl.reason)

  if (input.request.action === 'list') {
    const reservationFailure = reserveListQuery(identity)
    if (reservationFailure) return failure(input.request.action, reservationFailure)
  }
  if (input.request.action === 'read_job_log') {
    const prerequisiteFailure = requireListQuery(identity)
    if (prerequisiteFailure) return failure(input.request.action, prerequisiteFailure)
  }

  let token: string | undefined
  try {
    token = await resolveSecret(settings.tokenSecretRef, input.secrets)
  } catch (error) {
    const lifecycleFailure = reviewRunLifecycleFailure(identity, input.signal)
    if (lifecycleFailure) return failure(input.request.action, lifecycleFailure)
    const diagnostic = `ci_token_unavailable:${errorName(error)}`
    const persistenceFailure = recordDiagnostic(identity, diagnostic)
    if (persistenceFailure) return failure(input.request.action, persistenceFailure)
    return failure(input.request.action, diagnostic)
  }
  const tokenLifecycleFailure = reviewRunLifecycleFailure(identity, input.signal)
  if (tokenLifecycleFailure) return failure(input.request.action, tokenLifecycleFailure)
  if (!token) {
    const persistenceFailure = recordDiagnostic(identity, 'ci_token_missing')
    if (persistenceFailure) return failure(input.request.action, persistenceFailure)
    return failure(input.request.action, 'ci_token_missing')
  }

  if (input.request.action === 'read_job_log') {
    const reservationFailure = reserveJobLogRead(identity, input.request.jobId)
    if (reservationFailure) return failure(input.request.action, reservationFailure)
  }

  const rawClient = new GitLabApiClient({
    baseUrl: resolvedBaseUrl.baseUrl,
    token,
    fetch: input.fetch,
  })
  const requestState: GitLabCiRequestState = {}
  const client = attemptBoundGitLabClient(rawClient, identity, input.signal, requestState)

  if (input.request.action === 'list') {
    const result = await inspectGitLabCi({
      client,
      projectId: target.projectId,
      mrIid: target.mrIid,
      headSha: target.headSha,
      signal: input.signal,
    })
    const requestFailure = requestState.diagnostic
      ?? reviewRunLifecycleFailure(identity, input.signal)
      ?? abortedResultDiagnostic(result.diagnostics)
    if (requestFailure) return failure(input.request.action, requestFailure)
    const observedAt = Date.now()
    const output = boundListToolOutput({
      ok: true,
      action: 'list',
      observedAt,
      target: { ...target, mrUrl: mergeRequestUrl(resolvedBaseUrl.baseUrl, run, target) },
      pipeline: result.pipeline,
      jobs: result.jobs,
      diagnostics: result.diagnostics,
      truncated: result.truncated,
      totalJobs: result.totalJobs,
      returnedJobs: result.returnedJobs,
    })
    const persistenceFailure = updateCiSummary(identity, (current) => ({
      ...current,
      pipeline: result.pipeline,
      diagnostics: mergeDiagnostics(current.diagnostics, result.diagnostics),
      observedAt,
      ...(output.ok ? { listCompletedAt: observedAt } : {}),
    }))
    if (persistenceFailure) return failure(input.request.action, persistenceFailure)
    return output
  }

  const jobId = input.request.jobId
  const pipelineResult = await inspectGitLabCi({
    client,
    projectId: target.projectId,
    mrIid: target.mrIid,
    headSha: target.headSha,
    signal: input.signal,
  })
  const pipelineRequestFailure = requestState.diagnostic
    ?? reviewRunLifecycleFailure(identity, input.signal)
    ?? abortedResultDiagnostic(pipelineResult.diagnostics)
  if (pipelineRequestFailure) return failure(input.request.action, pipelineRequestFailure)
  if (!pipelineResult.pipeline) {
    const diagnostic = pipelineResult.diagnostics[0] ?? 'ci_pipeline_unverified_for_current_head'
    const persistenceFailure = recordDiagnostic(identity, diagnostic)
    if (persistenceFailure) return failure(input.request.action, persistenceFailure)
    return failure(input.request.action, diagnostic)
  }

  const result = await readGitLabCiJobLog({
    client: {
      getPipelineJobs: client.getPipelineJobs,
      getJobTrace: client.getJobTrace,
    },
    projectId: target.projectId,
    pipelineId: pipelineResult.pipeline.id,
    jobId,
    maxBytes: jobLogByteLimit(run),
    signal: input.signal,
  })
  const logRequestFailure = requestState.diagnostic
    ?? reviewRunLifecycleFailure(identity, input.signal)
    ?? abortedResultDiagnostic(result.diagnostics)
  if (logRequestFailure) return failure(input.request.action, logRequestFailure)
  const observedAt = Date.now()
  const persistenceFailure = updateCiSummary(identity, (current) => ({
    ...current,
    pipeline: pipelineResult.pipeline,
    diagnostics: mergeDiagnostics(current.diagnostics, [...pipelineResult.diagnostics, ...result.diagnostics]),
    observedAt,
  }))
  if (persistenceFailure) return failure(input.request.action, persistenceFailure)
  if (!result.job || result.trace === undefined || result.diagnostics.length > 0) {
    return failure(input.request.action, result.diagnostics[0] ?? 'ci_job_log_unavailable')
  }
  return {
    ok: true,
    action: 'read_job_log',
    observedAt,
    target: { ...target, mrUrl: mergeRequestUrl(resolvedBaseUrl.baseUrl, run, target) },
    job: result.job,
    trace: result.trace,
    bytes: result.bytes,
    truncated: result.truncated,
    diagnostics: result.diagnostics,
  }
}

function targetForRun(run: ReviewRunRecord): GitLabCiTarget | undefined {
  const trigger = run.trigger
  if (!trigger || trigger.objectType !== 'mr') return undefined
  if (typeof trigger.host !== 'string' || !normalizeGitLabAuthority(trigger.host)) return undefined
  if (!isId(trigger.projectId) || !isId(trigger.objectIid)) return undefined
  if (
    typeof trigger.headSha !== 'string'
    || !trigger.headSha.trim()
    || trigger.headSha.length > 128
    || /\s/.test(trigger.headSha)
  ) return undefined
  return {
    host: normalizeGitLabAuthority(trigger.host)!,
    projectId: trigger.projectId,
    mrIid: trigger.objectIid,
    headSha: trigger.headSha,
  }
}

function projectSnapshotMatches(run: ReviewRunRecord, target: GitLabCiTarget) {
  if (!run.project) return false
  if (String(run.project.projectId) !== String(target.projectId)) return false
  if (!run.project.host) return false
  return normalizeGitLabAuthority(run.project.host) === target.host
}

function mergeRequestUrl(baseUrl: string, run: ReviewRunRecord, target: GitLabCiTarget) {
  const path = typeof run.trigger?.projectPath === 'string' && run.trigger.projectPath.trim()
    ? run.trigger.projectPath
    : run.project?.pathWithNamespace
  if (!path) return undefined
  const encodedPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  if (!encodedPath) return undefined
  const url = `${baseUrl.replace(/\/+$/, '')}/${encodedPath}/-/merge_requests/${encodeURIComponent(String(target.mrIid))}`
  return url.length <= 4_096 ? url : undefined
}

function boundListToolOutput(
  output: Extract<GitLabCiToolOutput, { ok: true; action: 'list' }>,
): GitLabCiToolOutput {
  const jobs = [...output.jobs]
  let next = { ...output, jobs }
  while (toolOutputBytes(next) >= MAX_TOOL_OUTPUT_BYTES && jobs.length > 0) {
    jobs.pop()
    next = {
      ...next,
      jobs,
      diagnostics: mergeDiagnostics(next.diagnostics, ['ci_jobs_truncated']),
      truncated: true,
      returnedJobs: jobs.length,
    }
  }
  if (toolOutputBytes(next) >= MAX_TOOL_OUTPUT_BYTES && next.target.mrUrl) {
    next = {
      ...next,
      target: { ...next.target, mrUrl: undefined },
      diagnostics: mergeDiagnostics(next.diagnostics, ['ci_target_url_omitted']),
      truncated: true,
    }
  }
  if (toolOutputBytes(next) >= MAX_TOOL_OUTPUT_BYTES) {
    return failure('list', 'ci_tool_output_limit_exceeded')
  }
  return next
}

function toolOutputBytes(output: GitLabCiToolOutput) {
  return new TextEncoder().encode(JSON.stringify(output)).length
}

function reserveListQuery(identity: ReviewRunIdentity) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const current = currentResult.run
  const count = current.ci?.queryCount ?? 0
  if (count >= MAX_GITLAB_CI_LIST_QUERIES) return 'ci_list_query_limit_reached'
  const updated = ReviewRunStore.updateIfCurrent(identity, {
    ci: {
      ...current.ci,
      diagnostics: current.ci?.diagnostics ?? [],
      queryCount: count + 1,
    },
  })
  return updated ? undefined : 'ci_review_attempt_stale'
}

function reserveJobLogRead(identity: ReviewRunIdentity, jobId: number) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const current = currentResult.run
  const limit = jobLogReadLimit(current)
  const count = current.ci?.jobLogReadCount ?? 0
  if (count >= limit) return 'ci_job_log_limit_reached'
  const updated = ReviewRunStore.updateIfCurrent(identity, {
    ci: {
      ...current.ci,
      diagnostics: current.ci?.diagnostics ?? [],
      jobLogReadCount: count + 1,
      queriedJobIds: [...(current.ci?.queriedJobIds ?? []), jobId],
    },
  })
  return updated ? undefined : 'ci_review_attempt_stale'
}

function requireListQuery(identity: ReviewRunIdentity) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  return (currentResult.run.ci?.listCompletedAt ?? 0) > 0 ? undefined : 'ci_list_required'
}

function recordDiagnostic(identity: ReviewRunIdentity, diagnostic: string) {
  return updateCiSummary(identity, (current) => ({
    ...current,
    diagnostics: mergeDiagnostics(current.diagnostics, [diagnostic]),
    observedAt: Date.now(),
  }))
}

function updateCiSummary(
  identity: ReviewRunIdentity,
  update: (current: ReviewRunCiSummary) => ReviewRunCiSummary,
) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const updated = ReviewRunStore.updateIfCurrent(identity, {
    ci: update(currentResult.run.ci ?? { diagnostics: [] }),
  })
  return updated ? undefined : 'ci_review_attempt_stale'
}

type GitLabCiLifecycleDiagnostic =
  | 'ci_review_attempt_stale'
  | 'ci_review_run_not_active'
  | 'ci_request_aborted'
  | 'ci_job_log_limit_reached'
  | 'ci_list_query_limit_reached'
  | 'ci_list_required'

type GitLabCiRequestState = {
  diagnostic?: GitLabCiLifecycleDiagnostic
}

class GitLabCiLifecycleError extends Error {
  constructor(readonly diagnostic: GitLabCiLifecycleDiagnostic) {
    super(diagnostic)
    this.name = 'GitLabCiLifecycleError'
  }
}

function attemptBoundGitLabClient(
  client: GitLabApiClient,
  identity: ReviewRunIdentity,
  signal: AbortSignal | undefined,
  state: GitLabCiRequestState,
) {
  const guarded = async <T>(operation: () => Promise<T>) => {
    const before = reviewRunLifecycleFailure(identity, signal)
    if (before) stopCiRequest(state, before)
    try {
      const value = await operation()
      const after = reviewRunLifecycleFailure(identity, signal)
      if (after) stopCiRequest(state, after)
      return value
    } catch (error) {
      if (error instanceof GitLabCiLifecycleError) throw error
      const interrupted = reviewRunLifecycleFailure(identity, signal)
        ?? (error instanceof Error && error.name === 'AbortError' ? 'ci_request_aborted' : undefined)
      if (interrupted) stopCiRequest(state, interrupted)
      throw error
    }
  }

  return {
    getMergeRequestPipelines: (...args: Parameters<GitLabApiClient['getMergeRequestPipelines']>) =>
      guarded(() => client.getMergeRequestPipelines(...args)),
    getMergeRequest: (...args: Parameters<GitLabApiClient['getMergeRequest']>) =>
      guarded(() => client.getMergeRequest(...args)),
    getPipeline: (...args: Parameters<GitLabApiClient['getPipeline']>) =>
      guarded(() => client.getPipeline(...args)),
    getCommit: (...args: Parameters<GitLabApiClient['getCommit']>) =>
      guarded(() => client.getCommit(...args)),
    getPipelineJobs: (...args: Parameters<GitLabApiClient['getPipelineJobs']>) =>
      guarded(() => client.getPipelineJobs(...args)),
    getJobTrace: (...args: Parameters<GitLabApiClient['getJobTrace']>) =>
      guarded(() => client.getJobTrace(...args)),
  }
}

function stopCiRequest(state: GitLabCiRequestState, diagnostic: GitLabCiLifecycleDiagnostic): never {
  state.diagnostic ??= diagnostic
  throw new GitLabCiLifecycleError(state.diagnostic)
}

function reviewRunLifecycleFailure(
  identity: ReviewRunIdentity,
  signal?: AbortSignal,
): Exclude<GitLabCiLifecycleDiagnostic, 'ci_job_log_limit_reached' | 'ci_list_query_limit_reached'> | undefined {
  if (signal?.aborted) return 'ci_request_aborted'
  const currentResult = currentActiveReviewRun(identity)
  return 'diagnostic' in currentResult ? currentResult.diagnostic : undefined
}

function currentActiveReviewRun(identity: ReviewRunIdentity):
  | { run: ReviewRunRecord }
  | { diagnostic: 'ci_review_attempt_stale' | 'ci_review_run_not_active' } {
  const current = ReviewRunStore.get(identity.runId)
  if (
    !current ||
    current.generation !== identity.generation ||
    current.sessionId !== identity.sessionId ||
    ReviewRunStore.findLatestByTriggerKey(current.triggerKey)?.id !== current.id
  ) {
    return { diagnostic: 'ci_review_attempt_stale' }
  }
  if (current.status !== 'accepted' && current.status !== 'running') {
    return { diagnostic: 'ci_review_run_not_active' }
  }
  return { run: current }
}

function abortedResultDiagnostic(diagnostics: string[]) {
  return diagnostics.includes('ci_request_aborted') ? 'ci_request_aborted' as const : undefined
}

function jobLogReadLimit(run: ReviewRunRecord) {
  const configured = run.project?.ci.maxJobLogs
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.min(10, Math.floor(configured))
    : 3
}

function jobLogByteLimit(run: ReviewRunRecord) {
  const configured = run.project?.ci.maxJobLogBytes
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.min(16_384, Math.floor(configured))
    : 8_000
}

async function resolveSecret(
  ref: string | PlatformSecretRef | undefined,
  secrets: PlatformSecretAccess,
) {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  return await secrets.get(ref)
}

function mergeDiagnostics(current: string[], additions: string[]) {
  return [...new Set([...current, ...additions])]
}

function isId(input: unknown): input is string | number {
  return (typeof input === 'string' && input.length > 0)
    || (typeof input === 'number' && Number.isFinite(input))
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

function failure(action: GitLabCiSessionRequest['action'], diagnostic: string): GitLabCiToolOutput {
  return { ok: false, action, diagnostic }
}
