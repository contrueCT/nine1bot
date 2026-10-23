import { afterEach, beforeEach, expect, test } from 'bun:test'
import { authApi, getApiDirectory, providerApi, setApiDirectory } from '../src/api/client'
import { useSettings } from '../src/composables/useSettings'

const originals = { list: providerApi.list, methods: providerApi.getAuthMethods, start: providerApi.startOAuth, complete: providerApi.completeOAuth, authList: authApi.list, setApiKey: authApi.setApiKey, removeAuth: authApi.remove, window: globalThis.window, fetch: globalThis.fetch }
const settings = useSettings()
const originalDirectory = getApiDirectory()
let popup: { opener: unknown; closed: boolean; location: { href: string }; close(): void }
let authenticated = false

beforeEach(() => {
  settings.cancelProviderOAuth()
  authenticated = false
  settings.providers.value = [{ id: 'vendor', name: 'Vendor', models: [], authenticated: false,
    authMethods: [{ type: 'api', name: 'API Key' }, { type: 'oauth', name: 'Device login' }] }]
  popup = { opener: {}, closed: false, location: { href: '' }, close() { this.closed = true } }
  globalThis.window = { open: () => popup } as unknown as Window & typeof globalThis
  providerApi.list = async () => ({ providers: settings.providers.value, defaults: {}, connected: authenticated ? ['vendor'] : [] })
  providerApi.getAuthMethods = async () => ({ vendor: [{ type: 'api', name: 'API Key' }, { type: 'oauth', name: 'Device login' }] })
  authApi.list = async () => authenticated ? ['vendor'] : []
})

afterEach(() => {
  settings.cancelProviderOAuth()
  settings.providers.value = []
  providerApi.list = originals.list
  providerApi.getAuthMethods = originals.methods
  providerApi.startOAuth = originals.start
  providerApi.completeOAuth = originals.complete
  authApi.list = originals.authList
  authApi.setApiKey = originals.setApiKey
  authApi.remove = originals.removeAuth
  globalThis.window = originals.window
  globalThis.fetch = originals.fetch
  setApiDirectory(originalDirectory)
})

test('auto authorization uses the OAuth method index, keeps device instructions, and completes before refreshing providers', async () => {
  const calls: unknown[] = []
  providerApi.startOAuth = async (id, method) => {
    calls.push(['authorize', id, method])
    return { url: 'https://example.invalid/device', method: 'auto', instructions: 'Enter code: DEVICE-CODE' }
  }
  providerApi.completeOAuth = async (id, code, method) => {
    expect(settings.providerOAuth.value?.instructions).toContain('DEVICE-CODE')
    expect(settings.providerOAuth.value?.status).toBe('completing')
    calls.push(['complete', id, code, method])
    authenticated = true
  }
  expect(await settings.startOAuth('vendor')).toBe(true)
  expect(calls).toEqual([['authorize', 'vendor', 1], ['complete', 'vendor', undefined, 1]])
  expect(popup.location.href).toBe('https://example.invalid/device')
  expect(popup.opener).toBeNull()
  expect(settings.providers.value[0].authenticated).toBe(true)
  expect(settings.providerOAuth.value?.status).toBe('success')
})

test('manual code login waits for input, keeps the original directory, and permits retry after a rejection', async () => {
  setApiDirectory('/workspace/original')
  let callbacks = 0
  providerApi.startOAuth = async () => ({ url: 'https://example.invalid/manual', method: 'code', instructions: 'Paste your authorization code' })
  providerApi.completeOAuth = async (_id, code, method, options) => {
    callbacks++
    expect(options?.directory).toBe('/workspace/original')
    expect(method).toBe(1)
    if (callbacks === 1) throw new Error('Invalid code')
    expect(code).toBe('good-code')
    authenticated = true
  }
  expect(await settings.startOAuth('vendor')).toBe(false)
  expect(callbacks).toBe(0)
  expect(await settings.completeProviderOAuth('  ')).toBe(false)
  setApiDirectory('/workspace/other')
  await expect(settings.completeProviderOAuth('bad-code')).rejects.toThrow('Invalid code')
  expect(settings.providerOAuth.value?.status).toBe('error')
  expect(await settings.completeProviderOAuth(' good-code ')).toBe(true)
  expect(callbacks).toBe(2)
})

