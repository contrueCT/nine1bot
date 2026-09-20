import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GitLabApiClient } from '@nine1bot/platform-gitlab/review'
import { buildFogReport, fogResultSnapshot, type FogSeed } from './fog-report'
import { FogOutbox } from './fog-store'
import { FogDeliveryWorker, FogDiagnostic, readFogConfig, type FogDeliveryDependencies, type FogEvidence } from './fog-delivery'

const sha = 'a'.repeat(40)
function seed(): FogSeed {
  return {
    runId: 'review-test', generation: 'generation', payloadHash: 'b'.repeat(64),
    host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com', projectId: 57,
    projectPath: 'studio/backend', mrIid: 4, headSha: sha, coverage: [],
    result: { stage: 'closed', status: 'ok', summary: 'No defects found.', findings: [] },
  }
}
function evidence(): FogEvidence {
  return {
    project: { id: 57, name: 'backend', path_with_namespace: 'studio/backend' },
    mr: { iid: 4, project_id: 57, title: 'Fix errors', source_branch: 'fix', target_branch: 'main', diff_refs: { head_sha: sha } },
    ci: {
      pipeline: { id: 448, sha, status: 'success', kind: 'detached', verification: ['mr_pipeline_candidate', 'head_sha_exact'] },
      jobs: [{ id: 1, name: 'unit', status: 'success', startedAt: '2026-09-19T00:00:00Z' }],
      diagnostics: [], truncated: false, totalJobs: 1, returnedJobs: 1,
    },
  }
}
function report(overrides: Partial<Parameters<typeof buildFogReport>[0]> = {}) {
  return buildFogReport({ seed: seed(), idempotencyKey: randomUUID(), ...evidence(), now: Date.UTC(2026, 8, 18, 20), ...overrides })
}
const endpoint = 'https://fog.example.com/api/v1/agent-reports'
let directory: string
const stores: FogOutbox[] = []
function open(limit?: number) {
  const store = new FogOutbox(join(directory, 'outbox.sqlite'), limit)
  stores.push(store)
  return store
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'nine1bot-fog-')) })
afterEach(() => { for (const store of stores.splice(0)) store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('FOG protocol', () => {
  test('maps MR identity, actual title, Beijing time and executed jobs', () => {
    const value = report()
    expect(value).toMatchObject({
      projectKey: 'studio/backend', externalKey: 'gitlab:mr:4', triggerType: 'merge_request', kind: 'review.completed',
      title: 'backend · MR !4 · Fix errors', occurredAt: '2026-09-19 04:00:00', status: 'completed',
      source: { revision: sha, url: 'https://gitlab.example.com/studio/backend/-/merge_requests/4' },
      ci: { status: 'success', testsRun: ['unit (#1, success)'], uncovered: [] },
    })
  })
  test.each(['running', 'pending', 'canceled', 'skipped', 'manual', undefined])('does not fabricate a final CI result for %s', (status) => {
    const data = evidence(); data.ci.pipeline!.status = status
    expect(() => report(data)).toThrow('fog_ci_not_final')
  })
  test('rejects missing CI, different SHA and unverified CI', () => {
    const data = evidence(); data.ci.pipeline = undefined
    expect(() => report(data)).toThrow('fog_ci_not_final')
    data.ci = evidence().ci; data.ci.pipeline!.sha = 'b'.repeat(40)
    expect(() => report(data)).toThrow('fog_ci_sha_mismatch')
    data.ci.pipeline!.sha = sha; data.ci.pipeline!.verification = ['temporary_commit_contains_head']
    expect(() => report(data)).toThrow('fog_ci_sha_mismatch')
  })
  test('rejects mismatched project, changed MR head and absent metadata', () => {
    const data = evidence(); data.project.id = 99
    expect(() => report(data)).toThrow('fog_source_identity_mismatch')
    data.project.id = 57; data.mr.diff_refs!.head_sha = 'c'.repeat(40)
    expect(() => report(data)).toThrow('fog_source_identity_mismatch')
    data.mr.diff_refs!.head_sha = sha; data.mr.title = undefined
    expect(() => report(data)).toThrow('fog_source_metadata_missing')
  })
  test('does not equate successful pipeline with tests having executed', () => {
    const data = evidence()
    data.ci.jobs = [{ id: 1, name: 'unit', status: 'success', startedAt: null }, { id: 2, name: 'lint', status: 'skipped' }]
    const value = report(data)
    expect(value.ci.testsRun).toEqual([])
    expect(value.ci.uncovered).toHaveLength(2)
    expect(value.status).toBe('needs_attention')
  })
  test('CI failures, allowed failures, truncated listings and missing details remain visible', () => {
    const data = evidence(); data.ci.pipeline!.status = 'failed'; data.ci.truncated = true
    data.ci.jobs = [{ id: 2, name: 'unit', status: 'failed', startedAt: '2026-09-19', allowFailure: true }]
    expect(report(data)).toMatchObject({ status: 'needs_attention', review: { status: 'completed' }, ci: { status: 'failed' } })
    expect(report(data).ci.uncovered).toHaveLength(2)
    data.ci.jobs = []
    expect(report(data).ci.uncovered.join(' ')).toContain('No executed job details')
  })
  test('maps finding severity, omits guessed old/deleted line numbers and redacts secrets', () => {
    const value = seed()
    value.result.findings = [{ title: 'Leak', body: 'token=glpat-secret', severity: 'critical', file: 'src/a.ts', oldLine: 9 }]
    value.result.summary = 'Review secret-value'
    const result = report({ seed: value, secrets: ['secret-value'] })
    expect(result.review.findings[0]).toEqual({ severity: 'high', file: 'src/a.ts', message: 'Leak\ntoken=***' })
    expect(JSON.stringify(result)).not.toContain('secret-value')
    expect(JSON.stringify(result)).not.toContain('glpat-secret')
  })
  test.each(['blocked', 'failed'] as const)('keeps review %s distinct from a successful CI result', (status) => {
    const value = seed(); value.result.status = status
    expect(report({ seed: value })).toMatchObject({ status, review: { status }, ci: { status: 'success' } })
  })
  test('validates and sanitizes the persisted stage result', () => {
    expect(fogResultSnapshot({ ...seed().result, summary: 'password=secret', findings: [] }).summary).not.toContain('secret')
    expect(() => fogResultSnapshot({ ...seed().result, stage: 'planning' })).toThrow()
    expect(() => report({ seed: { ...seed(), result: { ...seed().result, summary: 'x'.repeat(40_000) } } })).toThrow()
  })
  test('only persists line numbers that match the frozen diff', () => {
    const result = seed().result
    result.findings = [
      { title: 'Valid', body: 'Valid line', severity: 'major', file: 'src/a.ts', newLine: 2 },
      { title: 'Invalid', body: 'Outside hunk', severity: 'major', file: 'src/a.ts', newLine: 999 },
    ]
    const snapshot = fogResultSnapshot(result, {
      files: [{ oldPath: 'src/a.ts', newPath: 'src/a.ts', diff: '@@ -1 +1,2 @@\n context\n+added\n', added: false, renamed: false, deleted: false, generated: false }],
      skipped: [], blocked: false,
      stats: { fileCount: 1, includedFileCount: 1, skippedFileCount: 0, includedBytes: 40, truncated: false },
    })
    expect(snapshot.findings[0].newLine).toBe(2)
    expect(snapshot.findings[1].newLine).toBeUndefined()
  })
})

describe('FOG configuration and metadata', () => {
  test('is opt-in and requires explicit plaintext HTTP consent', () => {
    expect(readFogConfig({}).enabled).toBe(false)
    const env = { FOG_REPORTS_ENABLED: 'true', FOG_AGENT_REPORT_URL: 'http://10.0.0.1/api/v1/agent-reports', FOG_AGENT_REPORT_TOKEN: 'private-token' }
    expect(readFogConfig(env).diagnostic).toBe('fog_endpoint_invalid')
    expect(readFogConfig({ ...env, FOG_ALLOW_INSECURE_HTTP: 'true' }).diagnostic).toBeUndefined()
    expect(readFogConfig({ ...env, FOG_AGENT_REPORT_URL: 'https://user:pass@fog.test/' }).diagnostic).toBe('fog_endpoint_invalid')
  })
  test('reads token files without including file errors in diagnostics', () => {
    const path = join(directory, 'secret')
    writeFileSync(path, 'file-secret\n')
    const env = { FOG_REPORTS_ENABLED: 'true', FOG_AGENT_REPORT_URL: endpoint, FOG_AGENT_REPORT_TOKEN_FILE: path }
    expect(readFogConfig(env).token).toBe('file-secret')
    writeFileSync(path, 'x'.repeat(9000))
    expect(readFogConfig(env)).toMatchObject({ token: '', diagnostic: 'fog_token_unavailable' })
  })
  test('projects bounded GitLab metadata without carrying unrelated response fields', async () => {
    const client = new GitLabApiClient({ baseUrl: 'https://gitlab.example.com', token: 'git-token', fetch: (async (url) => {
      return Response.json(String(url).includes('merge_requests')
        ? { ...evidence().mr, description: 'private', title: 'x'.repeat(600) }
        : { ...evidence().project, description: 'private' })
    }) as typeof fetch })
    expect((await client.getMergeRequest(57, 4)).title?.length).toBeLessThanOrEqual(512)
    expect(await client.getProject(57)).not.toHaveProperty('description')
  })
})

describe('FOG durable outbox', () => {
  test('deduplicates a run across store instances and rejects a conflicting attempt', () => {
    const first = open().enqueue(seed(), endpoint)
    expect(open().enqueue(seed(), endpoint).idempotencyKey).toBe(first.idempotencyKey)
    expect(() => open().enqueue({ ...seed(), generation: 'other' }, endpoint)).toThrow('fog_seed_conflict')
  })
  test('keeps distinct attempts separate and bounds storage', () => {
    const store = open(2)
    const a = store.enqueue(seed(), endpoint)
    const b = store.enqueue({ ...seed(), runId: 'retry-attempt' }, endpoint)
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
    expect(() => store.enqueue({ ...seed(), runId: 'third' }, endpoint)).toThrow('fog_outbox_full')
  })
  test('exclusive leases prevent competing workers and explicit retries during delivery', () => {
    const a = open(); const b = open()
    a.enqueue(seed(), endpoint)
    const claim = a.claim(Date.now())!
    expect(b.claim(Date.now())).toBeUndefined()
    expect(b.retry(seed().runId)).toBe(false)
    expect(() => b.save(claim.record, 'not-the-owner')).toThrow('fog_lease_lost')
    claim.record.nextAt = Date.now() + 5000
    a.save(claim.record, claim.lease)
    expect(b.claim(Date.now())).toBeUndefined()
    expect(b.retry(seed().runId)).toBe(true)
  })
  test('expired leases can recover after a crashed process', () => {
    const store = open(); store.enqueue(seed(), endpoint, Date.now() - 200_000)
    const old = store.claim(Date.now() - 150_000)!
    expect(store.claim(Date.now())).toBeDefined()
    expect(() => store.save(old.record, old.lease)).toThrow('fog_lease_lost')
  })
  test('worker checkpoints cannot undo a concurrently confirmed publication', () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const claim = store.claim(Date.now())!
    store.confirmPublication(seed().runId, seed().generation, seed().payloadHash)
    expect(claim.record.published).toBe(false)
    store.save(claim.record, claim.lease)
    expect(store.get(seed().runId)?.published).toBe(true)
  })
})

function delivery(store: FogOutbox, overrides: Partial<FogDeliveryDependencies> = {}) {
  const bodies: string[] = []
  const requests: RequestInit[] = []
  const deps: FogDeliveryDependencies = {
    config: () => ({ enabled: true, endpoint, token: 'fog-token' }),
    publication: () => 'confirmed', authorize: async () => ({ token: 'git-token' }),
    evidence: async () => evidence(),
    fetch: (async (_url, init) => {
      bodies.push(String(init?.body)); requests.push(init!)
      return Response.json({ accepted: true, workItemId: 'work-1', reportId: 'report-1' })
    }) as typeof fetch,
    ...overrides,
  }
  return { worker: new FogDeliveryWorker(store, deps), deps, bodies, requests }
}

describe('FOG delivery', () => {
  test('waits for GitLab publication, then sends once and persists acceptance', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store, { publication: () => 'pending' })
    await d.worker.tick()
    expect(store.get(seed().runId)?.state).toBe('waiting_publication')
    expect(d.bodies).toHaveLength(0)
    d.deps.publication = () => 'confirmed'; store.retry(seed().runId)
    await d.worker.tick(); await d.worker.tick()
    expect(d.bodies).toHaveLength(1)
    expect(d.requests[0].redirect).toBe('manual')
    expect(store.get(seed().runId)).toMatchObject({ state: 'sent', attempts: 1, receipt: { reportId: 'report-1' } })
    expect(store.retry(seed().runId)).toBe(false)
  })
  test('missing publication evidence requires attention, never fabricates success', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store, { publication: () => 'unavailable' })
    await d.worker.tick()
    expect(store.get(seed().runId)?.diagnostic).toBe('fog_publication_unconfirmed')
    expect(d.bodies).toHaveLength(0)
  })
  test.each(['running', 'canceled', 'skipped', undefined])('waits for CI %s without consuming delivery attempts', async (status) => {
    const store = open(); store.enqueue(seed(), endpoint)
    const data = evidence(); data.ci.pipeline!.status = status
    const d = delivery(store, { evidence: async () => data })
    await d.worker.tick()
    expect(store.get(seed().runId)).toMatchObject({ state: 'waiting_ci', attempts: 0 })
    expect(d.bodies).toHaveLength(0)
  })
  test('holds a trusted merged-result pipeline whose SHA differs from the reviewed source', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const data = evidence(); data.ci.pipeline!.sha = 'c'.repeat(40); data.ci.pipeline!.kind = 'merged_result'
    const d = delivery(store, { evidence: async () => data })
    await d.worker.tick()
    expect(store.get(seed().runId)?.diagnostic).toBe('fog_ci_sha_mismatch')
    expect(d.bodies).toHaveLength(0)
  })
  test('missing FOG token retains a prepared payload for configuration recovery', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store, { config: () => ({ enabled: true, endpoint, token: '' }) })
    await d.worker.tick()
    expect(store.get(seed().runId)).toMatchObject({ state: 'waiting_config', attempts: 0 })
    expect(store.get(seed().runId)?.payload).toBeDefined()
    d.deps.config = () => ({ enabled: true, endpoint, token: 'fog-token' }); store.retry(seed().runId)
    await d.worker.tick(); expect(d.bodies).toHaveLength(1)
  })
  test('lost HTTP response retries exact payload and idempotency key after reopening', async () => {
    const store = open(); const first = store.enqueue(seed(), endpoint)
    let firstBody = ''
    await delivery(store, { fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      firstBody = String(init?.body); throw new Error('Bearer fog-token transport error')
    }) as unknown as typeof fetch }).worker.tick()
    expect(store.get(seed().runId)?.diagnostic).toBe('fog_delivery_unavailable')
    const recovered = open(); recovered.retry(seed().runId)
    const d = delivery(recovered, { evidence: async () => { throw new Error('must not regenerate') } })
    await d.worker.tick()
    expect(d.bodies[0]).toBe(firstBody)
    expect(JSON.parse(d.bodies[0]).idempotencyKey).toBe(first.idempotencyKey)
  })
  test.each([301, 302, 307, 308, 400, 401, 403, 422])('HTTP %s blocks without following redirects or storing response bodies', async (status) => {
    const store = open(); store.enqueue(seed(), endpoint)
    let calls = 0
    const d = delivery(store, { fetch: (async (_url, init) => {
      calls++; expect(init?.redirect).toBe('manual')
      return new Response('fog-token private response', { status, headers: { Location: 'https://untrusted.example/' } })
    }) as typeof fetch })
    await d.worker.tick(); await d.worker.tick()
    expect(calls).toBe(1)
    expect(store.get(seed().runId)).toMatchObject({ state: 'blocked', diagnostic: `fog_http_${status}` })
    expect(JSON.stringify(store.get(seed().runId))).not.toContain('fog-token')
  })
  test.each([408, 429, 500, 503])('HTTP %s uses backoff', async (status) => {
    const store = open(); store.enqueue(seed(), endpoint)
    await delivery(store, { fetch: (async () => new Response('', { status })) as unknown as typeof fetch }).worker.tick()
    expect(store.get(seed().runId)).toMatchObject({ state: 'retry', attempts: 1 })
    expect(store.get(seed().runId)!.nextAt).toBeGreaterThan(Date.now())
  })
  test('rejects oversized and invalid acceptance receipts', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store, { fetch: (async () => new Response('x'.repeat(17_000))) as unknown as typeof fetch })
    await d.worker.tick()
    expect(store.get(seed().runId)?.diagnostic).toBe('fog_receipt_too_large')
    store.retry(seed().runId)
    d.deps.fetch = (async () => Response.json({ accepted: false })) as unknown as typeof fetch
    await d.worker.tick()
    expect(store.get(seed().runId)?.diagnostic).toBe('fog_receipt_invalid')
  })
  test('blocks changed destinations, including on explicit retries', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store, { config: () => ({ enabled: true, endpoint: 'https://different.example/', token: 'token' }) })
    await d.worker.tick(); store.retry(seed().runId); await d.worker.tick()
    expect(store.get(seed().runId)?.diagnostic).toBe('fog_destination_changed')
    expect(d.bodies).toHaveLength(0)
  })
  test('rechecks GitLab scope and FOG configuration before HTTP POST', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    let calls = 0
    const d = delivery(store, { authorize: async () => {
      if (++calls > 1) throw new FogDiagnostic('fog_gitlab_configuration_changed', 'waiting_config')
      return { token: 'git-token' }
    } })
    await d.worker.tick()
    expect(store.get(seed().runId)?.state).toBe('waiting_config')
    expect(d.bodies).toHaveLength(0)
  })
  test('serializes overlapping ticks', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store)
    const a = d.worker.tick(); const b = d.worker.tick()
    expect(a).toBe(b)
    await a; expect(d.bodies).toHaveLength(1)
  })
  test('does not require pruned ReviewRun history after publication is durably confirmed', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    store.confirmPublication(seed().runId, seed().generation, seed().payloadHash)
    const d = delivery(store, { publication: () => 'unavailable' })
    await d.worker.tick()
    expect(store.get(seed().runId)?.state).toBe('sent')
  })
  test('retries truncated transport responses, rather than treating them as schema errors', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const d = delivery(store, { fetch: (async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new Error('connection lost')) },
    }))) as unknown as typeof fetch })
    await d.worker.tick()
    expect(store.get(seed().runId)).toMatchObject({ state: 'retry', diagnostic: 'fog_delivery_unavailable' })
  })
  test('stops automatic attempts after the eighth delivery failure', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const claim = store.claim(Date.now())!
    claim.record.attempts = 7
    store.save(claim.record, claim.lease)
    const d = delivery(store, { fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch })
    await d.worker.tick()
    expect(store.get(seed().runId)).toMatchObject({ state: 'blocked', attempts: 8, diagnostic: 'fog_retry_exhausted' })
  })
  test('does not send when disabled during evidence collection', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    const config = { enabled: true, endpoint, token: 'fog-token' }
    const d = delivery(store, { config: () => ({ ...config }), evidence: async () => { config.enabled = false; return evidence() } })
    await d.worker.tick()
    expect(d.bodies).toHaveLength(0)
    expect(store.get(seed().runId)?.state).toBe('waiting_config')
  })
  test('aborts active work and retains the report on worker shutdown', async () => {
    const store = open(); store.enqueue(seed(), endpoint)
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const d = delivery(store, { evidence: async (_seed, signal) => {
      started()
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
    } })
    const running = d.worker.tick()
    await ready; await d.worker.stop(); await running
    expect(d.bodies).toHaveLength(0)
    expect(store.get(seed().runId)?.state).toBe('retry')
  })
})
