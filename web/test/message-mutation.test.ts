import { describe, expect, it } from 'bun:test'
import { createMessageMutation } from '../src/composables/message-mutation'

describe('message mutation acknowledgements', () => {
  it('retains the edit on failure, blocks duplicates and only closes on confirmed success', () => {
    const mutation = createMessageMutation()
    let closed = 0
    const failed = mutation.begin(() => closed++)!
    expect(mutation.state.pending).toBe(true)
    expect(mutation.begin(() => closed++)).toBeUndefined()
    failed('offline')
    expect(closed).toBe(0)
    expect(mutation.state).toEqual({ pending: false, error: 'offline' })
    const retry = mutation.begin(() => closed++)!
    expect(mutation.state.error).toBe('')
    failed()
    expect(mutation.state.pending).toBe(true)
    retry()
    retry()
    expect(closed).toBe(1)
    expect(mutation.state.pending).toBe(false)
  })
  it('ignores callbacks after navigation or unmount', () => {
    const mutation = createMessageMutation()
    let closed = 0
    const old = mutation.begin(() => closed++)!
    mutation.reset()
    const current = mutation.begin(() => closed++)!
    old('old error')
    expect(mutation.state.error).toBe('')
    expect(mutation.state.pending).toBe(true)
    old()
    current()
    expect(closed).toBe(1)
  })
})
