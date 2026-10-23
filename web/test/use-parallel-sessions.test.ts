import { describe, expect, it } from 'bun:test'
import { useParallelSessions } from '../src/composables/useParallelSessions'

describe('useParallelSessions running state cleanup', () => {
  it('deletes the entry when a session is set to not running', () => {
    const { setSessionRunning, isSessionRunning, runningStates } = useParallelSessions()
    const id = `session-${Math.random().toString(36).slice(2, 10)}`

    setSessionRunning(id, true)
    expect(isSessionRunning(id)).toBe(true)
    expect(id in runningStates).toBe(true)

    setSessionRunning(id, false)
    expect(isSessionRunning(id)).toBe(false)
    expect(id in runningStates).toBe(false)
  })

  it('does not count removed entries in runningCount', () => {
    const { setSessionRunning, runningCount } = useParallelSessions()
    const id = `session-${Math.random().toString(36).slice(2, 10)}`

    const baseline = runningCount.value
    setSessionRunning(id, true)
    expect(runningCount.value).toBe(baseline + 1)

    setSessionRunning(id, false)
    expect(runningCount.value).toBe(baseline)
  })
})

const originalFetch = globalThis.fetch
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const records = [
  { id: 'sync-background', directory: '/sync/one' },
  { id: 'sync-current', directory: '/sync/two' },
]

it('reconnect reconciles each background directory without clearing the current session', async () => {
  const parallel = useParallelSessions()
  const calls: string[] = []
  for (const session of records) parallel.setSessionRunning(session.id, true)
  globalThis.fetch = async (url, options) => {
    const directory = new URL(String(url), 'http://localhost').searchParams.get('directory') || ''
    if (directory) expect(new Headers(options?.headers).get('x-opencode-directory')).toBe(encodeURIComponent(directory))
    calls.push(directory)
    return Response.json({})
  }
  try {
    await parallel.syncSessionStatus(records, () => true, id => id !== 'sync-current')
    expect(calls).toContain('/sync/one')
    expect(calls).toContain('/sync/two')
    expect(parallel.isSessionRunning('sync-background')).toBe(false)
    expect(parallel.isSessionRunning('sync-current')).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    for (const session of records) parallel.clearSession(session.id)
  }
})

it('status recovery cannot roll back SSE or local sends observed during its request', async () => {
  const parallel = useParallelSessions()
  const response = deferred<Response>()
  const started = deferred<void>()
  parallel.rememberSessionDirectory('sync-old-busy', '/sync/race')
  parallel.rememberSessionDirectory('sync-new-busy', '/sync/race')
  parallel.setSessionRunning('sync-old-busy', true)
  globalThis.fetch = async url => {
    if (String(url).includes('directory=%2Fsync%2Frace')) { started.resolve(); return response.promise }
    return Response.json({})
  }
  try {
    const recovering = parallel.syncSessionStatus([{ id: 'sync-old-busy', directory: '/sync/race' }])
    await started.promise
    parallel.handleGlobalSSEEvent({ type: 'session.idle', properties: { sessionID: 'sync-old-busy' } }, '/sync/race')
    parallel.setSessionRunning('sync-new-busy', true)
    response.resolve(Response.json({ 'sync-old-busy': { type: 'busy' } }))
    await recovering
    expect(parallel.isSessionRunning('sync-old-busy')).toBe(false)
    expect(parallel.isSessionRunning('sync-new-busy')).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    parallel.clearSession('sync-old-busy')
    parallel.clearSession('sync-new-busy')
  }
})

it('expired recovery and failed HTTP responses preserve existing running state', async () => {
  const parallel = useParallelSessions()
  parallel.setSessionRunning(records[0].id, true)
  globalThis.fetch = async () => Response.json({})
  try {
    await parallel.syncSessionStatus(records, () => false)
    expect(parallel.isSessionRunning(records[0].id)).toBe(true)
    globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 })
    const originalError = console.error
    console.error = () => {}
    try { await parallel.syncSessionStatus(records) } finally { console.error = originalError }
    expect(parallel.isSessionRunning(records[0].id)).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    for (const session of records) parallel.clearSession(session.id)
  }
})
