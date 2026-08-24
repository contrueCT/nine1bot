import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import type { PlatformManagerConfig } from '../platform/manager'
import { inspectGitLabCiForSession } from './gitlab-ci-inspector'
import { ReviewRunStore } from './run-store'

const platforms = {
  gitlab: {
    enabled: true,
    settings: {
      'review.enabled': true,
      'review.baseUrl': 'https://gitlab.example.com',
      'review.tokenSecretRef': {
        provider: 'nine1bot-local',
        key: 'gitlab-token',
      },
    },
  },
} satisfies PlatformManagerConfig

const secrets: PlatformSecretAccess = {
  async get(ref: PlatformSecretRef) {
    return ref.key === 'gitlab-token' ? 'server-side-token' : undefined
  },
  async set() {},
  async delete() {},
  async has(ref: PlatformSecretRef) {
    return ref.key === 'gitlab-token'
  },
}

const tempDirs: string[] = []

describe('GitLab CI session inspector', () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nine1bot-ci-inspector-'))
    tempDirs.push(dir)
    ReviewRunStore.setPathForTesting(join(dir, 'review-runs.json'))
    ReviewRunStore.clearForTesting()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('binds CI lookup to exactly one review session and its project snapshot', async () => {
    createReviewRun('session-a', 3, 10, 'head-a')
    createReviewRun('session-b', 4, 11, 'head-b')
    const calls: string[] = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      expect(new Headers(init?.headers).get('private-token')).toBe('server-side-token')
      if (url.includes('/projects/3/merge_requests/10/pipelines')) {
        return Response.json([{ id: 55, sha: 'head-a', status: 'running' }])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      if (url.includes('/projects/3/pipelines/55/jobs')) {
        return Response.json([
          { id: 56, name: 'build', status: 'success' },
          { id: 57, name: 'test', status: 'failed' },
          { id: 58, name: 'deploy', status: 'running' },
        ])
      }
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const unbound = await inspectGitLabCiForSession({
      sessionId: 'unknown-session',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(unbound).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'gitlab_review_session_not_bound',
    })
    expect(calls).toHaveLength(0)

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'list',
      target: {
        host: 'gitlab.example.com',
        projectId: 3,
        mrIid: 10,
        headSha: 'head-a',
        mrUrl: 'https://gitlab.example.com/root/uftest/-/merge_requests/10',
      },
      pipeline: {
        id: 55,
        sha: 'head-a',
        status: 'running',
        kind: 'source',
        verification: expect.arrayContaining(['mr_pipeline_candidate', 'head_sha_exact']),
      },
      jobs: [
        { id: 56, name: 'build', status: 'success' },
        { id: 57, name: 'test', status: 'failed' },
        { id: 58, name: 'deploy', status: 'running' },
      ],
      diagnostics: [],
    })
    expect(calls).toHaveLength(3)
    expect(calls.every((url) => url.includes('/projects/3/'))).toBe(true)

    const runA = ReviewRunStore.findBySessionId('session-a')
    const runB = ReviewRunStore.findBySessionId('session-b')
    expect(runA?.ci).toMatchObject({
      pipeline: { id: 55 },
      diagnostics: [],
      queryCount: 1,
    })
    expect(runA?.ci?.observedAt).toBeNumber()
    expect(runB?.ci).toBeUndefined()
  })

  test('fails closed before GitLab access when the configured token is unavailable', async () => {
    createReviewRun('session-a', 3, 10, 'head-a')
    let fetchCalls = 0
    const missingSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        return undefined
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets: missingSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_token_missing',
    })
    expect(fetchCalls).toBe(0)
  })

  test('requires list before a job-log read without resolving a token or calling GitLab', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    let secretReads = 0
    let fetchCalls = 0
    const observedSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        secretReads += 1
        return 'server-side-token'
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets: observedSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_list_required',
    })
    expect(secretReads).toBe(0)
    expect(fetchCalls).toBe(0)
    expect(ReviewRunStore.get(run.id)?.ci).toBeUndefined()
  })

  test('does not let an unfinished list reservation unlock job-log reads', async () => {
    createReviewRun('session-sequenced', 3, 10, 'head-a')
    const firstPipelineResponse = deferred<Response>()
    const firstPipelineStarted = deferred<void>()
    let pipelineCalls = 0
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/merge_requests/10/pipelines')) {
        pipelineCalls += 1
        if (pipelineCalls === 1) {
          firstPipelineStarted.resolve()
          return await firstPipelineResponse.promise
        }
        return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      if (url.includes('/pipelines/55/jobs')) {
        return Response.json([{ id: 56, name: 'test', status: 'success' }])
      }
      if (url.includes('/jobs/56/trace')) return new Response('trace')
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const list = inspectGitLabCiForSession({
      sessionId: 'session-sequenced',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    await firstPipelineStarted.promise
    const earlyLog = await inspectGitLabCiForSession({
      sessionId: 'session-sequenced',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    firstPipelineResponse.resolve(Response.json([{ id: 55, sha: 'head-a', status: 'success' }]))

    expect(earlyLog).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_list_required',
    })
    await expect(list).resolves.toMatchObject({ ok: true, action: 'list' })
  })

  test('returns the canonical MR URL from the configured protocol and GitLab base path', async () => {
    createReviewRun('session-prefixed', 3, 10, 'head-a')
    const calls: string[] = []
    const prefixedPlatforms = {
      gitlab: {
        enabled: true,
        settings: {
          ...platforms.gitlab.settings,
          'review.baseUrl': 'http://gitlab.example.com/gitlab',
        },
      },
    } satisfies PlatformManagerConfig
    const result = await inspectGitLabCiForSession({
      sessionId: 'session-prefixed',
      request: { action: 'list' },
      platforms: prefixedPlatforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/merge_requests/10/pipelines')) {
          return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
        }
        if (url.endsWith('/merge_requests/10')) {
          return Response.json({
            iid: 10,
            project_id: 3,
            diff_refs: { head_sha: 'head-a' },
          })
        }
        if (url.includes('/pipelines/55/jobs')) return Response.json([])
        throw new Error(`unexpected request: ${url}`)
      }) as typeof fetch,
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'list',
      target: {
        mrUrl: 'http://gitlab.example.com/gitlab/root/uftest/-/merge_requests/10',
      },
    })
    expect(calls.every((url) => url.startsWith('http://gitlab.example.com/gitlab/api/v4/'))).toBe(true)
  })

  test('does not reserve job-log quota when the configured token is missing', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    markCiListed(run.id)
    let fetchCalls = 0
    const missingSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        return undefined
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets: missingSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_token_missing',
    })
    expect(fetchCalls).toBe(0)
    expect(ReviewRunStore.get(run.id)?.ci?.jobLogReadCount).toBeUndefined()
  })

  test('converts secret-store failures into stable diagnostics without GitLab access', async () => {
    createReviewRun('session-a', 3, 10, 'head-a')
    let fetchCalls = 0
    const throwingSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        throw new Error('secret backend details')
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets: throwingSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_token_unavailable:Error',
    })
    expect(fetchCalls).toBe(0)
    expect(ReviewRunStore.findBySessionId('session-a')?.ci?.diagnostics).toEqual([
      'ci_token_unavailable:Error',
    ])
  })

  test('does not reserve job-log quota when the token resolver throws', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    markCiListed(run.id)
    let fetchCalls = 0
    const throwingSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        throw new Error('secret backend details')
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets: throwingSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_token_unavailable:Error',
    })
    expect(fetchCalls).toBe(0)
    expect(ReviewRunStore.get(run.id)?.ci?.jobLogReadCount).toBeUndefined()
  })

  test('allows only an active attempt before making any GitLab CI request', async () => {
    let fetchCalls = 0
    for (const [index, status] of (['succeeded', 'failed', 'rejected', 'blocked'] as const).entries()) {
      const sessionId = `terminal-session-${index}`
      const run = createReviewRun(sessionId, 3, 10, 'head-a')
      ReviewRunStore.update(run.id, { status })

      await expect(inspectGitLabCiForSession({
        sessionId,
        request: { action: 'list' },
        platforms,
        secrets,
        fetch: (async () => {
          fetchCalls += 1
          return Response.json([])
        }) as unknown as typeof fetch,
      })).resolves.toEqual({
        ok: false,
        action: 'list',
        diagnostic: 'ci_review_run_not_active',
      })
      expect(ReviewRunStore.get(run.id)?.ci).toBeUndefined()
    }
    expect(fetchCalls).toBe(0)
  })

  test('records an aborted list reservation without persisting upstream response details', async () => {
    const run = createReviewRun('session-abort', 3, 10, 'head-a')
    const controller = new AbortController()
    let fetchCalls = 0
    const result = await inspectGitLabCiForSession({
      sessionId: 'session-abort',
      request: { action: 'list' },
      platforms,
      secrets,
      signal: controller.signal,
      fetch: (async () => {
        fetchCalls += 1
        const privateReason = new Error('PRIVATE-TOKEN=must-not-leak')
        controller.abort(privateReason)
        throw privateReason
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_request_aborted',
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(fetchCalls).toBe(1)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({ queryCount: 1 })
  })

  test('does not persist a deferred CI response for a stale attempt', async () => {
    const run = createReviewRun('session-old', 3, 10, 'head-a')
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    const calls: string[] = []
    const pending = inspectGitLabCiForSession({
      sessionId: 'session-old',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/merge_requests/10/pipelines')) {
          requestStarted.resolve()
          return await response.promise
        }
        throw new Error(`stale attempt made an unexpected request: ${url}`)
      }) as typeof fetch,
    })
    await requestStarted.promise
    const retry = createRetryRun(run, 'session-new')
    response.resolve(Response.json([{ id: 55, sha: 'head-a', status: 'success' }]))

    await expect(pending).resolves.toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_review_attempt_stale',
    })
    expect(calls).toHaveLength(1)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({ queryCount: 1 })
    expect(ReviewRunStore.get(retry.id)?.ci).toBeUndefined()
  })

  test('reserves one list query before GitLab access and rejects concurrent repeats', async () => {
    const run = createReviewRun('session-list-quota', 3, 10, 'head-a')
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<void>()
    let pipelineCalls = 0
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/merge_requests/10/pipelines')) {
        pipelineCalls += 1
        if (pipelineCalls === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
        }
        return Response.json([])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const first = inspectGitLabCiForSession({
      sessionId: 'session-list-quota',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    await firstStarted.promise

    await expect(inspectGitLabCiForSession({
      sessionId: 'session-list-quota',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })).resolves.toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_list_query_limit_reached',
    })
    expect(pipelineCalls).toBe(1)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({ queryCount: 1 })

    releaseFirst.resolve()
    await first
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({ queryCount: 1 })
  })

  test('counts failed list queries and blocks later GitLab requests for the run', async () => {
    const run = createReviewRun('session-list-failure', 3, 10, 'head-a')
    let fetchCalls = 0
    const fetchMock = (async () => {
      fetchCalls += 1
      throw new Error('upstream unavailable')
    }) as unknown as typeof fetch

    const first = await inspectGitLabCiForSession({
      sessionId: 'session-list-failure',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    expect(first).toMatchObject({ ok: true, action: 'list' })
    const callsAfterFailure = fetchCalls

    await expect(inspectGitLabCiForSession({
      sessionId: 'session-list-failure',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })).resolves.toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_list_query_limit_reached',
    })
    expect(fetchCalls).toBe(callsAfterFailure)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({ queryCount: 1 })
  })

  test('allows success and failed logs on demand while enforcing one shared limit without persisting traces', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    const calls: string[] = []
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/merge_requests/10/pipelines')) {
        return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      if (url.includes('/pipelines/55/jobs')) {
        return Response.json([
          { id: 56, name: 'build', status: 'success' },
          { id: 57, name: 'test', status: 'failed' },
        ])
      }
      if (url.includes('/jobs/56/trace')) return new Response('success trace')
      if (url.includes('/jobs/57/trace')) return new Response('token=secret-value\nfailed trace')
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const successLog = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const failedLog = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 57 },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const overLimit = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(successLog).toMatchObject({
      ok: true,
      action: 'read_job_log',
      job: { id: 56, status: 'success' },
      trace: 'success trace',
    })
    expect(failedLog).toMatchObject({
      ok: true,
      action: 'read_job_log',
      job: { id: 57, status: 'failed' },
      trace: 'token=***\nfailed trace',
    })
    expect(overLimit).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_job_log_limit_reached',
    })
    expect(calls.filter((url) => url.includes('/trace'))).toHaveLength(2)

    const stored = ReviewRunStore.get(run.id)
    expect(stored?.ci).toMatchObject({
      pipeline: { id: 55, sha: 'head-a' },
      diagnostics: [],
      queryCount: 1,
      jobLogReadCount: 2,
      queriedJobIds: [56, 57],
    })
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain('success trace')
    expect(serialized).not.toContain('failed trace')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('server-side-token')
  })

  test('enforces hard job-log count and byte limits even when project settings are huge', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    markCiListed(run.id)
    ReviewRunStore.update(run.id, {
      project: {
        ...run.project!,
        ci: {
          maxJobLogs: 1_000_000_000,
          maxJobLogBytes: 1_000_000_000,
        },
      },
    })
    let traceCalls = 0
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/merge_requests/10/pipelines')) {
        return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      if (url.includes('/pipelines/55/jobs')) {
        return Response.json([{ id: 56, name: 'test', status: 'success' }])
      }
      if (url.includes('/jobs/56/trace')) {
        traceCalls += 1
        return new Response('x'.repeat(20_000))
      }
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const results = []
    for (let index = 0; index < 11; index += 1) {
      results.push(await inspectGitLabCiForSession({
        sessionId: 'session-a',
        request: { action: 'read_job_log', jobId: 56 },
        platforms,
        secrets,
        fetch: fetchMock,
      }))
    }

    expect(results.slice(0, 10).every((result) => result.ok)).toBe(true)
    for (const result of results.slice(0, 10)) {
      expect(result).toMatchObject({
        ok: true,
        action: 'read_job_log',
        bytes: 16_384,
        truncated: true,
      })
    }
    expect(results[10]).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_job_log_limit_reached',
    })
    expect(traceCalls).toBe(10)
  })

  test('reserves job-log quota before GitLab access for stale attempts', async () => {
    const beforeTraceRun = createReviewRun('session-before-trace', 3, 10, 'head-a')
    markCiListed(beforeTraceRun.id)
    const jobsStarted = deferred<void>()
    const jobsResponse = deferred<Response>()
    let beforeTraceJobsCalls = 0
    let beforeTraceCalls = 0
    const beforeTrace = inspectGitLabCiForSession({
      sessionId: 'session-before-trace',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/merge_requests/10/pipelines')) {
          return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
        }
        const mergeRequest = currentMergeRequestMetadataResponse(url)
        if (mergeRequest) return mergeRequest
        if (url.includes('/pipelines/55/jobs')) {
          beforeTraceJobsCalls += 1
          if (beforeTraceJobsCalls === 2) {
            jobsStarted.resolve()
            return await jobsResponse.promise
          }
          return Response.json([{ id: 56, name: 'test', status: 'failed' }])
        }
        if (url.includes('/jobs/56/trace')) {
          beforeTraceCalls += 1
          return new Response('must not be read')
        }
        throw new Error(`unexpected request: ${url}`)
      }) as typeof fetch,
    })
    await jobsStarted.promise
    const beforeTraceRetry = createRetryRun(beforeTraceRun, 'session-before-trace-new')
    jobsResponse.resolve(Response.json([{ id: 56, name: 'test', status: 'failed' }]))

    await expect(beforeTrace).resolves.toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_review_attempt_stale',
    })
    expect(beforeTraceCalls).toBe(0)
    expect(ReviewRunStore.get(beforeTraceRun.id)?.ci).toEqual({
      diagnostics: [],
      queryCount: 1,
      listCompletedAt: 1,
      jobLogReadCount: 1,
      queriedJobIds: [56],
    })
    expect(ReviewRunStore.get(beforeTraceRetry.id)?.ci).toBeUndefined()

    const afterTraceRun = createReviewRun('session-after-trace', 3, 10, 'head-a')
    markCiListed(afterTraceRun.id)
    const traceStarted = deferred<void>()
    const traceResponse = deferred<Response>()
    let afterTraceCalls = 0
    const afterTrace = inspectGitLabCiForSession({
      sessionId: 'session-after-trace',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/merge_requests/10/pipelines')) {
          return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
        }
        const mergeRequest = currentMergeRequestMetadataResponse(url)
        if (mergeRequest) return mergeRequest
        if (url.includes('/pipelines/55/jobs')) {
          return Response.json([{ id: 56, name: 'test', status: 'failed' }])
        }
        if (url.includes('/jobs/56/trace')) {
          afterTraceCalls += 1
          traceStarted.resolve()
          return await traceResponse.promise
        }
        throw new Error(`unexpected request: ${url}`)
      }) as typeof fetch,
    })
    await traceStarted.promise
    const afterTraceRetry = createRetryRun(afterTraceRun, 'session-after-trace-new')
    traceResponse.resolve(new Response('stale trace'))

    await expect(afterTrace).resolves.toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_review_attempt_stale',
    })
    expect(afterTraceCalls).toBe(1)
    expect(ReviewRunStore.get(afterTraceRun.id)?.ci).toEqual({
      diagnostics: [],
      queryCount: 1,
      listCompletedAt: 1,
      jobLogReadCount: 1,
      queriedJobIds: [56],
    })
    expect(ReviewRunStore.get(afterTraceRetry.id)?.ci).toBeUndefined()
  })

  test('rejects a 40,000-character head SHA before GitLab access with a small failure DTO', async () => {
    createReviewRun('session-a', 3, 10, 'a'.repeat(40_000))
    let fetchCalls = 0

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'gitlab_review_mr_identity_missing',
    })
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(32 * 1024)
    expect(fetchCalls).toBe(0)
  })

  test('returns a small failure DTO when a final list payload cannot fit within 32 KiB', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    ReviewRunStore.update(run.id, {
      trigger: {
        ...run.trigger,
        objectIid: 'm'.repeat(40_000),
      },
    })

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: (async () => Response.json([])) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_tool_output_limit_exceeded',
    })
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(32 * 1024)

    let readFetchCalls = 0
    const read = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: (async () => {
        readFetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })
    expect(read).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_list_required',
    })
    expect(readFetchCalls).toBe(0)
    expect(ReviewRunStore.get(run.id)?.ci?.listCompletedAt).toBeUndefined()
  })

  test('exhausts job-log quota for repeated invalid job IDs before any further GitLab endpoint access', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    markCiListed(run.id)
    const calls: string[] = []
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/merge_requests/10/pipelines')) {
        return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      if (url.includes('/pipelines/55/jobs')) return Response.json([])
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    for (const jobId of [100, 101]) {
      await expect(inspectGitLabCiForSession({
        sessionId: 'session-a',
        request: { action: 'read_job_log', jobId },
        platforms,
        secrets,
        fetch: fetchMock,
      })).resolves.toEqual({
        ok: false,
        action: 'read_job_log',
        diagnostic: 'ci_job_not_in_head_pipeline',
      })
    }
    const callsBeforeLimit = calls.length

    await expect(inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 102 },
      platforms,
      secrets,
      fetch: fetchMock,
    })).resolves.toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_job_log_limit_reached',
    })

    expect(calls).toHaveLength(callsBeforeLimit)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({
      jobLogReadCount: 2,
      queriedJobIds: [100, 101],
    })
  })

  test('consumes one job-log quota attempt when no pipeline exists', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    markCiListed(run.id)
    const calls: string[] = []
    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/merge_requests/10/pipelines')) return Response.json([])
        const mergeRequest = currentMergeRequestMetadataResponse(url)
        if (mergeRequest) return mergeRequest
        throw new Error(`unexpected request: ${url}`)
      }) as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_pipeline_not_found_for_current_mr',
    })
    expect(calls).toHaveLength(2)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({
      jobLogReadCount: 1,
      queriedJobIds: [56],
    })
  })

  test('allows exactly two concurrent authenticated job-log reservations', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    markCiListed(run.id)
    const calls: string[] = []
    const jobIds = [200, 201, 202, 203, 204]
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/merge_requests/10/pipelines')) return Response.json([])
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const results = await Promise.all(jobIds.map((jobId) => inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId },
      platforms,
      secrets,
      fetch: fetchMock,
    })))

    expect(results.filter((result) => !result.ok && result.diagnostic === 'ci_pipeline_not_found_for_current_mr'))
      .toHaveLength(2)
    expect(results.filter((result) => !result.ok && result.diagnostic === 'ci_job_log_limit_reached'))
      .toHaveLength(3)
    expect(calls).toHaveLength(4)
    expect(calls.every((url) => !url.includes('/jobs/'))).toBe(true)
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({
      jobLogReadCount: 2,
      queriedJobIds: [200, 201],
    })
  })

  test('rejects a whitespace head SHA before GitLab access', async () => {
    createReviewRun('session-a', 3, 10, 'head a')
    let fetchCalls = 0

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'gitlab_review_mr_identity_missing',
    })
    expect(fetchCalls).toBe(0)
  })

  test('fails closed when the complete list payload is exactly 32 KiB', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    const mrIid = 'm'.repeat(32_517)
    ReviewRunStore.update(run.id, {
      trigger: {
        ...run.trigger,
        objectIid: mrIid,
      },
    })

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const pathname = new URL(String(input)).pathname
        if (pathname.endsWith('/pipelines')) return Response.json([])
        return Response.json({
          iid: mrIid,
          project_id: 3,
          diff_refs: { head_sha: 'head-a' },
        })
      }) as typeof fetch,
    })

    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(32 * 1024)
    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_tool_output_limit_exceeded',
    })
  })

  test('bounds the complete CI session list payload including its review target', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    ReviewRunStore.update(run.id, {
      trigger: {
        ...run.trigger,
        projectPath: `root/${'very-long-segment/'.repeat(350)}uftest`,
      },
    })
    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/merge_requests/10/pipelines')) {
          return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
        }
        const mergeRequest = currentMergeRequestMetadataResponse(url)
        if (mergeRequest) return mergeRequest
        if (url.includes('/pipelines/55/jobs')) {
          return Response.json(Array.from({ length: 150 }, (_, index) => ({
            id: index + 1,
            name: `job-${index}-${'x'.repeat(700)}`,
            stage: 'verify',
            status: 'success',
          })))
        }
        throw new Error(`unexpected request: ${url}`)
      }) as typeof fetch,
    })

    expect(result).toMatchObject({ ok: true, action: 'list', truncated: true })
    expect(result.ok && result.action === 'list' ? result.target.mrUrl : undefined).toBeUndefined()
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(32 * 1024)
  })

  test('refreshes CI through the newly bound session after a retry', async () => {
    const run = createReviewRun('session-old', 3, 10, 'head-a')
    let pipelineId = 55
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/merge_requests/10/pipelines')) {
        return Response.json([{ id: pipelineId, sha: 'head-a', status: pipelineId === 55 ? 'failed' : 'success' }])
      }
      const mergeRequest = currentMergeRequestMetadataResponse(url)
      if (mergeRequest) return mergeRequest
      if (url.includes(`/pipelines/${pipelineId}/jobs`)) return Response.json([])
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const first = await inspectGitLabCiForSession({
      sessionId: 'session-old',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    expect(first).toMatchObject({ ok: true, pipeline: { id: 55, status: 'failed' } })

    const previous = ReviewRunStore.update(run.id, { sessionId: undefined })
    if (!previous) throw new Error('expected previous attempt')
    const retry = createRetryRun(previous, 'session-new')
    pipelineId = 77

    const staleSession = await inspectGitLabCiForSession({
      sessionId: 'session-old',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const refreshed = await inspectGitLabCiForSession({
      sessionId: 'session-new',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(staleSession).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'gitlab_review_session_not_bound',
    })
    expect(refreshed).toMatchObject({ ok: true, pipeline: { id: 77, status: 'success' } })
    expect(ReviewRunStore.get(run.id)?.ci).toMatchObject({ pipeline: { id: 55 }, queryCount: 1 })
    expect(ReviewRunStore.get(retry.id)?.ci).toMatchObject({ pipeline: { id: 77 }, queryCount: 1 })
  })
})

function createReviewRun(sessionId: string, projectId: number, mrIid: number, headSha: string) {
  return ReviewRunStore.create({
    platform: 'gitlab',
    status: 'running',
    sessionId,
    trigger: {
      host: 'gitlab.example.com',
      projectId,
      projectPath: 'root/uftest',
      objectType: 'mr',
      objectIid: mrIid,
      headSha,
      mode: 'webhook',
    },
    project: {
      id: 'uftest',
      host: 'gitlab.example.com',
      projectId,
      nine1botProjectID: 'project-uf',
      pathWithNamespace: 'root/uftest',
      enabled: true,
      reviewFocus: [],
      includePathPrefixes: [],
      excludePathPatterns: [],
      ci: {
        maxJobLogs: 2,
        maxJobLogBytes: 80,
      },
      source: 'configured',
      matchedAt: 1,
    },
  })
}

function markCiListed(runId: string) {
  const updated = ReviewRunStore.update(runId, {
    ci: { diagnostics: [], queryCount: 1, listCompletedAt: 1 },
  })
  if (!updated) throw new Error('expected review run')
}

function currentMergeRequestMetadataResponse(url: string) {
  const pathname = new URL(url).pathname
  if (pathname !== '/api/v4/projects/3/merge_requests/10') return undefined
  return Response.json({
    iid: 10,
    project_id: 3,
    diff_refs: { head_sha: 'head-a' },
  })
}

function createRetryRun(previous: ReturnType<typeof createReviewRun>, sessionId: string) {
  const retry = ReviewRunStore.createRetryAttempt(previous, {
    platform: 'gitlab',
    status: 'running',
    sessionId,
    trigger: previous.trigger,
    project: previous.project,
  })
  if (!retry) throw new Error('expected retry attempt')
  return retry
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
