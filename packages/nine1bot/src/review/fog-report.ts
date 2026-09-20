import { z } from 'zod'
import { parseReviewStageResult, validateGitLabInlinePosition, type GitLabDiffManifest, type GitLabCiListResult, type GitLabMergeRequestMetadata, type GitLabProjectSummary, type ReviewStageResult } from '@nine1bot/platform-gitlab/review'
import { redactGitLabSecrets } from '../../../platform-gitlab/src/review/secret-redaction'

export const FOG_MAX_BYTES = 256 * 1024
const status = z.enum(['completed', 'needs_attention', 'blocked', 'failed', 'ignored'])
const text = z.string().min(1).max(32_768)
const httpUrl = z.string().max(4096).url().refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
})

export const FogReportSchema = z.object({
  projectKey: z.string().min(1).max(1024),
  externalKey: z.string().min(1).max(128),
  idempotencyKey: z.string().uuid(),
  triggerType: z.literal('merge_request'),
  kind: z.literal('review.completed'),
  status,
  title: text,
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  summary: text,
  mergeRequestIid: z.number().int().positive(),
  sourceBranch: z.string().min(1).max(512),
  targetBranch: z.string().min(1).max(512),
  source: z.object({ url: httpUrl, revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i), pipelineUrl: httpUrl.optional() }).strict(),
  review: z.object({ status, findings: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low', 'info']),
    file: z.string().min(1).max(4096).optional(),
    line: z.number().int().positive().optional(),
    message: text,
  }).strict()).max(100) }).strict(),
  ci: z.object({
    status: z.enum(['success', 'failed']), evidence: text,
    testsRun: z.array(text).max(100), uncovered: z.array(text).max(150),
  }).strict(),
}).strict()
export type FogReport = z.infer<typeof FogReportSchema>

export type FogSeed = {
  runId: string
  generation: string
  payloadHash: string
  baseUrl: string
  host: string
  projectId: string | number
  projectPath?: string
  mrIid: number
  headSha: string
  result: ReviewStageResult
  coverage: string[]
}

export function fogSafeText(value: string, secrets: string[] = []) {
  let clean = value
  for (const secret of secrets) if (secret) clean = clean.split(secret).join('[REDACTED]')
  return redactGitLabSecrets(clean)
}

export function fogResultSnapshot(value: unknown, manifest?: GitLabDiffManifest): ReviewStageResult {
  const parsed = parseReviewStageResult(value)
  if (parsed.stage !== 'closed') throw new Error('fog_review_not_closed')
  // Clean text values rather than serialized JSON, preserving escapes and field types.
  return {
    stage: parsed.stage, status: parsed.status, summary: fogSafeText(parsed.summary),
    findings: parsed.findings.map((finding) => {
      const validated = manifest ? validateGitLabInlinePosition(finding, manifest.files, manifest.diffRefs) : undefined
      return {
        title: fogSafeText(finding.title), body: fogSafeText(finding.body), severity: finding.severity,
        ...(finding.file ? {
          file: fogSafeText(validated?.ok ? validated.position.new_path! : finding.file),
          newLine: validated?.ok ? validated.position.new_line : undefined,
        } : {}),
      }
    }),
    nextActions: parsed.nextActions?.map((value) => fogSafeText(value)),
  }
}

export function buildFogReport(input: {
  seed: FogSeed
  idempotencyKey: string
  project: GitLabProjectSummary
  mr: GitLabMergeRequestMetadata
  ci: GitLabCiListResult
  now: number
  secrets?: string[]
}): FogReport {
  const { seed, project, mr, ci } = input
  const pipeline = ci.pipeline
  if (!pipeline || !['success', 'failed'].includes(pipeline.status ?? '')) throw new Error('fog_ci_not_final')
  if (pipeline.sha !== seed.headSha || !pipeline.verification.includes('head_sha_exact')) throw new Error('fog_ci_sha_mismatch')
  if (String(project.id) !== String(seed.projectId) || String(mr.project_id) !== String(seed.projectId)
    || mr.iid !== seed.mrIid || mr.diff_refs?.head_sha !== seed.headSha
    || (seed.projectPath && project.path_with_namespace !== seed.projectPath)) throw new Error('fog_source_identity_mismatch')
  if (!project.name || !project.path_with_namespace || !mr.title || !mr.source_branch || !mr.target_branch) throw new Error('fog_source_metadata_missing')
  const clean = (value: string) => fogSafeText(value, input.secrets)
  const uncovered = [...seed.coverage, ...(seed.result.nextActions ?? []), ...ci.diagnostics].map(clean)
  if (ci.truncated) uncovered.push('CI job listing was truncated; not all jobs were inspected.')
  if (!ci.jobs.length) uncovered.push('No executed job details are available; pipeline status alone does not prove test coverage.')
  const testsRun: string[] = []
  for (const job of ci.jobs) {
    const label = clean(`${job.name ?? `job ${job.id}`} (#${job.id}, ${job.status ?? 'unknown'})`)
    if (job.startedAt && ['success', 'failed'].includes(job.status ?? '')) testsRun.push(label)
    else uncovered.push(`Execution not confirmed or not completed: ${label}`)
    if (job.allowFailure && job.status === 'failed') uncovered.push(`Allowed failure: ${label}`)
  }
  const reviewStatus = seed.result.status === 'ok'
    ? (seed.result.findings.length ? 'needs_attention' : 'completed')
    : seed.result.status
  const reportStatus = reviewStatus === 'completed' && (pipeline.status === 'failed' || uncovered.length)
    ? 'needs_attention' : reviewStatus
  const projectUrl = `${seed.baseUrl.replace(/\/$/, '')}/${project.path_with_namespace.split('/').map(encodeURIComponent).join('/')}`
  const evidence = `GitLab pipeline #${pipeline.id}: ${pipeline.status}; SHA ${pipeline.sha}. Job statuses describe execution, not unobserved test cases.`
  const severity = { blocker: 'high', critical: 'high', major: 'medium', minor: 'low', info: 'info' } as const
  const report = FogReportSchema.parse({
    projectKey: project.path_with_namespace, externalKey: `gitlab:mr:${seed.mrIid}`,
    idempotencyKey: input.idempotencyKey, triggerType: 'merge_request', kind: 'review.completed', status: reportStatus,
    title: clean(`${project.name} · MR !${seed.mrIid} · ${mr.title}`),
    occurredAt: new Date(input.now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    summary: clean(`${seed.result.summary}\nCI: ${evidence}`),
    mergeRequestIid: seed.mrIid, sourceBranch: mr.source_branch, targetBranch: mr.target_branch,
    source: { url: `${projectUrl}/-/merge_requests/${seed.mrIid}`, revision: seed.headSha, pipelineUrl: `${projectUrl}/-/pipelines/${pipeline.id}` },
    review: { status: reviewStatus, findings: seed.result.findings.map((finding) => ({
      severity: severity[finding.severity], message: clean(`${finding.title}\n${finding.body}`),
      ...(finding.file ? { file: clean(finding.file) } : {}),
      ...(finding.file && Number.isSafeInteger(finding.newLine) && finding.newLine! > 0 ? { line: finding.newLine } : {}),
    })) },
    ci: { status: pipeline.status, evidence, testsRun, uncovered: [...new Set(uncovered)] },
  })
  if (Buffer.byteLength(JSON.stringify(report)) > FOG_MAX_BYTES) throw new Error('fog_report_too_large')
  return report
}
