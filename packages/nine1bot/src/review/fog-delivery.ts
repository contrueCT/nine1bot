import { readFileSync, statSync } from 'node:fs'
import { buildFogReport, fogSafeText, type FogSeed } from './fog-report'
import { FogOutbox, type FogRecord, type FogState } from './fog-store'
import type { GitLabCiListResult, GitLabMergeRequestMetadata, GitLabProjectSummary } from '@nine1bot/platform-gitlab/review'

export type FogConfig = { enabled: boolean; endpoint: string; token: string; diagnostic?: string }
export function readFogConfig(env: NodeJS.ProcessEnv = process.env): FogConfig {
  const config: FogConfig = { enabled: env.FOG_REPORTS_ENABLED === 'true', endpoint: '', token: '' }
  if (!config.enabled) return config
  try {
    const url = new URL(env.FOG_AGENT_REPORT_URL ?? '')
    if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && env.FOG_ALLOW_INSECURE_HTTP === 'true'))) {
      throw new Error()
    }
    config.endpoint = url.href
  } catch { config.diagnostic = 'fog_endpoint_invalid'; return config }
  try {
    if (env.FOG_AGENT_REPORT_TOKEN_FILE) {
      if (statSync(env.FOG_AGENT_REPORT_TOKEN_FILE).size > 8192) throw new Error()
      config.token = readFileSync(env.FOG_AGENT_REPORT_TOKEN_FILE, 'utf8').trim()
    } else config.token = env.FOG_AGENT_REPORT_TOKEN?.trim() ?? ''
    if (!config.token || config.token.length > 8192 || /[\r\n]/.test(config.token)) throw new Error()
  } catch { config.token = ''; config.diagnostic = 'fog_token_unavailable' }
  return config
}

export class FogDiagnostic extends Error {
  constructor(readonly diagnostic: string, readonly state: FogState = 'blocked') { super(diagnostic) }
}

export type FogEvidence = { project: GitLabProjectSummary; mr: GitLabMergeRequestMetadata; ci: GitLabCiListResult }
export type FogDeliveryDependencies = {
  config: () => FogConfig
  publication: (seed: FogSeed) => 'confirmed' | 'pending' | 'unavailable'
  authorize: (seed: FogSeed) => Promise<{ token: string }>
  evidence: (seed: FogSeed, signal: AbortSignal) => Promise<FogEvidence>
  fetch?: typeof fetch
}

export class FogDeliveryWorker {
  private active?: Promise<void>
  private controller?: AbortController
  constructor(private readonly store: FogOutbox, private readonly deps: FogDeliveryDependencies) {}

  tick(): Promise<void> {
    if (this.active) return this.active
    this.active = this.drain().finally(() => { this.active = undefined })
    return this.active
  }

  async stop() {
    this.controller?.abort()
    await this.active
  }

