import { join } from 'node:path'
import {
  GitLabApiClient, inspectGitLabCi, isGitLabReviewTargetAllowed, normalizeGitLabReviewSettings,
  resolveGitLabApiBaseUrl, resolveGitLabReviewProjectProfile,
  type GitLabReviewContext, type GitLabReviewSettings, type GitLabReviewTrigger, type ReviewStageResult,
} from '@nine1bot/platform-gitlab/review'
import { getDataDir } from '../config/loader'
import { readPlatformManagerConfig } from '../platform/config-store'
import { FilePlatformSecretStore } from '../platform/secrets'
import { ReviewRunStore, type ReviewRunRecord } from './run-store'
import { fogResultSnapshot, type FogSeed } from './fog-report'
import { FogDeliveryWorker, FogDiagnostic, readFogConfig } from './fog-delivery'
import { FogOutbox } from './fog-store'

let outbox: FogOutbox | undefined
let worker: FogDeliveryWorker | undefined
let timer: ReturnType<typeof setInterval> | undefined
let runtimeDiagnostic: string | undefined

function store() {
  return outbox ??= new FogOutbox(process.env.FOG_OUTBOX_PATH || join(getDataDir(), 'fog', 'outbox.sqlite'))
}

export function confirmFogPublication(runId: string, generation: string, payloadHash: string) {
  if (!readFogConfig().enabled) return
  try { store().confirmPublication(runId, generation, payloadHash) }
  catch { runtimeDiagnostic = 'fog_publication_confirmation_pending' }
}

// A failure in this optional integration must never stop GitLab publication.
export function captureFogReview(input: {
  run: ReviewRunRecord; trigger: GitLabReviewTrigger; context: GitLabReviewContext
  settings: GitLabReviewSettings; result: ReviewStageResult; payloadHash: string
}): string | undefined {
  const config = readFogConfig()
  if (!config.enabled || input.trigger.objectType !== 'mr') return undefined
  try {
    const resolved = resolveGitLabApiBaseUrl({ configuredBaseUrl: input.settings.baseUrl, triggerHost: input.trigger.host })
    const mrIid = Number(input.trigger.objectIid)
    if (!resolved.ok || !Number.isSafeInteger(mrIid) || mrIid < 1 || !input.trigger.headSha) throw new Error()
    const coverage: string[] = []
    if (input.context.diff.stats.truncated) coverage.push('Review diff/context was truncated.')
    if (input.context.diff.stats.skippedFileCount) coverage.push(`${input.context.diff.stats.skippedFileCount} changed files were not included in the review diff.`)
    store().enqueue({
      runId: input.run.id, generation: input.run.generation, payloadHash: input.payloadHash,
      baseUrl: resolved.baseUrl, host: input.trigger.host, projectId: input.trigger.projectId,
      projectPath: input.trigger.projectPath, mrIid, headSha: input.trigger.headSha,
      result: fogResultSnapshot(input.result, input.context.diff), coverage,
    }, config.endpoint)
    return undefined
  } catch {
    runtimeDiagnostic = 'fog_capture_failed'
    return 'fog_capture_failed: GitLab review continues; FOG report was not queued.'
  }
}

async function authorizedClient(seed: FogSeed) {
  const platforms = await readPlatformManagerConfig()
  const settings = normalizeGitLabReviewSettings(platforms.gitlab?.settings)
  const resolved = resolveGitLabApiBaseUrl({ configuredBaseUrl: settings.baseUrl, triggerHost: seed.host })
  const profile = resolveGitLabReviewProjectProfile(settings, seed)
  if (!platforms.gitlab?.enabled || !settings.enabled || settings.dryRun || settings.configurationErrors.length
    || !resolved.ok || resolved.baseUrl !== seed.baseUrl
    || !isGitLabReviewTargetAllowed(settings, seed.host, seed.projectId, seed.projectPath)
    || profile.status !== 'matched') {
    throw new FogDiagnostic('fog_gitlab_configuration_changed', 'waiting_config')
  }
  const ref = settings.tokenSecretRef
  const token = typeof ref === 'string' ? ref : ref
    ? await new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH).get(ref) : undefined
  if (!token) throw new FogDiagnostic('fog_gitlab_token_missing', 'waiting_config')
  return { token, client: new GitLabApiClient({ baseUrl: resolved.baseUrl, token, requestTimeoutMs: 10_000 }) }
}

function deliveryWorker() {
  return worker ??= new FogDeliveryWorker(store(), {
    config: readFogConfig,
    publication(seed) {
      const run = ReviewRunStore.get(seed.runId)
      if (!run || run.generation !== seed.generation || run.publication?.payloadHash !== seed.payloadHash) return 'unavailable'
      if (run.publishedAt && run.publication.state === 'published') return 'confirmed'
      return run.status === 'running' || run.status === 'accepted' || run.publication.state === 'partial' ? 'pending' : 'unavailable'
    },
    authorize: authorizedClient,
    async evidence(seed, signal) {
      const { client } = await authorizedClient(seed)
      const project = await client.getProject(seed.projectId, { signal })
      const mr = await client.getMergeRequest(seed.projectId, seed.mrIid, { signal })
      if (String(project.id) !== String(seed.projectId) || String(mr.project_id) !== String(seed.projectId)
        || mr.iid !== seed.mrIid || mr.diff_refs?.head_sha !== seed.headSha
        || (seed.projectPath && project.path_with_namespace !== seed.projectPath)) {
        throw new FogDiagnostic('fog_source_identity_mismatch')
      }
      const ci = await inspectGitLabCi({ client, projectId: seed.projectId, mrIid: seed.mrIid, headSha: seed.headSha, signal })
      return { project, mr, ci }
    },
  })
}

export function startFogDelivery() {
  if (timer || !readFogConfig().enabled) return
  const tick = () => {
    try { void deliveryWorker().tick().catch(() => { runtimeDiagnostic = 'fog_worker_unavailable' }) }
    catch { runtimeDiagnostic = 'fog_worker_unavailable' }
  }
  timer = setInterval(tick, 60_000)
  timer.unref()
  tick()
}

export async function stopFogDelivery() {
  if (timer) clearInterval(timer)
  timer = undefined
  await worker?.stop().catch(() => { runtimeDiagnostic = 'fog_worker_unavailable' })
  worker = undefined
  try { outbox?.close() } catch { runtimeDiagnostic = 'fog_store_unavailable' }
  outbox = undefined
}

export function fogDeliveryStatus(limit = 100, offset = 0) {
  const config = readFogConfig()
  const summary = { enabled: config.enabled, configured: Boolean(config.endpoint && config.token), diagnostic: runtimeDiagnostic ?? config.diagnostic }
  if (!config.enabled) return { ...summary, reports: [] }
  try {
    return { ...summary, reports: store().list(limit, offset).map((record) => ({
      runId: record.runId, idempotencyKey: record.idempotencyKey, state: record.state,
      diagnostic: record.diagnostic, createdAt: record.createdAt, updatedAt: record.updatedAt,
      nextAt: record.nextAt, attempts: record.attempts, receipt: record.receipt,
    })) }
  } catch { return { ...summary, diagnostic: 'fog_store_unavailable', reports: [] } }
}

export function retryFogDelivery(runId: string) {
  if (!readFogConfig().enabled) return false
  const retried = store().retry(runId)
  startFogDelivery()
  return retried
}
