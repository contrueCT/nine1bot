import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useSettings } from '../src/composables/useSettings'
import { setApiDirectory } from '../src/api/client'

type FetchCall = {
  url: string
  method: string
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

function installFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = init?.method || 'GET'
    calls.push({ url, method })
    return handler(url, init)
  }) as typeof fetch
}

beforeEach(() => {
  calls = []
  setApiDirectory('')
  const settings = useSettings()
  settings.platforms.value = []
  settings.selectedPlatformId.value = ''
  settings.selectedPlatform.value = null
  settings.platformError.value = ''
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setApiDirectory('')
})

describe('useSettings platform selection', () => {
  it('clears stale selection when platform list is empty', async () => {
    const settings = useSettings()
    settings.selectedPlatformId.value = 'gitlab'
    settings.selectedPlatform.value = {
      id: 'gitlab',
      name: 'GitLab',
      packageName: '@nine1bot/platform-gitlab',
      installed: true,
      builtIn: true,
      enabled: true,
      registered: true,
      lifecycleStatus: 'healthy',
      status: 'available',
      capabilities: {},
      descriptor: {
        id: 'gitlab',
        name: 'GitLab',
        packageName: '@nine1bot/platform-gitlab',
        version: '0.1.0',
        capabilities: {},
      },
      actions: [],
      features: {},
      settings: {},
      runtimeStatus: { status: 'available' },
    }
    installFetchMock((url) => {
      if (url === '/nine1bot/platforms') return jsonResponse({ platforms: [] })
      throw new Error(`Unexpected request: ${url}`)
    })

    await settings.loadPlatforms()

    expect(settings.selectedPlatformId.value).toBe('')
    expect(settings.selectedPlatform.value).toBeNull()
    expect(calls).toEqual([{ method: 'GET', url: '/nine1bot/platforms' }])
  })

  it('moves selection to first available platform when current id disappears', async () => {
    const settings = useSettings()
    settings.selectedPlatformId.value = 'missing'
    installFetchMock((url) => {
      if (url === '/nine1bot/platforms') {
        return jsonResponse({
          platforms: [{
            id: 'gitlab',
            name: 'GitLab',
            packageName: '@nine1bot/platform-gitlab',
            enabled: true,
            registered: true,
            status: 'available',
            lifecycleStatus: 'healthy',
            capabilities: {},
          }],
        })
      }
      if (url === '/nine1bot/platforms/gitlab') {
        return jsonResponse({
          id: 'gitlab',
          name: 'GitLab',
          packageName: '@nine1bot/platform-gitlab',
          installed: true,
          builtIn: true,
          enabled: true,
          registered: true,
          lifecycleStatus: 'healthy',
          status: 'available',
          capabilities: {},
          descriptor: {
            id: 'gitlab',
            name: 'GitLab',
            packageName: '@nine1bot/platform-gitlab',
            version: '0.1.0',
            capabilities: {},
          },
          actions: [],
          features: {},
          settings: {},
          runtimeStatus: { status: 'available' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await settings.loadPlatforms()

    expect(settings.selectedPlatformId.value).toBe('gitlab')
    expect(settings.selectedPlatform.value?.id).toBe('gitlab')
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', '/nine1bot/platforms'],
      ['GET', '/nine1bot/platforms/gitlab'],
    ])
  })
})
