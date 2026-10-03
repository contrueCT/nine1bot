import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { clearComposerDrafts, getComposerDraft } from '../src/composables/composer-drafts'
import { draftStorageKey } from '../src/composables/draft-storage'
import { setAccessUnauthorizedHandler } from '../src/api/access-auth'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const originalFetch = globalThis.fetch
let values: Map<string, string>
let stopWatch: (() => void) | undefined
let auth: ReturnType<typeof import('../src/composables/useAccessAuth').useAccessAuth>
const key = draftStorageKey('auth-session', '/auth/project', 'web')
beforeEach(async () => {
  values = new Map()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:4096', href: 'http://127.0.0.1:4096/' },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
  } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size }, key: (i: number) => [...values.keys()][i] || null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } })
  auth = (await import('../src/composables/useAccessAuth')).useAccessAuth()
  globalThis.fetch = async () => Response.json({ enabled: true, authenticated: true })
  await auth.initialize('web')
  getComposerDraft('auth-session', undefined, '/auth/project').text = 'private text before outage'
  clearComposerDrafts(undefined, true)
})
afterEach(() => {
  stopWatch?.(); stopWatch = undefined
  clearComposerDrafts()
  setAccessUnauthorizedHandler(undefined)
  globalThis.fetch = originalFetch
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete (globalThis as any).window
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
  else delete (globalThis as any).sessionStorage
})

async function appAuthLifecycle() {
  const { descriptor } = parse(await Bun.file(new URL('../src/App.vue', import.meta.url)).text())
  const compiled = compileScript(descriptor, { id: 'auth-draft-retention' })
  const statements = compiled.scriptSetupAst!
  const source = (node: any) => descriptor.scriptSetup!.content.slice(node.start!, node.end!)
  const mounted = statements.find((node: any) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === 'onMounted')!
  const watcher = statements.find((node: any) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === 'watch' && source(node).includes('[accessAuthenticated, accessStatus]'))!
  const decisions: boolean[] = []
  let starts = 0
  const scope = { accessAuthenticated: auth.authenticated, accessStatus: auth.status, isBrowserExtension: Vue.ref(false),
    initializeAccessAuth: auth.initialize, startAuthenticatedRuntime: async () => { starts++ }, applySettingsDeepLink() {}, handleExtensionParentMessage() {},
    stopAuthenticatedRuntime(preserve = false) { decisions.push(preserve); clearComposerDrafts(undefined, preserve) },
  }
  const callback = new Function('scope', 'Vue', `
    const { accessAuthenticated, accessStatus, isBrowserExtension, initializeAccessAuth, startAuthenticatedRuntime,
      stopAuthenticatedRuntime, applySettingsDeepLink, handleExtensionParentMessage } = scope;
    let mounted; let stop; const onMounted = fn => { mounted = fn }; const watch = (...args) => { stop = Vue.watch(...args) };
    ${new Bun.Transpiler({ loader: 'ts' }).transformSync(source(watcher))}
    ${new Bun.Transpiler({ loader: 'ts' }).transformSync(source(mounted))}
    return { mounted, stop };
  `)(scope, Vue)
  stopWatch = callback.stop
  return { mounted: callback.mounted as () => Promise<void>, decisions, starts: () => starts }
}

for (const failure of ['network', 'http', 'missing', 'nonboolean', 'invalid-json'] as const) test(`actual App startup and auth watcher retain inaccessible drafts for ${failure} status`, async () => {
  const lifecycle = await appAuthLifecycle()
  globalThis.fetch = async () => {
    if (failure === 'network') throw new Error('temporary status outage')
    if (failure === 'http') return new Response('unavailable', { status: 503 })
    if (failure === 'missing') return Response.json({ enabled: true })
    if (failure === 'nonboolean') return Response.json({ enabled: true, authenticated: 'false' })
    return new Response('{broken', { status: 200 })
  }
  await lifecycle.mounted(); await Vue.nextTick()
  expect(auth.status.value).toBe('unknown')
  expect(auth.authenticated.value).toBe(false)
  expect(auth.required.value).toBe(true)
  expect(lifecycle.starts()).toBe(0)
  expect(lifecycle.decisions.length).toBeGreaterThan(0)
  expect(lifecycle.decisions.every(Boolean)).toBe(true)
  expect(values.has(key)).toBe(true)
  globalThis.fetch = async () => Response.json({ enabled: true, authenticated: true })
  await lifecycle.mounted(); await Vue.nextTick()
  expect(auth.status.value).toBe('authenticated')
  expect(lifecycle.starts()).toBe(1)
  expect(getComposerDraft('auth-session', undefined, '/auth/project').text).toBe('private text before outage')
})

