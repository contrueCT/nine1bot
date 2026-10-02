import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { api, createRequestID, permissionApi, questionApi, setApiDirectory, type EventStreamOptions, type Message, type MessageAttempt, type MessageSubmission, type Session } from '../src/api/client'
import { useSession } from '../src/composables/useSession'
import { useParallelSessions } from '../src/composables/useParallelSessions'
import { beginSend, clearComposerDrafts, finishSend, getComposerDraft, restoreAttempt } from '../src/composables/composer-drafts'

const original = [api, permissionApi, questionApi].map(object => [object, { ...object }] as const)
const originalWindow = globalThis.window
let active: ReturnType<typeof useSession>
const sources: { options: EventStreamOptions; closed: boolean }[] = []
const session = (id: string): Session => ({ id, title: id, directory: `/workspace/${id}`, time: { created: 1, updated: 1 } })
const message = (id: string, sessionID: string, role: 'user' | 'assistant' = 'user'): Message => ({ info: { id, sessionID, role, model: { providerID: 'p', modelID: 'm' }, time: { created: 1 } }, parts: [] })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function pageContext() {
  let listener: (event: any) => void
  let requestID: string
  let requests = 0
  const parent = { postMessage: (data: any) => { requestID = data.requestId; requests++ } }
  globalThis.window = {
    parent, location: { ancestorOrigins: ['chrome-extension://test'] },
    addEventListener: (_: string, handler: any) => { listener = handler }, removeEventListener() {},
  } as any
  return {
    get requests() { return requests },
    deliver(title = 'original page') { listener({ source: parent, origin: 'chrome-extension://test', data: { type: 'nine1bot.pageContext', requestId: requestID, payload: { platform: 'gitlab', title } } }) },
  }
}
beforeEach(() => {
  sources.length = 0
  api.subscribeSessionRuntimeEvents = (_id, _receive, options = {}) => {
    const source = { options, closed: false }
    sources.push(source)
    return { ready: Promise.resolve(), close() { source.closed = true }, connectionGeneration: () => 1 }
  }
  api.getMessages = async () => []
  api.getSessionStatus = async () => ({})
  api.getSessions = async () => []
  questionApi.list = async () => []
  permissionApi.list = async () => []
  api.abortSession = async () => {}
  api.changeSessionModel = async (_id, model) => ({ sessionId: 'A', currentModel: model })
  active = useSession()
})
afterEach(() => {
  active.unsubscribe()
  clearComposerDrafts()
  for (const id of ['A', 'B', 'C']) useParallelSessions().clearSession(id)
  for (const [object, methods] of original) Object.assign(object, methods)
  globalThis.window = originalWindow
  setApiDirectory('')
})

