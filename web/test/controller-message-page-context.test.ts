import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { api, setApiDirectory } from '../src/api/client'
import type { RequestPagePayload } from '../src/api/page-context'

type FetchCall = {
  url: string
  method: string
  body?: any
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

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({
      url,
      method: init?.method || 'GET',
      body,
    })
    return jsonResponse({ accepted: true, sessionId: 'ses_1', turnSnapshotId: 'turn_1' })
  }) as typeof fetch
}

beforeEach(() => {
  calls = []
  setApiDirectory('')
  installFetchMock()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setApiDirectory('')
})

describe('Controller message page context', () => {
  it('sends browser-extension entry and page context when page payload is available', async () => {
    const page: RequestPagePayload = {
      platform: 'gitlab',
      url: 'https://gitlab.com/nine1/nine1bot/-/merge_requests/42',
      title: 'Improve runtime',
      pageType: 'gitlab-mr',
      objectKey: 'gitlab.com:nine1/nine1bot:merge_request:42',
      selection: 'selected line',
      visibleSummary: 'MR overview',
    }

    await api.sendMessage('ses_1', 'hello', undefined, page)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/nine1bot/agent/sessions/ses_1/messages',
    })
    expect(calls[0]?.body).toMatchObject({
      parts: [{ type: 'text', text: 'hello' }],
      entry: {
        source: 'browser-extension',
        platform: 'gitlab',
        mode: 'browser-sidepanel',
      },
      context: {
        page,
      },
      clientCapabilities: {
        pageContext: true,
        selectionContext: true,
      },
    })
    expect(calls[0]?.body.entry.templateIds).toBeUndefined()
  })

  it('keeps standalone Web messages free of page context', async () => {
    await api.sendMessage('ses_1', 'hello')

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/nine1bot/agent/sessions/ses_1/messages',
    })
    expect(calls[0]?.body.context).toBeUndefined()
    expect(calls[0]?.body.entry).toEqual({
      source: 'web',
      mode: 'web-chat',
      templateIds: ['default-user-template', 'web-chat'],
    })
    expect(calls[0]?.body.clientCapabilities.pageContext).toBe(false)
    expect(calls[0]?.body.clientCapabilities.selectionContext).toBe(false)
  })

  it('creates browser-extension sessions with page context when available', async () => {
    const page: RequestPagePayload = {
      platform: 'gitlab',
      url: 'https://gitlab.com/nine1/nine1bot/-/issues/7',
      title: 'Issue 7',
      pageType: 'gitlab-issue',
      objectKey: 'gitlab.com:nine1/nine1bot:issue:7',
    }

    await api.createSession('C:/code/nine1bot', page)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/nine1bot/agent/sessions',
    })
    expect(calls[0]?.body).toMatchObject({
      directory: 'C:/code/nine1bot',
      page,
      entry: {
        source: 'browser-extension',
        platform: 'gitlab',
        mode: 'browser-sidepanel',
      },
      clientCapabilities: {
        pageContext: true,
        selectionContext: false,
      },
    })
    expect(calls[0]?.body.entry.templateIds).toBeUndefined()
  })

  it('returns Feishu context enrichment summaries from message send', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({
        url,
        method: init?.method || 'GET',
        body,
      })
      return jsonResponse({
        accepted: true,
        sessionId: 'ses_1',
        turnSnapshotId: 'turn_1',
        contextEnrichment: {
          platform: 'feishu',
          status: 'need_login',
          message: 'lark-cli needs Feishu login before metadata can be loaded.',
          tone: 'warning',
        },
      })
    }) as typeof fetch
    const page: RequestPagePayload = {
      platform: 'feishu',
      url: 'https://gdut-topview.feishu.cn/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg',
      title: 'Wiki Doc',
      pageType: 'feishu-wiki',
      objectKey: 'feishu:wiki:GKw9w6TOliwkBXkqO8UcphiDnUg',
    }

    const result = await api.sendMessage('ses_1', 'hello', undefined, page)

    expect(result.contextEnrichment).toMatchObject({
      platform: 'feishu',
      status: 'need_login',
    })
    expect(calls[0]?.body.entry).toEqual({
      source: 'browser-extension',
      platform: 'feishu',
      mode: 'browser-sidepanel',
    })
  })
})