test('a blocked popup keeps an authorization link and instructions available', async () => {
  globalThis.window = { open: () => null } as unknown as Window & typeof globalThis
  providerApi.startOAuth = async () => ({ url: 'https://example.invalid/manual', method: 'code', instructions: 'Use this link' })
  expect(await settings.startOAuth('vendor')).toBe(false)
  expect(settings.providerOAuth.value?.url).toBe('https://example.invalid/manual')
  expect(settings.providerOAuth.value?.instructions).toBe('Use this link')
})

test('stopping an authorization ignores its late completion and prevents a stale provider refresh', async () => {
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  let refreshes = 0
  providerApi.list = async () => { refreshes++; return { providers: [], defaults: {}, connected: [] } }
  providerApi.startOAuth = async () => ({ url: 'https://example.invalid/device', method: 'auto', instructions: 'Wait' })
  providerApi.completeOAuth = async () => pending
  const starting = settings.startOAuth('vendor')
  await Promise.resolve()
  await Promise.resolve()
  settings.cancelProviderOAuth()
  complete()
  expect(await starting).toBe(false)
  expect(settings.providerOAuth.value).toBeNull()
  expect(refreshes).toBe(0)
})

for (const action of ['api-key', 'logout'] as const) {
  test(`${action} clears the matching OAuth wait and ignores its late completion`, async () => {
    let complete!: () => void
    providerApi.startOAuth = async () => ({ url: 'https://example.invalid/device', method: 'auto', instructions: 'Wait' })
    providerApi.completeOAuth = async () => new Promise<void>(resolve => { complete = resolve })
    authApi.setApiKey = async () => { authenticated = true }
    authApi.remove = async () => { authenticated = false }
    const starting = settings.startOAuth('vendor')
    await Promise.resolve()
    await Promise.resolve()
    expect(settings.providerOAuth.value?.status).toBe('completing')
    if (action === 'api-key') expect(await settings.setApiKey('vendor', 'manual-key')).toBe(true)
    else await settings.removeAuth('vendor')
    expect(settings.providerOAuth.value).toBeNull()
    complete()
    expect(await starting).toBe(false)
    expect(settings.providers.value[0].authenticated).toBe(authenticated)
  })
}

test('provider API retains auth method labels and authorization metadata', async () => {
  providerApi.getAuthMethods = originals.methods
  providerApi.startOAuth = originals.start
  globalThis.fetch = async input => String(input).includes('/provider/auth')
    ? Response.json({ vendor: [{ type: 'api', label: 'Key' }, { type: 'oauth', label: 'Device login' }] })
    : Response.json({ url: 'https://example.invalid/device', method: 'auto', instructions: 'Enter code: DEVICE-CODE' })
  expect((await providerApi.getAuthMethods()).vendor[1].name).toBe('Device login')
  expect(await providerApi.startOAuth('vendor', 1)).toEqual({ url: 'https://example.invalid/device', method: 'auto', instructions: 'Enter code: DEVICE-CODE' })
})

test('provider callback reports HTTP failures instead of showing false success', async () => {
  providerApi.completeOAuth = originals.complete
  globalThis.fetch = async () => Response.json({ error: 'Authorization denied' }, { status: 400 })
  await expect(providerApi.completeOAuth('vendor')).rejects.toThrow()
})

test('provider callback waits beyond normal API deadlines and supports bounded cancellation', async () => {
  providerApi.completeOAuth = originals.complete
  let path = ''
  globalThis.fetch = async (input, init) => {
    path = String(input)
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    })
  }
  await expect(providerApi.completeOAuth('vendor', undefined, 1, { directory: '/workspace/original', timeoutMs: 10 })).rejects.toThrow('授权等待超时')
  expect(path).toContain('directory=%2Fworkspace%2Foriginal')
})