describe('stoppable and replayable sends', () => {
  it('does not POST after Stop during a model-change await', async () => {
    await active.selectSession(session('A'))
    const changed = deferred<any>()
    api.changeSessionModel = () => changed.promise
    let posts = 0
    api.sendMessage = async () => { posts++; return { accepted: true, sessionId: 'A' } }
    const sending = active.sendMessage('hello', { providerID: 'p', modelID: 'new' })
    await tick()
    expect(active.isStreaming.value).toBe(true)
    await active.abortCurrentSession()
    expect(active.isStreaming.value).toBe(false)
    changed.resolve({ currentModel: { providerID: 'p', modelID: 'new' } })
    expect(await sending).toBe(false)
    expect(posts).toBe(0)
  })
  it('does not POST after Stop during page context collection', async () => {
    await active.selectSession(session('A'))
    const page = pageContext()
    let posts = 0
    api.sendMessage = async () => { posts++; return { accepted: true, sessionId: 'A' } }
    const sending = active.sendMessage('hello')
    await tick()
    expect(page.requests).toBe(1)
    await active.abortCurrentSession()
    page.deliver()
    expect(await sending).toBe(false)
    expect(posts).toBe(0)
  })
  it('stops a draft before creating it and rejects a simultaneous duplicate send', async () => {
    active.createSession('/workspace/A')
    const page = pageContext()
    let creates = 0
    api.createSession = async () => { creates++; return session('A') }
    const sending = active.sendMessage('hello')
    expect(active.isStreaming.value).toBe(true)
    expect(await active.sendMessage('duplicate')).toBe(false)
    await active.abortCurrentSession()
    page.deliver()
    expect(await sending).toBe(false)
    expect(creates).toBe(0)
  })
  it('stays stoppable after the draft becomes a real session while history loads', async () => {
    active.createSession('/workspace/A')
    api.createSession = async () => session('A')
    const history = deferred<Message[]>()
    api.getMessages = () => history.promise
    let posts = 0
    api.sendMessage = async () => { posts++; return { accepted: true, sessionId: 'A' } }
    const sending = active.sendMessage('hello')
    await tick()
    expect(active.currentSession.value?.id).toBe('A')
    expect(active.isStreaming.value).toBe(true)
    await active.abortCurrentSession()
    history.resolve([])
    expect(await sending).toBe(false)
    expect(posts).toBe(0)
  })
  it('retries a lost 202 with the same ID and exact original model/files/page even while busy', async () => {
    await active.selectSession(session('A'))
    const page = pageContext()
    const draft = getComposerDraft('A')
    draft.text = 'original text'
    const attempt = beginSend(draft)
    const payloads: string[] = []
    const file = { type: 'file' as const, mime: 'text/plain', filename: 'original.txt', url: 'file:///original' }
    const model = { providerID: 'p', modelID: 'original' }
    let modelChanges = 0
    api.changeSessionModel = async () => { modelChanges++; return { sessionId: 'A', currentModel: model } }
    let busy = false
    api.getSessionStatus = async () => busy ? { A: { type: 'busy' } } : {}
    api.sendMessage = async (_id, request) => {
      payloads.push((request as MessageSubmission).body)
      busy = true
      if (payloads.length === 1) throw new Error('202 response lost')
      return { accepted: true, sessionId: 'A' }
    }
    const first = active.sendMessage(attempt.text, model, [file], attempt)
    await tick()
    page.deliver()
    finishSend(draft, attempt, await first)
    expect(attempt.status).toBe('failed')
    expect(attempt.submitted).toBe(true)
    expect(active.isStreaming.value).toBe(true)
    expect(restoreAttempt(draft, attempt)).toBe(false)
    file.filename = 'changed.txt'
    model.modelID = 'changed'
    const second = await active.sendMessage('changed input', model, [file], attempt)
    expect(second).toBe(true)
    expect(payloads).toHaveLength(2)
    expect(payloads[1]).toBe(payloads[0])
    expect(JSON.parse(payloads[0])).toMatchObject({ requestID: attempt.id, model: { providerID: 'p', modelID: 'original' }, context: { page: { title: 'original page' } }, parts: [{ type: 'text', text: 'original text' }, { filename: 'original.txt' }] })
    expect(page.requests).toBe(1)
    expect(modelChanges).toBe(1)
    expect(active.sessionNotifications.value).toHaveLength(0)
  })
  it('keeps a request identifiable in the snapshot but awaits a positive replay acknowledgement', async () => {
    await active.selectSession(session('A'))
    const attempt: MessageAttempt = { id: createRequestID() }
    let posts = 0
    api.sendMessage = async () => {
      posts++
      api.getMessages = async () => [{ ...message('msg_server_owned', 'A'), info: { ...message('msg_server_owned', 'A').info, requestID: attempt.id } }]
      if (posts === 1) throw new Error('response lost')
      return { accepted: true, sessionId: 'A' }
    }
    expect(await active.sendMessage('hello', undefined, undefined, attempt)).toBe(false)
    expect(active.messages.value[0].info.requestID).toBe(attempt.id)
    expect(await active.sendMessage('hello', undefined, undefined, attempt)).toBe(true)
    expect(posts).toBe(2)
  })
  it('reconciles a completed replay that emits no new idle event', async () => {
    await active.selectSession(session('A'))
    const attempt: MessageAttempt = { id: createRequestID() }
    let posts = 0
    api.sendMessage = async () => {
      if (++posts === 1) throw new Error('response lost')
      return { accepted: true, sessionId: 'A' }
    }
    expect(await active.sendMessage('hello', undefined, undefined, attempt)).toBe(false)
    expect(active.isStreaming.value).toBe(false)
    expect(await active.sendMessage('hello', undefined, undefined, attempt)).toBe(true)
    expect(active.isStreaming.value).toBe(false)
  })
  it('can safely retry an unknown POST even when the recovery snapshot also failed', async () => {
    await active.selectSession(session('A'))
    const attempt: MessageAttempt = { id: createRequestID() }
    let posts = 0
    api.sendMessage = async () => {
      if (++posts === 1) {
        api.getMessages = async () => { throw new Error('history offline') }
        throw new Error('response lost')
      }
      api.getMessages = async () => [{ ...message('msg_server_owned', 'A'), info: { ...message('msg_server_owned', 'A').info, requestID: attempt.id } }]
      return { accepted: true, sessionId: 'A' }
    }
    const originalError = console.error
    console.error = () => {}
    try { expect(await active.sendMessage('hello', undefined, undefined, attempt)).toBe(false) }
    finally { console.error = originalError }
    expect(active.isStreaming.value).toBe(false)
    expect(await active.sendMessage('hello', undefined, undefined, attempt)).toBe(true)
    expect(active.isStreaming.value).toBe(false)
    expect(posts).toBe(2)
  })
  it('reconciles idle after an accepted replay even when history stays offline, without another POST for history retry', async () => {
    await active.selectSession(session('A'))
    const displayed = message('displayed-before-failure', 'A', 'assistant')
    active.messages.value = [displayed]
    const draft = getComposerDraft('A')
    draft.text = 'keep original'
    const attempt = beginSend(draft)
    let posts = 0
    api.getMessages = async () => { throw new Error('persistent history outage') }
    api.getSessionStatus = async () => ({ A: { type: 'idle' } })
    api.sendMessage = async () => {
      if (++posts === 1) throw new Error('202 acknowledgement lost')
      return { accepted: true, sessionId: 'A' }
    }
    const first = await active.sendMessage(attempt.text, undefined, undefined, attempt)
    finishSend(draft, attempt, first)
    expect(first).toBe(false)
    expect(active.isStreaming.value).toBe(false)
    expect(active.historyError.value).toBe('persistent history outage')
    expect(active.messages.value).toEqual([displayed])
    const replayed = await active.sendMessage(attempt.text, undefined, undefined, attempt)
    finishSend(draft, attempt, replayed)
    expect(replayed).toBe(true)
    expect(draft.attempts).toHaveLength(0)
    expect(active.isStreaming.value).toBe(false)
    expect(active.historyError.value).toBe('persistent history outage')
    expect(active.messages.value).toEqual([displayed])
    expect(await active.retryHistory()).toBe(false)
    expect(active.isStreaming.value).toBe(false)
    expect(posts).toBe(2)
    api.getMessages = async () => [displayed, message('recovered-original', 'A')]
    expect(await active.retryHistory()).toBe(true)
    expect(active.historyError.value).toBeNull()
    expect(active.messages.value).toHaveLength(2)
    expect(posts).toBe(2)
  })
  it('does not let an interrupted older preflight post after a newer send starts', async () => {
    await active.selectSession(session('A'))
    const changed = deferred<any>()
    api.changeSessionModel = () => changed.promise
    const sent: string[] = []
    api.sendMessage = async (_id, request) => { sent.push((request as MessageSubmission).body); return { accepted: true, sessionId: 'A' } }
    const first = active.sendMessage('cancelled', { providerID: 'p', modelID: 'slow' })
    await tick()
    await active.abortCurrentSession()
    expect(await active.sendMessage('new')).toBe(true)
    changed.resolve({ currentModel: { providerID: 'p', modelID: 'slow' } })
    expect(await first).toBe(false)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]).parts[0].text).toBe('new')
    expect(active.isStreaming.value).toBe(true)
  })
})

