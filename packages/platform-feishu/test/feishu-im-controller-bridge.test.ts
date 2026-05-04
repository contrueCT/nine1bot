import { afterEach, describe, expect, test } from 'bun:test'
import { createHttpFeishuControllerBridge } from '../src/node'

describe('Feishu HTTP controller bridge', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('creates sessions through the public controller API', async () => {
    const seen: Array<{ url: string; init: RequestInit; body: any }> = []
    globalThis.fetch = mockFetch(async (url, init) => {
      seen.push({ url, init, body: JSON.parse(String(init.body)) })
      return jsonResponse({
        sessionId: 'ses_1',
        session: {
          id: 'ses_1',
          directory: 'C:/work',
          projectID: 'proj_1',
        },
      })
    })

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
      authHeader: 'Basic test',
    })
    await expect(bridge.createSession({
      directory: 'C:/work',
    })).resolves.toMatchObject({
      sessionId: 'ses_1',
      session: {
        id: 'ses_1',
      },
    })

    expect(new URL(seen[0]!.url).pathname).toBe('/nine1bot/agent/sessions')
    expect(seen[0]!.init.method).toBe('POST')
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Basic test')
    expect(seen[0]!.body.entry).toMatchObject({
      source: 'feishu',
      platform: 'feishu',
      mode: 'feishu-im',
    })
  })

  test('maps controller busy responses instead of throwing on 409', async () => {
    globalThis.fetch = mockFetch(async () => jsonResponse({
      accepted: false,
      busy: true,
      sessionId: 'ses_1',
      fallbackAction: {
        type: 'continue-in-web',
        label: 'Continue in web',
      },
    }, 409))

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
    })

    await expect(bridge.sendMessage({
      sessionId: 'ses_1',
      directory: 'C:/work',
      parts: [{ type: 'text', text: 'hello' }],
    })).resolves.toMatchObject({
      accepted: false,
      busy: true,
      status: 409,
    })
  })

  test('reads sessions and projects from public APIs', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const path = new URL(url).pathname
      if (path === '/session/ses_missing') return jsonResponse({ error: 'missing' }, 404)
      if (path === '/session/ses_1') return jsonResponse({ id: 'ses_1', directory: 'C:/work' })
      if (path === '/project') return jsonResponse([
        { id: 'old', name: 'Old', time: { updated: 1 } },
        { id: 'new', name: 'New', time: { updated: 2 } },
      ])
      if (path === '/project/new') return jsonResponse({ id: 'new', name: 'New' })
      return jsonResponse({ error: 'not found' }, 404)
    })

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
    })

    await expect(bridge.getSession({ sessionId: 'ses_1' })).resolves.toMatchObject({ id: 'ses_1' })
    await expect(bridge.getSession({ sessionId: 'ses_missing' })).resolves.toBeUndefined()
    await expect(bridge.listProjects()).resolves.toMatchObject([
      { id: 'new' },
      { id: 'old' },
    ])
    await expect(bridge.getProject('new')).resolves.toMatchObject({ id: 'new' })
  })
})

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    return handler(url, init)
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}
