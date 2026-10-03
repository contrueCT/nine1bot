import { afterEach, expect, test } from 'bun:test'
import { effectScope, ref } from 'vue'
import { api, setApiClientSurface, setApiDirectory, type SessionSearchResponse } from '../src/api/client'
import { useSessionSearch } from '../src/composables/useSessionSearch'

const originalSearch = api.searchSessions
const originalFetch = globalThis.fetch
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  api.searchSessions = originalSearch
  globalThis.fetch = originalFetch
  setApiClientSurface('web')
  setApiDirectory('')
})
const wait = () => new Promise(resolve => setTimeout(resolve, 230))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function setup() {
  const query = ref('')
  const directory = ref('/project')
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useSessionSearch(query, directory))!
  return { query, directory, state, scope }
}
const response = (title: string): SessionSearchResponse => ({ results: [{ session: { id: title, title, directory: '/project', time: { created: 1, updated: 1 } } as any, messageID: 'message-one', snippet: title }], hasMore: false })

test('search debounces and prevents stale responses or errors replacing current input', async () => {
  const old = deferred<SessionSearchResponse>()
  const current = deferred<SessionSearchResponse>()
  let calls = 0
  api.searchSessions = () => (++calls === 1 ? old.promise : current.promise)
  const { query, state } = setup()
  query.value = 'old'
  expect(state.loading.value).toBe(true)
  await wait()
  query.value = '中文::code'
  await wait()
  current.resolve(response('中文::code'))
  await Promise.resolve(); await Promise.resolve()
  expect(state.results.value[0].snippet).toBe('中文::code')
  old.reject(new Error('old failure'))
  await Promise.resolve(); await Promise.resolve()
  expect(state.error.value).toBe('')
  expect(state.results.value[0].snippet).toBe('中文::code')
})

test('clearing, changing project, and disposal invalidate pending search', async () => {
  const pending = deferred<SessionSearchResponse>()
  const calls: string[] = []
  api.searchSessions = (_query, directory) => { calls.push(directory); return pending.promise }
  const { query, directory, state, scope } = setup()
  query.value = 'term'
  await wait()
  directory.value = '/new-project'
  await wait()
  expect(calls).toEqual(['/project', '/new-project'])
  query.value = ' '
  pending.resolve(response('stale'))
  await Promise.resolve(); await Promise.resolve()
  expect(state.loading.value).toBe(false)
  expect(state.results.value).toEqual([])
  query.value = 'never sent'
  scope.stop()
  await wait()
  expect(calls).toHaveLength(2)
})

test('failed search presents retry and does not masquerade as zero matches', async () => {
  let fail = true
  api.searchSessions = async () => { if (fail) throw new Error('offline'); return { ...response('retried'), hasMore: true } }
  const { query, state } = setup()
  query.value = 'term'
  await wait()
  expect(state.error.value).toBe('offline')
  expect(state.loading.value).toBe(false)
  fail = false
  state.retry()
  expect(state.error.value).toBe('')
  await wait()
  expect(state.results.value[0].snippet).toBe('retried')
  expect(state.hasMore.value).toBe(true)
})

test('search API pins the project and filters extension source on the server', async () => {
  let url = ''
  let options: RequestInit | undefined
  globalThis.fetch = (async (input: any, init: any) => { url = String(input); options = init; return Response.json(response('hit')) }) as any
  setApiDirectory('/wrong')
  setApiClientSurface('browser-extension')
  const found = await originalSearch('中文 a::b', '/correct/目录')
  const params = new URL(url, 'http://localhost').searchParams
  expect(params.get('directory')).toBe('/correct/目录')
  expect(params.get('q')).toBe('中文 a::b')
  expect(params.get('clientSource')).toBe('browser-extension')
  expect(new Headers(options?.headers).get('x-opencode-directory')).toBe(encodeURIComponent('/correct/目录'))
  expect(found.results[0].messageID).toBe('message-one')
})

test('search API rejects failed HTTP and invalid payloads', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'index unavailable' }, { status: 503 })) as any
  await expect(originalSearch('term', '/project')).rejects.toThrow('index unavailable')
  globalThis.fetch = (async () => Response.json([])) as any
  await expect(originalSearch('term', '/project')).rejects.toThrow('搜索响应格式无效')
})
