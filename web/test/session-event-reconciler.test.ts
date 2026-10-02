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
})
