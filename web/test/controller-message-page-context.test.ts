import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { api, createRequestID, createMessageSubmission, setApiDirectory } from '../src/api/client'
import type { RequestPagePayload } from '../src/api/page-context'

type FetchCall = {
  url: string
  method: string
  body?: any
  signal?: AbortSignal | null
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
      signal: init?.signal,
    })
    return url === '/nine1bot/agent/sessions'
      ? jsonResponse({ session: { id: 'ses_1', directory: body.directory || '.', time: { created: 1, updated: 1 } } })
      : jsonResponse({ accepted: true, sessionId: 'ses_1', turnSnapshotId: 'turn_1' })
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
    expect(calls[0]?.body.requestID).toMatch(/^req_/)
    expect(calls[0]?.body.messageID).toBeUndefined()
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

  it('uses abortable bounded requests for agent control calls', async () => {
    await api.sendMessage('ses_1', 'hello')
    await api.changeSessionModel('ses_1', {
      providerID: 'test-provider',
      modelID: 'test-model',
    })
    await api.abortSession('ses_1')

    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true)
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


describe('immutable message submissions', () => {
  it('uses bounded request identities independent of client-clock ordering', () => {
    const ids = Array.from({ length: 4200 }, () => createRequestID())
    expect(ids.every(id => /^req_[A-Za-z0-9_-]{1,124}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('replays the identical wire body after a lost 202 without reserializing mutated context/model/files', async () => {
    const page = { platform: 'gitlab', title: 'original' }
    const model = { providerID: 'p', modelID: 'm' }
    const files = [{ type: 'file' as const, mime: 'text/plain', filename: 'original.txt', url: 'file:///original' }]
    const submission = createMessageSubmission('hello', files, page, model)
    const bodies: string[] = []
    const receipts = new Map<string, string>()
    let executions = 0
    globalThis.fetch = (async (_input, init) => {
      const body = String(init?.body)
      bodies.push(body)
      const { requestID } = JSON.parse(body)
      if (!receipts.has(requestID)) {
        receipts.set(requestID, body)
        executions++
        throw new Error('202 response lost')
      }
      expect(receipts.get(requestID)).toBe(body)
      return jsonResponse({ accepted: true, sessionId: 'ses_1' }, 202)
    }) as typeof fetch
    await expect(api.sendMessage('ses_1', submission)).rejects.toThrow('202 response lost')
    page.title = 'different page'
    model.modelID = 'different model'
    files[0].filename = 'different.txt'
    await api.sendMessage('ses_1', submission)
    expect(bodies).toEqual([submission.body, submission.body])
    expect(executions).toBe(1)
    expect(JSON.parse(submission.body)).toMatchObject({ requestID: submission.requestID, model: { modelID: 'm' }, context: { page: { title: 'original' } } })
  })
})

it('reports incomplete persisted requests distinctly from a busy session', async () => {
  globalThis.fetch = (async () => jsonResponse({ error: { code: 'REQUEST_INCOMPLETE', message: '上次请求未完整保存，请检查并清理未完成消息后重试' } }, 409)) as typeof fetch
  await expect(api.sendMessage('ses_1', createMessageSubmission('hello'))).rejects.toThrow('未完整保存')
})

it('distinguishes request conflicts from explicit busy responses', async () => {
  globalThis.fetch = (async () => jsonResponse({ error: { code: 'REQUEST_CONFLICT', message: 'Request ID already belongs to another request' } }, 409)) as typeof fetch
  await expect(api.sendMessage('ses_1', createMessageSubmission('hello'))).rejects.toThrow('already belongs')
  globalThis.fetch = (async () => jsonResponse({ busy: true, sessionId: 'ses_1' }, 409)) as typeof fetch
  await expect(api.sendMessage('ses_1', createMessageSubmission('hello'))).rejects.toMatchObject({ name: 'SessionBusyError' })
})