  private async drain() {
    if (!this.deps.config().enabled) return
    this.controller = new AbortController()
    for (let i = 0; i < 5 && !this.controller.signal.aborted; i++) {
      const claim = this.store.claim(Date.now())
      if (!claim) break
      const { record, lease } = claim
      try { await this.process(record, lease, this.controller.signal) }
      catch (error) {
        // Never persist raw transport errors, response bodies, URLs or credentials.
        const known = error instanceof FogDiagnostic
        record.state = known ? error.state : 'retry'
        record.diagnostic = known ? error.diagnostic : 'fog_delivery_unavailable'
        record.nextAt = Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(record.attempts, 6))
        if (record.attempts >= 8) { record.state = 'blocked'; record.diagnostic = 'fog_retry_exhausted' }
        record.updatedAt = Date.now()
        this.store.save(record, lease)
      }
    }
  }

  private async process(record: FogRecord, lease: string, signal: AbortSignal) {
    const config = this.deps.config()
    if (!config.enabled) throw new FogDiagnostic('fog_disabled', 'waiting_config')
    if (!record.published) {
      const publication = this.deps.publication(record.seed)
      if (publication !== 'confirmed') throw new FogDiagnostic(
        publication === 'pending' ? 'fog_waiting_publication' : 'fog_publication_unconfirmed',
        publication === 'pending' ? 'waiting_publication' : 'blocked',
      )
      record.published = true
    }
    if (!config.endpoint) throw new FogDiagnostic(config.diagnostic ?? 'fog_endpoint_invalid', 'waiting_config')
    if (record.destination && record.destination !== config.endpoint) throw new FogDiagnostic('fog_destination_changed')
    record.destination = config.endpoint
    const authorization = await this.deps.authorize(record.seed)
    if (!record.payload) {
      const evidence = await this.deps.evidence(record.seed, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
      const pipeline = evidence.ci.pipeline
      if (!pipeline || !['success', 'failed'].includes(pipeline.status ?? '')) {
        throw new FogDiagnostic('fog_ci_not_final', 'waiting_ci')
      }
      if (pipeline.sha !== record.seed.headSha) throw new FogDiagnostic('fog_ci_sha_mismatch', 'waiting_ci')
      try {
        record.payload = JSON.stringify(buildFogReport({
          seed: record.seed, idempotencyKey: record.idempotencyKey, ...evidence,
          now: Date.now(), secrets: [authorization.token, config.token],
        }))
      } catch { throw new FogDiagnostic('fog_report_validation_failed') }
      record.state = 'ready'
      record.updatedAt = Date.now()
      this.store.save(record, lease, false)
    }
    if (!config.token) throw new FogDiagnostic(config.diagnostic ?? 'fog_token_unavailable', 'waiting_config')
    // Re-check configuration and scope after asynchronous evidence collection.
    const current = this.deps.config()
    if (!current.enabled || current.endpoint !== config.endpoint || current.token !== config.token) {
      throw new FogDiagnostic('fog_configuration_changed', 'waiting_config')
    }
    const currentAuthorization = await this.deps.authorize(record.seed)
    const finalConfig = this.deps.config()
    if (!finalConfig.enabled || finalConfig.endpoint !== config.endpoint || finalConfig.token !== config.token) {
      throw new FogDiagnostic('fog_configuration_changed', 'waiting_config')
    }
    for (const secret of [current.token, currentAuthorization.token]) {
      if (secret && record.payload.includes(secret)) throw new FogDiagnostic('fog_payload_contains_credential')
    }
    signal.throwIfAborted()
    if (record.attempts >= 8) throw new FogDiagnostic('fog_retry_exhausted')
    record.attempts++
    record.state = 'retry'
    record.nextAt = Date.now() + 60_000
    record.updatedAt = Date.now()
    // Persist the immutable payload and attempt BEFORE sending, including on crash recovery.
    this.store.save(record, lease, false)
    const response = await (this.deps.fetch ?? fetch)(record.destination, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: record.payload,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new FogDiagnostic(`fog_http_${response.status}`,
        response.status === 429 || response.status >= 500 || response.status === 408 ? 'retry' : 'blocked')
    }
    const receipt = await readReceipt(response)
    record.receipt = {
      workItemId: fogSafeText(receipt.workItemId, [config.token, currentAuthorization.token]),
      reportId: fogSafeText(receipt.reportId, [config.token, currentAuthorization.token]),
    }
    record.state = 'sent'
    record.diagnostic = ''
    record.updatedAt = Date.now()
    this.store.save(record, lease)
  }
}

async function readReceipt(response: Response): Promise<{ workItemId: string; reportId: string }> {
  const reader = response.body?.getReader()
  if (!reader) throw new FogDiagnostic('fog_receipt_invalid')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 16_384) throw new FogDiagnostic('fog_receipt_too_large')
      chunks.push(chunk.value)
    }
    let value: any
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new FogDiagnostic('fog_receipt_invalid') }
    if (value?.accepted !== true || typeof value.workItemId !== 'string' || !value.workItemId
      || value.workItemId.length > 256 || typeof value.reportId !== 'string' || !value.reportId || value.reportId.length > 256) {
      throw new FogDiagnostic('fog_receipt_invalid')
    }
    return { workItemId: value.workItemId, reportId: value.reportId }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
