import { expect, test } from 'bun:test'
import { createSessionChangesLiveUpdates } from '../src/composables/session-changes-live'
import { createFetchEventStream } from '../src/api/client'

test('first connection and reconnect reconcile snapshots missed by a non-replayed stream', () => {
  let refreshes = 0
  const state = createSessionChangesLiveUpdates({ sessionId: () => 'A', refresh: () => { refreshes++ } })
  const stream = state.begin()
  expect(state.connected.value).toBe(false)
  stream.ready()
  expect(refreshes).toBe(1)
  stream.disconnected()
  expect(state.connected.value).toBe(false)
  // The backend published the diff while disconnected; no event is replayed.
  stream.ready()
  expect(refreshes).toBe(2)
  expect(state.connected.value).toBe(true)
})

test('late callbacks from an old subscription cannot affect the current one', () => {
  let refreshes = 0
  const state = createSessionChangesLiveUpdates({ sessionId: () => 'A', refresh: () => { refreshes++ } })
  const old = state.begin()
  const active = state.begin()
  active.ready()
  old.disconnected(); old.ready(); old.received({ type: 'session.diff', properties: { sessionID: 'A' } })
  expect(state.connected.value).toBe(true)
  expect(refreshes).toBe(1)
  state.stop(); active.ready(); active.received({ type: 'session.diff', properties: { sessionID: 'A' } })
  expect(state.connected.value).toBe(false)
  expect(refreshes).toBe(1)
})

test('publication is owner-filtered and draft mode does not request nonexistent snapshots', () => {
  let id: string | undefined = 'A'
  let refreshes = 0
  const state = createSessionChangesLiveUpdates({ sessionId: () => id, refresh: () => { refreshes++ } })
  const stream = state.begin()
  stream.received({ type: 'session.diff', properties: { sessionID: 'B' } })
  stream.received({ type: 'session.diff', properties: { sessionID: 'A' } })
  expect(refreshes).toBe(1)
  id = 'B'
  stream.received({ type: 'session.diff', properties: { sessionID: 'A' } })
  expect(refreshes).toBe(1)
  id = undefined; stream.ready()
  expect(refreshes).toBe(1)
})

test('actual fetch stream reconciles a first open after readiness timeout and later reconnect', async () => {
  const nativeFetch = globalThis.fetch
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  const timers = new Map<number, { delay: number; run: () => void }>()
  let timerID = 0
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    const id = ++timerID
    timers.set(id, { delay, run })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
  function fire(delay: number) {
    const timer = [...timers.entries()].find(([, item]) => item.delay === delay)
    if (!timer) throw new Error(`Missing ${delay}ms timer`)
    timers.delete(timer[0]); timer[1].run()
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const response = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { streams.push(controller) },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  let openFirst!: (response: Response) => void
  let fetches = 0
  globalThis.fetch = async () => ++fetches === 1
    ? await new Promise<Response>(resolve => { openFirst = resolve })
    : response()
  let refreshes = 0
  const state = createSessionChangesLiveUpdates({ sessionId: () => 'A', refresh: () => { refreshes++ } })
  const connection = state.begin()
  const reconnects: number[] = []
  const subscription = createFetchEventStream('/global/event', () => {}, {
    onOpen: connection.ready,
    onDisconnect: connection.disconnected,
    onReconnect: generation => { reconnects.push(generation) },
  })
  try {
    fire(5000)
    await expect(subscription.ready).rejects.toThrow('did not open')
    expect(state.connected.value).toBe(false)
    openFirst(response()); await flush()
    expect(subscription.connectionGeneration()).toBe(1)
    expect(state.connected.value).toBe(true)
    expect(refreshes).toBe(1)
    expect(reconnects).toEqual([])

    streams[0]!.close(); await flush()
    expect(state.connected.value).toBe(false)
    fire(1000); await flush()
    expect(subscription.connectionGeneration()).toBe(2)
    expect(state.connected.value).toBe(true)
    expect(refreshes).toBe(2)
    expect(reconnects).toEqual([2])
  } finally {
    subscription.close()
    streams.at(-1)?.close()
    globalThis.fetch = nativeFetch
    globalThis.setTimeout = nativeSetTimeout
    globalThis.clearTimeout = nativeClearTimeout
  }
})