describe('stream and selected-session ownership', () => {
  it('replaces an exhausted SSE subscription on history retry and ignores old callbacks', async () => {
    await active.selectSession(session('A'))
    const old = sources[0]
    old.options.onGiveUp?.()
    expect(active.connectionState.value).toBe('offline')
    expect(old.closed).toBe(true)
    await active.retryHistory()
    expect(sources).toHaveLength(2)
    expect(active.connectionState.value).toBe('connected')
    old.options.onGiveUp?.()
    expect(active.connectionState.value).toBe('connected')
  })
  it('recreates an exhausted SSE and reloads history before sending', async () => {
    await active.selectSession(session('A'))
    sources[0].options.onGiveUp?.()
    let historyLoaded = false
    api.getMessages = async () => { historyLoaded = true; return [] }
    api.sendMessage = async () => { expect(historyLoaded).toBe(true); expect(sources).toHaveLength(2); return { accepted: true, sessionId: 'A' } }
    expect(await active.sendMessage('hello')).toBe(true)
  })
  it('does not send a new message if reconnection discovers a running turn', async () => {
    await active.selectSession(session('A'))
    sources[0].options.onGiveUp?.()
    api.getSessionStatus = async () => ({ A: { type: 'busy' } })
    let posts = 0
    api.sendMessage = async () => { posts++; return { accepted: true, sessionId: 'A' } }
    expect(await active.sendMessage('hello')).toBe(false)
    expect(posts).toBe(0)
  })
  it('does not let an older partial recovery overwrite the latest status and history error', async () => {
    await active.selectSession(session('A'))
    const oldStatus = deferred<any>()
    api.getMessages = async () => { throw new Error('old history error') }
    api.getSessionStatus = () => oldStatus.promise
    useParallelSessions().setSessionRunning('A', true)
    const oldRecovery = active.retryHistory()
    await tick()
    api.getMessages = async () => { throw new Error('current history error') }
    api.getSessionStatus = async () => ({ A: { type: 'idle' } })
    expect(await active.retryHistory()).toBe(false)
    expect(active.isStreaming.value).toBe(false)
    oldStatus.resolve({ A: { type: 'busy' } })
    expect(await oldRecovery).toBe(false)
    expect(active.isStreaming.value).toBe(false)
    expect(active.historyError.value).toBe('current history error')
  })
  it('ignores partial recovery status after selecting another session', async () => {
    await active.selectSession(session('A'))
    const oldStatus = deferred<any>()
    api.getMessages = async () => { throw new Error('A history error') }
    api.getSessionStatus = () => oldStatus.promise
    const recovering = active.retryHistory()
    await tick()
    api.getMessages = async id => [message('B-message', id)]
    api.getSessionStatus = async () => ({ B: { type: 'busy' } })
    await active.selectSession(session('B'))
    oldStatus.resolve({ A: { type: 'idle' }, B: { type: 'idle' } })
    expect(await recovering).toBe(false)
    expect(active.currentSession.value?.id).toBe('B')
    expect(active.isStreaming.value).toBe(true)
    expect(active.historyError.value).toBeNull()
    expect(active.messages.value[0].info.sessionID).toBe('B')
  })
  it('ignores a late directory update after changing sessions and returning', async () => {
    await active.selectSession(session('A'))
    const update = deferred<Session>()
    api.updateSession = () => update.promise
    const changing = active.changeDirectory('/new/A')
    await active.selectSession(session('B'))
    await active.selectSession(session('A'))
    update.resolve({ ...session('A'), directory: '/new/A' })
    await changing
    expect(active.currentDirectory.value).toBe('/workspace/A')
  })
  it('keeps only the latest same-session directory response', async () => {
    await active.selectSession(session('A'))
    const first = deferred<Session>()
    api.updateSession = async (_id, changes) => changes.directory === '/first' ? first.promise : { ...session('A'), directory: '/second' }
    const changing = active.changeDirectory('/first')
    await active.changeDirectory('/second')
    first.resolve({ ...session('A'), directory: '/first' })
    await changing
    expect(active.currentDirectory.value).toBe('/second')
  })
  it('does not refresh a different session after summary completion', async () => {
    api.getMessages = async id => [message(`m-${id}`, id, 'assistant')]
    await active.selectSession(session('A'))
    const summary = deferred<void>()
    api.summarizeSession = () => summary.promise
    const summarizing = active.summarizeSession()
    await active.selectSession(session('B'))
    expect(active.isSummarizing.value).toBe(false)
    summary.resolve()
    await summarizing
    expect(active.messages.value[0].info.sessionID).toBe('B')
  })
  it('ignores late summary history after navigating during refresh', async () => {
    api.getMessages = async id => [message(`m-${id}`, id, 'assistant')]
    await active.selectSession(session('A'))
    const history = deferred<Message[]>()
    api.summarizeSession = async () => {}
    api.getMessages = async id => id === 'A' ? history.promise : [message(`m-${id}`, id, 'assistant')]
    const summarizing = active.summarizeSession()
    await tick()
    await active.selectSession(session('B'))
    history.resolve([message('summary-A', 'A', 'assistant')])
    await summarizing
    expect(active.messages.value[0].info.sessionID).toBe('B')
  })
  it('ignores stale todo success and failure, including a newer same-session refresh', async () => {
    await active.selectSession(session('A'))
    const old = deferred<any>()
    api.getSessionTodo = () => old.promise
    const loading = active.loadTodoItems()
    await active.selectSession(session('B'))
    api.getSessionTodo = async () => [{ id: 'B', content: 'B task', status: 'pending', priority: 'high' }]
    await active.loadTodoItems()
    old.resolve([{ id: 'A', content: 'A task' }])
    await loading
    expect(active.todoItems.value[0].id).toBe('B')
    const fail = deferred<any>()
    api.getSessionTodo = () => fail.promise
    const failing = active.loadTodoItems()
    api.getSessionTodo = async () => [{ id: 'new-B', content: 'new B', status: 'pending', priority: 'high' }]
    await active.loadTodoItems()
    fail.reject(new Error('old failure'))
    await failing
    expect(active.todoItems.value[0].id).toBe('new-B')
  })
})
