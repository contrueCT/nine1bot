import type { GitLabApiClient, GitLabPipelineJob, GitLabPipelineSummary } from './api-client'
import { redactGitLabSecrets } from './secret-redaction'
import { truncateUtf8 } from './utf8-budget'

export const MAX_GITLAB_CI_PIPELINE_CANDIDATES = 50
export const MAX_GITLAB_CI_JOBS = 100
export const MAX_GITLAB_CI_LIST_BYTES = 32 * 1024
export const MAX_GITLAB_CI_JOB_LOG_BYTES = 16 * 1024

export type GitLabCiPipelineKind = 'source' | 'detached' | 'merged_result' | 'merge_train' | 'integrated'

export type GitLabCiPipelineVerification =
  | 'mr_pipeline_candidate'
  | 'mr_head_pipeline_candidate'
  | 'head_sha_exact'
  | 'merge_request_event'
  | 'temporary_commit_contains_head'

export type GitLabCiPipeline = {
  id: number
  iid?: number
  projectId?: number
  status?: string
  source?: string
  sha?: string
  ref?: string
  webUrl?: string
  createdAt?: string
  updatedAt?: string
  kind: GitLabCiPipelineKind
  verification: GitLabCiPipelineVerification[]
}

export type GitLabCiJob = {
  id: number
  name?: string
  stage?: string
  status?: string
  allowFailure?: boolean
  webUrl?: string
  startedAt?: string | null
  finishedAt?: string | null
  duration?: number | null
}

export type GitLabCiListResult = {
  pipeline?: GitLabCiPipeline
  jobs: GitLabCiJob[]
  diagnostics: string[]
  truncated: boolean
  totalJobs: number
  returnedJobs: number
}

export type GitLabCiJobLogResult = {
  job?: GitLabCiJob
  trace?: string
  bytes: number
  truncated: boolean
  diagnostics: string[]
}

export type GitLabCiPipelineSelection = {
  pipeline?: GitLabCiPipeline
  diagnostics: string[]
}

type GitLabCiSelectionClient = Pick<
  GitLabApiClient,
  'getMergeRequestPipelines' | 'getMergeRequest' | 'getPipeline' | 'getCommit'
>

export async function selectTrustedGitLabCiPipeline(input: {
  client: GitLabCiSelectionClient
  projectId: string | number
  mrIid: string | number
  headSha: string
  signal?: AbortSignal
}): Promise<GitLabCiPipelineSelection> {
  let pipelines: GitLabPipelineSummary[]
  let mergeRequest: Awaited<ReturnType<GitLabCiSelectionClient['getMergeRequest']>>
  try {
    pipelines = await input.client.getMergeRequestPipelines(input.projectId, input.mrIid, {
      signal: input.signal,
      maxItems: MAX_GITLAB_CI_PIPELINE_CANDIDATES,
    })
    mergeRequest = await input.client.getMergeRequest(input.projectId, input.mrIid, { signal: input.signal })
  } catch (error) {
    return emptyPipelineSelection(metadataDiagnostic(error, input.signal))
  }

  if (
    (mergeRequest.iid !== undefined && String(mergeRequest.iid) !== String(input.mrIid)) ||
    !projectIdentityMatches(input.projectId, mergeRequest.project_id) ||
    (mergeRequest.diff_refs?.head_sha !== undefined && mergeRequest.diff_refs.head_sha !== input.headSha)
  ) {
    return emptyPipelineSelection('ci_pipeline_unverified_for_current_head')
  }

  const candidates = mergePipelineCandidates(mergeRequest.head_pipeline, pipelines)
    .slice(0, MAX_GITLAB_CI_PIPELINE_CANDIDATES)
  if (candidates.length === 0) return emptyPipelineSelection('ci_pipeline_not_found_for_current_mr')

  const trusted: GitLabCiPipeline[] = []
  const metadataDiagnostics: string[] = []
  for (const candidate of candidates) {
    if (!projectIdentityMatches(input.projectId, candidate.pipeline.project_id)) continue
    const candidateRef = parseMergeRequestPipelineRef(candidate.pipeline.ref)
    if (candidateRef && candidateRef.mrIid !== String(input.mrIid)) continue

    if (candidate.pipeline.sha === input.headSha) {
      const kind: GitLabCiPipelineKind = candidateRef?.kind === 'head' || candidate.pipeline.source === 'merge_request_event'
        ? 'detached'
        : 'source'
      trusted.push(projectCiPipeline(candidate.pipeline, kind, [
        ...candidate.origins,
        'head_sha_exact',
      ]))
      continue
    }

    let pipeline: GitLabPipelineSummary
    try {
      pipeline = await input.client.getPipeline(input.projectId, candidate.pipeline.id, { signal: input.signal })
    } catch (error) {
      metadataDiagnostics.push(metadataDiagnostic(error, input.signal))
      continue
    }
    if (pipeline.id !== candidate.pipeline.id || !projectIdentityMatches(input.projectId, pipeline.project_id)) continue
    const authoritative = { ...candidate.pipeline, ...pipeline }
    const authoritativeRef = parseMergeRequestPipelineRef(authoritative.ref)
    if (authoritativeRef && authoritativeRef.mrIid !== String(input.mrIid)) continue
    if (authoritative.source !== 'merge_request_event' || !authoritative.sha) continue

    let commit: Awaited<ReturnType<GitLabCiSelectionClient['getCommit']>>
    try {
      commit = await input.client.getCommit(input.projectId, authoritative.sha, { signal: input.signal })
    } catch (error) {
      metadataDiagnostics.push(metadataDiagnostic(error, input.signal))
      continue
    }
    if (commit.id !== authoritative.sha || !commit.parent_ids.includes(input.headSha)) continue

    trusted.push(projectCiPipeline(authoritative, integratedPipelineKind(authoritativeRef), [
      ...candidate.origins,
      'merge_request_event',
      'temporary_commit_contains_head',
    ]))
  }

  const pipeline = trusted.sort(compareTrustedPipelines)[0]
  if (pipeline) return { pipeline, diagnostics: [] }
  const metadataFailure = metadataDiagnostics.find((diagnostic) => diagnostic === 'ci_request_aborted')
    ?? metadataDiagnostics[0]
  return emptyPipelineSelection(metadataFailure ?? 'ci_pipeline_unverified_for_current_head')
}

