import { expect, test } from 'bun:test'
import { createSessionChangesLiveUpdates } from '../src/composables/session-changes-live'

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
