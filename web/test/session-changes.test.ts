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
    expect(decodeURIComponent(new Headers(calls[0]?.init?.headers).get('x-opencode-directory') || '')).toBe('/workspace/A')
  })

  test('pins a Unicode owner directory using a byte-safe header and encoded query', async () => {
    const originalWindow = globalThis.window
    globalThis.window = { location: { origin: 'http://localhost' } } as unknown as Window & typeof globalThis
    const directory = '/workspace/项目 空间'
    setApiDirectory('/workspace/other')
    let requested = false
    globalThis.fetch = async (url, init) => {
      requested = true
      expect(new URL(String(url), window.location.origin).searchParams.get('directory')).toBe(directory)
      const header = new Headers(init?.headers).get('x-opencode-directory') || ''
      expect(header).toBe(encodeURIComponent(directory))
      expect(decodeURIComponent(header)).toBe(directory)
      return Response.json([file('文件.ts')])
    }
    try {
      expect((await api.getSessionChanges('ses_A', directory))[0]?.file).toBe('文件.ts')
      expect(requested).toBe(true)
    } finally {
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
      else globalThis.window = originalWindow
    }
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

import { isCurrentSessionDiff } from '../src/utils/session-diff-event'

test('snapshot publication refreshes only its currently selected owner', () => {
  expect(isCurrentSessionDiff({ type: 'session.diff', properties: { sessionID: 'A' } }, 'A')).toBe(true)
  expect(isCurrentSessionDiff({ type: 'session.diff', properties: { sessionID: 'A' } }, 'B')).toBe(false)
  expect(isCurrentSessionDiff({ type: 'session.updated', properties: { sessionID: 'A' } }, 'A')).toBe(false)
  expect(isCurrentSessionDiff(undefined, 'A')).toBe(false)
  expect(isCurrentSessionDiff({ type: 'session.diff', properties: { sessionID: 'A' } }, undefined)).toBe(false)
})
