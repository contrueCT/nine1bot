import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  api,
  permissionApi,
  questionApi,
  type Message,
  type Session,
} from '../src/api/client'
import { useSession } from '../src/composables/useSession'
import { useParallelSessions } from '../src/composables/useParallelSessions'

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  static autoOpen = true

  readonly url: string
  readyState = FakeEventSource.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
    queueMicrotask(() => {
      if (FakeEventSource.autoOpen && this.readyState === FakeEventSource.CONNECTING) this.open()
    })
  }

  addEventListener() {}

  close() {
    this.readyState = FakeEventSource.CLOSED
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  static get latest() {
    const latest = FakeEventSource.instances.at(-1)
    if (!latest) throw new Error('No EventSource instance')
    return latest
  }
}

function session(id: string): Session {
  return {
    id,
    title: id,
    directory: `/workspace/${id}`,
    time: { created: 1, updated: 1 },
  }
}

function message(id: string, sessionID: string): Message {
  return {
    info: {
      id,
      sessionID,
      role: 'assistant',
      time: { created: 1 },
    },
    parts: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const NativeEventSource = globalThis.EventSource
const originalGetMessages = api.getMessages
const originalGetSessionStatus = api.getSessionStatus
const originalSendMessage = api.sendMessage
const originalAbortSession = api.abortSession
const originalQuestionList = questionApi.list
const originalPermissionList = permissionApi.list
let active: ReturnType<typeof useSession> | undefined

describe('useSession event recovery', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    FakeEventSource.autoOpen = true
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    api.getSessionStatus = async () => ({})
    questionApi.list = async () => []
    permissionApi.list = async () => []
  })

  afterEach(() => {
    active?.unsubscribe()
    active = undefined
    api.getMessages = originalGetMessages
    api.getSessionStatus = originalGetSessionStatus
    api.sendMessage = originalSendMessage
    api.abortSession = originalAbortSession
    questionApi.list = originalQuestionList
    permissionApi.list = originalPermissionList
    globalThis.EventSource = NativeEventSource
  })

  it('does not let a stale session snapshot overwrite the newly selected session', async () => {
    const sessionA = session('session-a')
    const sessionB = session('session-b')
    const messagesA = deferred<Message[]>()
    api.getMessages = async (sessionID) => {
      if (sessionID === sessionA.id) return messagesA.promise
      return [message('message-b', sessionB.id)]
    }

    active = useSession()
    const selectingA = active.selectSession(sessionA)
    const selectingB = active.selectSession(sessionB)
    await selectingB
    messagesA.resolve([message('message-a', sessionA.id)])
    await selectingA

    expect(active.currentSession.value?.id).toBe(sessionB.id)
    expect(active.messages.value.map((item) => item.info.id)).toEqual(['message-b'])
  })

  it('waits for the dedicated session event stream before posting a message', async () => {
    const selected = session('session-ready')
    api.getMessages = async () => []
    api.sendMessage = async () => ({
      accepted: true,
      sessionId: selected.id,
    })

    active = useSession()
    await active.selectSession(selected)
    active.unsubscribe()
    FakeEventSource.autoOpen = false

    let posted = false
    api.sendMessage = async () => {
      posted = true
      return { accepted: true, sessionId: selected.id }
    }
    const sending = active.sendMessage('hello')
    const beforeOpen = await Promise.race([
      sending.then(() => 'sent'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20)),
    ])
    expect(beforeOpen).toBe('waiting')
    expect(posted).toBe(false)

    FakeEventSource.latest.open()
    await sending
    expect(posted).toBe(true)
  })

  it('reloads all recovery inputs after the session event stream reconnects', async () => {
    const selected = session('session-reconnect')
    const calls = {
      messages: 0,
      statuses: 0,
      questions: 0,
      permissions: 0,
    }
    api.getMessages = async () => {
      calls.messages++
      return []
    }
    api.getSessionStatus = async () => {
      calls.statuses++
      return {}
    }
    questionApi.list = async () => {
      calls.questions++
      return []
    }
    permissionApi.list = async () => {
      calls.permissions++
      return []
    }

    active = useSession()
    await active.selectSession(selected)
    const baseline = { ...calls }

    FakeEventSource.latest.open()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toEqual({
      messages: baseline.messages + 1,
      statuses: baseline.statuses + 1,
      questions: baseline.questions + 1,
      permissions: baseline.permissions + 1,
    })
  })

  it('reconciles abort state instead of declaring the session idle early', async () => {
    const selected = session('session-abort')
    api.getMessages = async () => []
    api.getSessionStatus = async () => ({
      [selected.id]: { type: 'busy' },
    })
    api.abortSession = async () => {}

    active = useSession()
    await active.selectSession(selected)
    useParallelSessions().setSessionRunning(selected.id, true)
    await active.abortSession(selected.id)

    expect(active.isStreaming.value).toBe(true)
    useParallelSessions().clearSession(selected.id)
  })

  it('also reconciles when the abort request itself fails', async () => {
    const selected = session('session-abort-failed')
    let statusLoads = 0
    api.getMessages = async () => []
    api.getSessionStatus = async () => {
      statusLoads++
      return { [selected.id]: { type: 'busy' } }
    }
    api.abortSession = async () => {
      throw new Error('Abort request failed')
    }

    active = useSession()
    await active.selectSession(selected)
    const baselineLoads = statusLoads
    const nativeConsoleError = console.error
    console.error = () => {}
    try {
      await active.abortSession(selected.id)
    } finally {
      console.error = nativeConsoleError
    }

    expect(statusLoads).toBe(baselineLoads + 1)
    expect(active.isStreaming.value).toBe(true)
    useParallelSessions().clearSession(selected.id)
  })

  it('ignores current-session message content from the auxiliary event stream', async () => {
    const selected = session('session-deduplicate')
    api.getMessages = async () => []

    active = useSession()
    await active.selectSession(selected)
    active.subscribeToEvents()
    FakeEventSource.latest.emit({
      type: 'message.created',
      properties: {
        message: message('raw-message', selected.id),
      },
    })

    expect(active.messages.value).toEqual([])
    useParallelSessions().clearSession(selected.id)
  })

  it('removes a pending permission when the runtime cancels it', async () => {
    const selected = session('session-permission-cancelled')
    api.getMessages = async () => []

    active = useSession()
    await active.selectSession(selected)
    const runtimeSource = FakeEventSource.latest
    runtimeSource.emit({
      version: '1',
      id: 'event-permission-requested',
      sessionId: selected.id,
      createdAt: Date.now(),
      type: 'runtime.interaction.requested',
      data: {
        kind: 'permission',
        requestId: 'permission-cancelled',
        permission: 'sandbox',
        patterns: ['*'],
      },
    })
    expect(active.pendingPermissions.value.map((item) => item.id)).toEqual(['permission-cancelled'])

    runtimeSource.emit({
      version: '1',
      id: 'event-permission-cancelled',
      sessionId: selected.id,
      createdAt: Date.now(),
      type: 'runtime.interaction.cancelled',
      data: {
        kind: 'permission',
        requestId: 'permission-cancelled',
        reason: 'aborted',
      },
    })

    expect(active.pendingPermissions.value).toEqual([])
    useParallelSessions().clearSession(selected.id)
  })

  it('shows one persistent page notification when both event streams report the same session error', async () => {
    const selected = {
      ...session('session-error'),
      title: '接口排查会话',
    }
    api.getMessages = async () => []

    active = useSession()
    await active.selectSession(selected)
    const runtimeSource = FakeEventSource.latest
    active.subscribeToEvents()
    const directorySource = FakeEventSource.latest

    let autoDismissScheduled = false
    const nativeSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 5000) autoDismissScheduled = true
      return nativeSetTimeout(handler, timeout, ...args)
    }) as typeof setTimeout

    try {
      runtimeSource.emit({
        version: '1',
        id: 'event-runtime-error',
        sessionId: selected.id,
        createdAt: Date.now(),
        type: 'runtime.turn.failed',
        data: { error: { message: 'provider unavailable\nrequest id: req_123' } },
      })
      directorySource.emit({
        type: 'session.error',
        properties: {
          sessionID: selected.id,
          error: {
            sessionID: selected.id,
            message: 'provider unavailable\nrequest id: req_123',
          },
        },
      })
    } finally {
      globalThis.setTimeout = nativeSetTimeout
    }

    expect(active.sessionNotifications.value).toEqual([
      expect.objectContaining({
        sessionId: selected.id,
        sessionTitle: selected.title,
        message: 'provider unavailable\nrequest id: req_123',
        type: 'error',
      }),
    ])
    expect(autoDismissScheduled).toBe(false)

    active.dismissNotification(active.sessionNotifications.value[0].id)
    expect(active.sessionNotifications.value).toEqual([])
    useParallelSessions().clearSession(selected.id)
  })

  it('labels background session errors without borrowing the current session title', async () => {
    const selected = {
      ...session('session-current'),
      title: '当前会话',
    }
    api.getMessages = async () => []

    active = useSession()
    await active.selectSession(selected)
    active.subscribeToEvents()
    FakeEventSource.latest.emit({
      type: 'session.error',
      properties: {
        sessionID: 'session-background',
        error: {
          sessionID: 'session-background',
          message: 'background failed',
        },
      },
    })

    expect(active.sessionNotifications.value).toEqual([
      expect.objectContaining({
        sessionId: 'session-background',
        sessionTitle: 'session-background',
        message: 'background failed',
        type: 'error',
      }),
    ])
    useParallelSessions().clearSession(selected.id)
  })

  it('reconciles a lost message response instead of assuming the backend stopped', async () => {
    const selected = session('session-response-lost')
    let backendBusy = false
    api.getMessages = async () => []
    api.getSessionStatus = async () => backendBusy
      ? { [selected.id]: { type: 'busy' } }
      : {}
    api.sendMessage = async () => {
      backendBusy = true
      throw new Error('Network response lost')
    }

    active = useSession()
    await active.selectSession(selected)
    const nativeConsoleError = console.error
    console.error = () => {}
    try {
      await active.sendMessage('hello')
    } finally {
      console.error = nativeConsoleError
    }

    expect(active.isStreaming.value).toBe(true)
    useParallelSessions().clearSession(selected.id)
  })
})
