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

  test('does not pass Feishu message ids as controller messageID', async () => {
    const seen: Array<{ url: string; init: RequestInit; body: any }> = []
    globalThis.fetch = mockFetch(async (url, init) => {
      seen.push({ url, init, body: JSON.parse(String(init.body)) })
      return jsonResponse({
        accepted: true,
        busy: false,
        sessionId: 'ses_1',
        turnSnapshotId: 'turn_1',
      })
    })

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
    })

    await expect(bridge.sendMessage({
      sessionId: 'ses_1',
      directory: 'C:/work',
      messageId: 'om_feishu_external',
      parts: [{ type: 'text', text: 'hello' }],
    })).resolves.toMatchObject({
      accepted: true,
      turnSnapshotId: 'turn_1',
    })

    expect(new URL(seen[0]!.url).pathname).toBe('/nine1bot/agent/sessions/ses_1/messages')
    expect(seen[0]!.body).not.toHaveProperty('messageID')
    expect(seen[0]!.body.entry).toMatchObject({
      source: 'feishu',
      platform: 'feishu',
      traceId: 'om_feishu_external',
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

  test('uses shared platform controller for simple JSON requests', async () => {
    const seen: Array<{ path: string; init: unknown }> = []
    globalThis.fetch = mockFetch(async () => {
      throw new Error('fetch should not be called')
    })

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
      platformController: {
        localUrl: 'http://127.0.0.1:4096',
        async requestJson<T = unknown>(path: string, init: unknown): Promise<T> {
          seen.push({ path, init })
          return [
            { id: 'old', name: 'Old', time: { updated: 1 } },
            { id: 'new', name: 'New', time: { updated: 2 } },
          ] as T
        },
      },
    })

    await expect(bridge.listProjects()).resolves.toMatchObject([
      { id: 'new' },
      { id: 'old' },
    ])
    expect(seen).toEqual([{
      path: '/project',
      init: {
        method: 'GET',
        headers: {},
        body: undefined,
      },
    }])
  })

  test('aborts sessions through the public session API', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = mockFetch(async (url, init) => {
      seen.push({ url, init })
      return jsonResponse(true)
    })

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
      authHeader: 'Basic test',
    })

    await expect(bridge.abortSession({
      sessionId: 'ses_1',
      directory: 'C:/work',
    })).resolves.toBe(true)

    expect(new URL(seen[0]!.url).pathname).toBe('/session/ses_1/abort')
    expect(new URL(seen[0]!.url).searchParams.get('directory')).toBe('C:/work')
    expect(seen[0]!.init.method).toBe('POST')
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Basic test')
  })

  test('parses CRLF and multi-line SSE data frames', async () => {
    const encoder = new TextEncoder()
    globalThis.fetch = mockFetch(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":\r\n'))
        controller.enqueue(encoder.encode('data: "runtime.turn.completed","turnSnapshotId":"turn_1"}\r\n\r\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    }))

    const bridge = createHttpFeishuControllerBridge({
      localUrl: 'http://127.0.0.1:4096',
    })
    const events: unknown[] = []
    const errors: Error[] = []
    const done = new Promise<void>((resolve) => {
      bridge.subscribeEvents({
        sessionId: 'ses_1',
        onEvent(event) {
          events.push(event)
          resolve()
        },
        onError(error) {
          errors.push(error)
          resolve()
        },
      })
    })

    await done
    expect(errors).toEqual([])
    expect(events).toEqual([{
      type: 'runtime.turn.completed',
      turnSnapshotId: 'turn_1',
    }])
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
