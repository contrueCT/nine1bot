import { afterEach, describe, expect, test } from 'bun:test'
import { api, setApiDirectory, type SessionFileChange } from '../src/api/client'
import { useSessionChanges } from '../src/composables/useSessionChanges'

const originalFetch = globalThis.fetch
const file = (name: string): SessionFileChange => ({ file: name, before: 'old', after: 'new', additions: 1, deletions: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => { globalThis.fetch = originalFetch; setApiDirectory('') })

describe('session change review', () => {
  test('uses a read-only request with the captured owner directory', async () => {
    setApiDirectory('/workspace/B')
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json([file('A.ts')]) }
    expect(await api.getSessionChanges('ses_A', '/workspace/A')).toEqual([file('A.ts')])
    expect(calls[0]?.url).toContain('/session/ses_A/diff')
    expect(calls[0]?.init?.method).toBeUndefined()
    expect(new Headers(calls[0]?.init?.headers).get('x-opencode-directory')).toBe('/workspace/A')
  })

  test('does not turn HTTP failures or malformed payloads into empty success', async () => {
    globalThis.fetch = async () => Response.json({ error: 'snapshot unavailable' }, { status: 500 })
    await expect(api.getSessionChanges('ses_A', '/A')).rejects.toThrow('snapshot unavailable')
    globalThis.fetch = async () => Response.json([{ file: 'bad', additions: 1 }])
    await expect(api.getSessionChanges('ses_A', '/A')).rejects.toThrow('响应格式无效')
  })

  test('late A success cannot replace B contents', async () => {
    const a = deferred<SessionFileChange[]>()
    const state = useSessionChanges(id => id === 'A' ? a.promise : Promise.resolve([file('B.ts')]))
    const first = state.load('A', '/A')
    await state.load('B', '/B')
    a.resolve([file('A.ts')]); await first
    expect(state.files.value.map(item => item.file)).toEqual(['B.ts'])
    expect(state.loading.value).toBe(false)
  })

  test('late A failure cannot set B error or loading state', async () => {
    const a = deferred<SessionFileChange[]>()
    const state = useSessionChanges(id => id === 'A' ? a.promise : Promise.resolve([file('B.ts')]))
    const first = state.load('A', '/A')
    await state.load('B', '/B')
    a.reject(new Error('old failure')); await first
    expect(state.error.value).toBe('')
    expect(state.files.value[0]?.file).toBe('B.ts')
  })

  test('switching owners clears the previous snapshot immediately', async () => {
    const b = deferred<SessionFileChange[]>()
    const state = useSessionChanges(id => id === 'B' ? b.promise : Promise.resolve([file('A.ts')]))
    await state.load('A', '/A')
    const next = state.load('B', '/B')
    expect(state.files.value).toEqual([])
    expect(state.loadedAt.value).toBeNull()
    b.resolve([]); await next
  })

  test('a refresh failure keeps the last snapshot and allows retry', async () => {
    let fails = false
    const state = useSessionChanges(async () => { if (fails) throw new Error('offline'); return [file('A.ts')] })
    await state.load('A', '/A')
    fails = true; await state.load('A', '/A')
    expect(state.error.value).toBe('offline')
    expect(state.files.value).toEqual([file('A.ts')])
    fails = false; await state.load('A', '/A')
    expect(state.error.value).toBe('')
  })

  test('closing the panel invalidates in-flight work', async () => {
    const a = deferred<SessionFileChange[]>()
    const state = useSessionChanges(() => a.promise)
    const loading = state.load('A', '/A')
    state.reset(); a.resolve([file('A.ts')]); await loading
    expect(state.files.value).toEqual([])
    expect(state.loading.value).toBe(false)
    expect(state.loadedAt.value).toBeNull()
  })
})
