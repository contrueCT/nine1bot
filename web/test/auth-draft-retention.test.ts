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