export async function inspectGitLabCi(input: {
  client: GitLabCiSelectionClient & Pick<GitLabApiClient, 'getPipelineJobs'>
  projectId: string | number
  mrIid: string | number
  headSha: string
  signal?: AbortSignal
}): Promise<GitLabCiListResult> {
  const selection = await selectTrustedGitLabCiPipeline(input)
  if (!selection.pipeline) return emptyListResult(selection.diagnostics[0] ?? 'ci_pipeline_unverified_for_current_head')
  const pipeline = selection.pipeline
  try {
    const jobs = await input.client.getPipelineJobs(input.projectId, pipeline.id, { signal: input.signal })
    return boundCiList(pipeline, jobs.map(projectCiJob), selection.diagnostics)
  } catch (error) {
    return {
      pipeline,
      jobs: [],
      diagnostics: [`ci_jobs_unavailable:${errorName(error)}`],
      truncated: false,
      totalJobs: 0,
      returnedJobs: 0,
    }
  }
}

export async function readGitLabCiJobLog(input: {
  client: Pick<GitLabApiClient, 'getPipelineJobs' | 'getJobTrace'>
  projectId: string | number
  pipelineId: string | number
  jobId: string | number
  maxBytes: number
  signal?: AbortSignal
}): Promise<GitLabCiJobLogResult> {
  let jobs: GitLabPipelineJob[]
  try {
    jobs = await input.client.getPipelineJobs(input.projectId, input.pipelineId, { signal: input.signal })
  } catch (error) {
    return emptyJobLogResult(`ci_jobs_unavailable:${errorName(error)}`)
  }
  const rawJob = jobs.find((candidate) => String(candidate.id) === String(input.jobId))
  if (!rawJob) return emptyJobLogResult('ci_job_not_in_head_pipeline')
  const job = projectCiJob(rawJob)

  const maxBytes = Math.min(MAX_GITLAB_CI_JOB_LOG_BYTES, Math.max(0, Math.floor(input.maxBytes)))
  try {
    const rawTrace = await input.client.getJobTrace(input.projectId, rawJob.id, maxBytes + 1, { signal: input.signal })
    const sanitized = sanitizeGitLabCiTrace(rawTrace)
    const trace = truncateUtf8(sanitized, maxBytes)
    return {
      job,
      trace,
      bytes: byteLength(trace),
      truncated: byteLength(rawTrace) > maxBytes || byteLength(sanitized) > maxBytes,
      diagnostics: [],
    }
  } catch (error) {
    return {
      ...emptyJobLogResult(`ci_job_log_unavailable:${job.id}:${errorName(error)}`),
      job,
    }
  }
}

export function sanitizeGitLabCiTrace(trace: string) {
  return redactGitLabSecrets(trace)
}

function boundCiList(
  pipeline: GitLabCiPipeline,
  jobs: GitLabCiJob[],
  diagnostics: string[],
): GitLabCiListResult {
  const totalJobs = jobs.length
  const selected: GitLabCiJob[] = []
  for (const job of jobs.slice(0, MAX_GITLAB_CI_JOBS)) {
    const candidate = listResult(pipeline, [...selected, job], diagnostics, totalJobs, true)
    if (byteLength(JSON.stringify(candidate)) > MAX_GITLAB_CI_LIST_BYTES) break
    selected.push(job)
  }
  const truncated = selected.length < totalJobs
  return listResult(pipeline, selected, diagnostics, totalJobs, truncated)
}

