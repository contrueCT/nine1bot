import { describe, expect, it } from 'bun:test'
import {
  createSessionEventReconciler,
  loadSessionRecoverySnapshot,
} from '../src/composables/sessionEventReconciler'

describe('createSessionEventReconciler', () => {
  it('drops stale snapshots and replays current buffered events after the snapshot', () => {
    const applied: string[] = []
    const reconciler = createSessionEventReconciler<string>((event) => applied.push(event))
    const a = reconciler.begin('a')
    const b = reconciler.begin('b')

    expect(reconciler.buffer(b, 'delta-b')).toBe(true)
    expect(reconciler.applySnapshot(a, () => applied.push('snapshot-a'))).toBe(false)
    expect(reconciler.applySnapshot(b, () => applied.push('snapshot-b'))).toBe(true)
    expect(applied).toEqual(['snapshot-b', 'delta-b'])
  })

  it('dispatches live events after reconciliation finishes', () => {
    const applied: string[] = []
    const reconciler = createSessionEventReconciler<string>((event) => applied.push(event))
    const generation = reconciler.begin('session-a')

    expect(reconciler.buffer(generation, 'buffered')).toBe(true)
    expect(reconciler.applySnapshot(generation, () => applied.push('snapshot'))).toBe(true)
    expect(reconciler.finish(generation)).toBe(true)
    expect(reconciler.buffer(generation, 'live')).toBe(false)
    expect(applied).toEqual(['snapshot', 'buffered', 'live'])
  })

  it('invalidates an overflowing snapshot and resumes only from a newer recovery', () => {
    const applied: string[] = []
    const overflows: number[] = []
    const reconciler = createSessionEventReconciler<string>(event => applied.push(event), {
      maxEvents: 2,
      onOverflow: generation => overflows.push(generation),
    })
    const old = reconciler.begin('session')
    for (let index = 0; index < 10000; index++) reconciler.buffer(old, `event-${index}`)
    expect(overflows).toEqual([old])
    expect(reconciler.needsResync(old)).toBe(true)
    expect(reconciler.applySnapshot(old, () => applied.push('stale-snapshot'))).toBe(false)
    expect(reconciler.finish(old)).toBe(false)
    expect(applied).toEqual([])

    const fresh = reconciler.begin('session')
    reconciler.buffer(fresh, 'fresh-delta')
    reconciler.applySnapshot(fresh, () => applied.push('fresh-snapshot'))
    reconciler.finish(fresh)
    reconciler.buffer(fresh, 'live')
    expect(applied).toEqual(['fresh-snapshot', 'fresh-delta', 'live'])
  })

  it('also bounds buffer size when one event is large and releases cancelled generations', () => {
    const applied: string[] = []
    const reconciler = createSessionEventReconciler<string>(event => applied.push(event), { maxBytes: 20 })
    const generation = reconciler.begin('session')
    reconciler.buffer(generation, 'x'.repeat(50))
    expect(reconciler.needsResync(generation)).toBe(true)
    reconciler.clear()
    expect(reconciler.sessionID()).toBeUndefined()
    expect(reconciler.applySnapshot(generation, () => applied.push('cancelled'))).toBe(false)
    expect(reconciler.buffer(generation, 'late')).toBe(false)
    expect(applied).toEqual([])
  })

  it('stops replay if an event handler releases the current session', () => {
    const applied: string[] = []
    const reconciler = createSessionEventReconciler<string>(event => {
      applied.push(event)
      reconciler.clear()
    })
    const generation = reconciler.begin('session')
    reconciler.buffer(generation, 'leave-session')
    reconciler.buffer(generation, 'stale-after-leaving')
    expect(reconciler.finish(generation)).toBe(false)
    expect(applied).toEqual(['leave-session'])
  })
})

describe('loadSessionRecoverySnapshot', () => {
  it('loads the complete session snapshot and filters session-bound interactions', async () => {
    const calls: string[] = []
    const snapshot = await loadSessionRecoverySnapshot('session-a', {
      async getMessages(sessionID) {
        calls.push(`messages:${sessionID}`)
        return [{ id: 'message-a' }]
      },
      async getStatuses() {
        calls.push('statuses')
        return {
          'session-a': { type: 'retry', attempt: 2 },
          'session-b': { type: 'busy' },
        }
      },
      async getQuestions() {
        calls.push('questions')
        return [
          { id: 'question-a', sessionID: 'session-a' },
          { id: 'question-b', sessionID: 'session-b' },
        ]
      },
      async getPermissions() {
        calls.push('permissions')
        return [
          { id: 'permission-a', sessionID: 'session-a' },
          { id: 'permission-b', sessionID: 'session-b' },
        ]
      },
    })

    expect(calls.sort()).toEqual([
      'messages:session-a',
      'permissions',
      'questions',
      'statuses',
    ])
    expect(snapshot).toEqual({
      messages: [{ id: 'message-a' }],
      status: { type: 'retry', attempt: 2 },
      questions: [{ id: 'question-a', sessionID: 'session-a' }],
      permissions: [{ id: 'permission-a', sessionID: 'session-a' }],
    })
  })

  it('uses idle when the session has no active status entry', async () => {
    const snapshot = await loadSessionRecoverySnapshot('session-a', {
      async getMessages() {
        return []
      },
      async getStatuses() {
        return {}
      },
      async getQuestions() {
        return []
      },
      async getPermissions() {
        return []
      },
    })

    expect(snapshot.status).toEqual({ type: 'idle' })
  })

  it('keeps successful status and interactions available when the history endpoint fails', async () => {
    const snapshot = await loadSessionRecoverySnapshot('session-a', {
      async getMessages() { throw new Error('history endpoint offline') },
      async getStatuses() { return {} },
      async getQuestions() { return [{ id: 'question-a', sessionID: 'session-a' }] },
      async getPermissions() { return [{ id: 'permission-a', sessionID: 'session-a' }] },
    })
    expect(snapshot.messages).toBeNull()
    expect(snapshot.messagesError).toBe('history endpoint offline')
    expect(snapshot.status).toEqual({ type: 'idle' })
    expect(snapshot.questions).toHaveLength(1)
    expect(snapshot.permissions).toHaveLength(1)
    expect(snapshot.failures).toEqual(['历史消息'])
  })

  it('settles immediately on cancellation even when a dependency ignores the abort signal', async () => {
    const controller = new AbortController()
    let delivered = false
    const loading = loadSessionRecoverySnapshot('session', {
      getMessages: () => new Promise<never>(() => {}),
      async getStatuses() { return {} },
      async getQuestions() { return [] },
      async getPermissions() { return [] },
      onMessages() { delivered = true },
    }, controller.signal)
    controller.abort(new DOMException('View changed', 'AbortError'))
    await expect(loading).rejects.toThrow('View changed')
    expect(delivered).toBe(false)
  })
})