test('confirmed unauthenticated status purges drafts through startup and watcher', async () => {
  const lifecycle = await appAuthLifecycle()
  globalThis.fetch = async () => Response.json({ enabled: true, authenticated: false })
  await lifecycle.mounted(); await Vue.nextTick()
  expect(auth.status.value).toBe('unauthenticated')
  expect(lifecycle.decisions).toContain(false)
  expect(values.has(key)).toBe(false)
})

test('explicit logout and a confirmed login denial purge retained drafts', async () => {
  await appAuthLifecycle()
  globalThis.fetch = async () => new Response('{}', { status: 200 })
  await auth.logout(); await Vue.nextTick()
  expect(auth.status.value).toBe('unauthenticated')
  expect(values.has(key)).toBe(false)
  globalThis.fetch = async () => Response.json({ enabled: true, authenticated: true })
  await auth.initialize('web'); await Vue.nextTick()
  getComposerDraft('auth-session', undefined, '/auth/project').text = 'another private draft'
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  expect(await auth.login('invalid-test-password')).toBe(false)
  await Vue.nextTick()
  expect(auth.status.value).toBe('unauthenticated')
  expect(values.has(key)).toBe(false)
})

test('real credential-store EIO reports unavailable and preserves drafts until same-cookie recovery', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { FileAccessCredentialStore } = await import('../../packages/nine1bot/src/access-auth/credential-store')
  const { createAccessAuthRuntime } = await import('../../packages/nine1bot/src/access-auth/service')
  const { AuthConfigSchema } = await import('../../packages/nine1bot/src/config/schema')
  const directory = await mkdtemp(join(tmpdir(), 'auth-draft-credential-outage-'))
  try {
    const password = 'test-only credential store password'
    const store = new FileAccessCredentialStore(join(directory, 'access-auth.json'))
    await store.setPassword(password)
    const runtime = await createAccessAuthRuntime(AuthConfigSchema.parse({ enabled: true }), { store, env: {} })
    const origin = 'http://127.0.0.1:4096'
    const dispatch = async (path: string, init: RequestInit = {}) => {
      const request = new Request(origin + path, init)
      const context = {
        req: { raw: request, path, method: request.method, url: request.url,
          header: (name: string) => request.headers.get(name) ?? undefined, json: () => request.json() },
        json: (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers }),
      }
      return await runtime.service.handle(context, async () => {}, { remoteAddress: '127.0.0.1', localBrowserRelay: false }) as Response
    }
    const login = await dispatch('/access-auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password, surface: 'web' }) })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!
    const readStatus = () => dispatch('/access-auth/status', { headers: { Cookie: cookie } })
    const initial = await (await readStatus()).json()
    expect(initial.authenticated).toBe(true)
    globalThis.fetch = async () => readStatus()
    await auth.initialize('web')
    const lifecycle = await appAuthLifecycle()
    const load = store.load.bind(store)
    store.load = async () => { throw Object.assign(new Error('temporary credential read failure'), { code: 'EIO' }) }
    const unavailable = await readStatus()
    expect(unavailable.status).toBe(503)
    expect((await unavailable.json()).error.code).toBe('access_auth_unavailable')
    await lifecycle.mounted(); await Vue.nextTick()
    expect(auth.status.value).toBe('unknown')
    expect(auth.required.value).toBe(true)
    expect(values.has(key)).toBe(true)
    store.load = load
    const recovered = await (await readStatus()).json()
    expect(recovered.authenticated).toBe(true)
    expect(recovered.expiresAt).toBe(initial.expiresAt)
    await lifecycle.mounted(); await Vue.nextTick()
    expect(getComposerDraft('auth-session', undefined, '/auth/project').text).toBe('private text before outage')
    await dispatch('/access-auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })
    expect((await (await readStatus()).json()).authenticated).toBe(false)
    await lifecycle.mounted(); await Vue.nextTick()
    expect(auth.status.value).toBe('unauthenticated')
    expect(values.has(key)).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