function listResult(
  pipeline: GitLabCiPipeline,
  jobs: GitLabCiJob[],
  diagnostics: string[],
  totalJobs: number,
  truncated: boolean,
): GitLabCiListResult {
  return {
    pipeline,
    jobs,
    diagnostics: truncated ? uniqueStrings([...diagnostics, 'ci_jobs_truncated']) : diagnostics,
    truncated,
    totalJobs,
    returnedJobs: jobs.length,
  }
}

function emptyListResult(diagnostic: string): GitLabCiListResult {
  return {
    jobs: [],
    diagnostics: [diagnostic],
    truncated: false,
    totalJobs: 0,
    returnedJobs: 0,
  }
}

function projectCiPipeline(
  pipeline: GitLabPipelineSummary,
  kind: GitLabCiPipelineKind,
  verification: GitLabCiPipelineVerification[],
): GitLabCiPipeline {
  return compactObject({
    id: pipeline.id,
    iid: pipeline.iid,
    projectId: pipeline.project_id,
    status: pipeline.status,
    source: pipeline.source,
    sha: pipeline.sha,
    ref: pipeline.ref,
    webUrl: pipeline.web_url,
    createdAt: pipeline.created_at,
    updatedAt: pipeline.updated_at,
    kind,
    verification: uniqueStrings(verification),
  }) as GitLabCiPipeline
}

function mergePipelineCandidates(
  headPipeline: GitLabPipelineSummary | undefined,
  pipelines: GitLabPipelineSummary[],
) {
  const candidates = new Map<number, {
    pipeline: GitLabPipelineSummary
    origins: GitLabCiPipelineVerification[]
  }>()
  const add = (pipeline: GitLabPipelineSummary | undefined, origin: GitLabCiPipelineVerification) => {
    if (!pipeline || !Number.isFinite(pipeline.id)) return
    const existing = candidates.get(pipeline.id)
    if (existing) {
      existing.pipeline = { ...existing.pipeline, ...pipeline }
      existing.origins = uniqueStrings([...existing.origins, origin]) as GitLabCiPipelineVerification[]
      return
    }
    candidates.set(pipeline.id, { pipeline, origins: [origin] })
  }
  add(headPipeline, 'mr_head_pipeline_candidate')
  for (const pipeline of pipelines) add(pipeline, 'mr_pipeline_candidate')
  return [...candidates.values()]
}

function parseMergeRequestPipelineRef(ref: string | undefined) {
  const match = ref?.match(/^refs\/merge-requests\/([^/]+)\/([^/]+)$/)
  if (!match) return undefined
  const value = match[2]
  const kind = value === 'head' || value === 'merge' || value === 'train' ? value : undefined
  return { mrIid: match[1]!, kind }
}

function integratedPipelineKind(
  ref: ReturnType<typeof parseMergeRequestPipelineRef>,
): GitLabCiPipelineKind {
  if (ref?.kind === 'merge') return 'merged_result'
  if (ref?.kind === 'train') return 'merge_train'
  return 'integrated'
}

function compareTrustedPipelines(left: GitLabCiPipeline, right: GitLabCiPipeline) {
  const priority = (pipeline: GitLabCiPipeline) => pipeline.kind === 'source' || pipeline.kind === 'detached' ? 1 : 2
  return priority(right) - priority(left) || right.id - left.id
}

function projectIdentityMatches(projectId: string | number, candidateProjectId: number | undefined) {
  if (candidateProjectId === undefined) return true
  const requested = String(projectId)
  return /^\d+$/.test(requested) ? requested === String(candidateProjectId) : true
}

function metadataDiagnostic(error: unknown, signal: AbortSignal | undefined) {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return 'ci_request_aborted'
  return `ci_pipeline_metadata_unavailable:${errorName(error)}`
}

function emptyPipelineSelection(diagnostic: string): GitLabCiPipelineSelection {
  return { diagnostics: [diagnostic] }
}

function projectCiJob(job: GitLabPipelineJob): GitLabCiJob {
  return compactObject({
    id: job.id,
    name: boundedString(job.name, 512),
    stage: boundedString(job.stage, 512),
    status: boundedString(job.status, 512),
    allowFailure: job.allow_failure,
    webUrl: boundedString(job.web_url, 4_096),
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    duration: job.duration,
  }) as GitLabCiJob
}

function emptyJobLogResult(diagnostic: string): GitLabCiJobLogResult {
  return { trace: undefined, bytes: 0, truncated: false, diagnostics: [diagnostic] }
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function boundedString(value: string | undefined, maxLength: number) {
  return value?.slice(0, maxLength)
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}
