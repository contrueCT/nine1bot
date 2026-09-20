import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeGitLabReviewSettings, type GitLabReviewContext, type GitLabReviewTrigger } from '@nine1bot/platform-gitlab/review'
import { captureFogReview, confirmFogPublication, fogDeliveryStatus, startFogDelivery, stopFogDelivery } from './fog-runtime'
import { ReviewRunStore } from './run-store'

test('runtime recovers a persisted published report and delivers over real HTTP without model tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fog-runtime-'))
  const envKeys = ['FOG_REPORTS_ENABLED', 'FOG_AGENT_REPORT_URL', 'FOG_ALLOW_INSECURE_HTTP', 'FOG_AGENT_REPORT_TOKEN', 'FOG_AGENT_REPORT_TOKEN_FILE', 'FOG_OUTBOX_PATH', 'NINE1BOT_CONFIG_PATH']
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const headSha = 'a'.repeat(40)
  let posts = 0
  let posted: any
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/v1/agent-reports') {
      expect(request.headers.get('authorization')).toBe('Bearer fog-test-secret')
      return request.json().then((body) => {
        posts++; posted = body
        return Response.json({ accepted: true, workItemId: 'work-1', reportId: 'report-1' })
      })
    }
    expect(request.headers.get('private-token')).toBe('gitlab-test-secret')
    if (path === '/api/v4/projects/57') return Response.json({ id: 57, name: 'backend', path_with_namespace: 'studio/backend' })
    if (path.endsWith('/merge_requests/4')) return Response.json({ iid: 4, project_id: 57, title: 'Fix errors', source_branch: 'fix', target_branch: 'main', diff_refs: { head_sha: headSha } })
    if (path.endsWith('/merge_requests/4/pipelines')) return Response.json([{ id: 448, project_id: 57, sha: headSha, status: 'failed', ref: 'refs/merge-requests/4/head' }])
    if (path.endsWith('/pipelines/448/jobs')) return Response.json([{ id: 1, name: 'unit', status: 'failed', started_at: '2026-09-19T00:00:00Z' }])
    return new Response('unknown endpoint', { status: 404 })
  } })
  await stopFogDelivery()
  try {
    process.env.FOG_REPORTS_ENABLED = 'true'
    process.env.FOG_ALLOW_INSECURE_HTTP = 'true'
    process.env.FOG_AGENT_REPORT_URL = `${server.url.origin}/api/v1/agent-reports`
    process.env.FOG_AGENT_REPORT_TOKEN = 'fog-test-secret'
    delete process.env.FOG_AGENT_REPORT_TOKEN_FILE
    process.env.FOG_OUTBOX_PATH = join(directory, 'outbox.sqlite')
    process.env.NINE1BOT_CONFIG_PATH = join(directory, 'config.json')
    const settings = {
      'review.enabled': true, 'review.dryRun': false, 'review.baseUrl': server.url.origin,
      'review.tokenSecretRef': 'gitlab-test-secret', allowedHosts: [server.url.host],
      'review.scopeMode': 'selected-only', 'review.includedProjects': [{ id: 57, pathWithNamespace: 'studio/backend' }],
      'review.projects': [{ id: 'backend', host: server.url.host, projectId: 57, enabled: true,
        nine1botProjectID: 'directory-project', pathWithNamespace: 'studio/backend' }],
    }
    writeFileSync(process.env.NINE1BOT_CONFIG_PATH, JSON.stringify({ platforms: { gitlab: { enabled: true, settings } } }))
    ReviewRunStore.setPathForTesting(join(directory, 'runs.json'))
    const trigger: GitLabReviewTrigger = { host: server.url.host, projectId: 57, projectPath: 'studio/backend', objectType: 'mr', objectIid: 4, headSha, mode: 'mention' }
    const context: GitLabReviewContext = {
      trigger, idempotencyKey: 'trigger', contextBlocks: [],
      diff: { files: [], skipped: [], blocked: false, stats: { fileCount: 0, includedFileCount: 0, skippedFileCount: 0, includedBytes: 0, truncated: false } },
    }
    const payloadHash = 'b'.repeat(64)
    const run = ReviewRunStore.create({ platform: 'gitlab', status: 'succeeded', publishedAt: Date.now(), trigger, context,
      publication: { state: 'published', payloadHash, summaryMarker: 'marker', completedMarkers: [], updatedAt: Date.now() } })
    expect(captureFogReview({ run, trigger, context, settings: normalizeGitLabReviewSettings(settings),
      result: { stage: 'closed', status: 'ok', summary: 'Review complete', findings: [] }, payloadHash })).toBeUndefined()
    confirmFogPublication(run.id, run.generation, payloadHash)
    await stopFogDelivery()
    startFogDelivery()
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && fogDeliveryStatus().reports[0]?.state !== 'sent') await Bun.sleep(20)
    expect(fogDeliveryStatus().reports[0]).toMatchObject({ state: 'sent', diagnostic: '' })
    expect(posts).toBe(1)
    expect(posted).toMatchObject({ projectKey: 'studio/backend', status: 'needs_attention', ci: { status: 'failed' }, source: { revision: headSha } })
    const status = fogDeliveryStatus()
    expect(status.reports[0]?.state).toBe('sent')
    expect(JSON.stringify(status)).not.toContain('fog-test-secret')
    expect(JSON.stringify(status)).not.toContain('gitlab-test-secret')
    expect(status.reports[0]).not.toHaveProperty('seed')
    expect(status.reports[0]).not.toHaveProperty('payload')
  } finally {
    await stopFogDelivery()
    await server.stop(true)
    ReviewRunStore.clearForTesting()
    for (const key of envKeys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)
