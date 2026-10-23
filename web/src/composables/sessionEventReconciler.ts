export const MAX_RECOVERY_BUFFER_EVENTS = 1024
export const MAX_RECOVERY_BUFFER_BYTES = 2 * 1024 * 1024

export function createSessionEventReconciler<Event>(applyEvent: (event: Event) => void, options: {
  maxEvents?: number
  maxBytes?: number
  onOverflow?(generation: number): void
} = {}) {
  let nextGeneration = 0
  let current:
    | {
        id: number
        sessionID: string
        buffering: boolean
        events: Event[]
        bytes: number
        overflowed: boolean
      }
    | undefined

  function begin(sessionID: string) {
    current = {
      id: ++nextGeneration,
      sessionID,
      buffering: true,
      events: [],
      bytes: 0,
      overflowed: false,
    }
    return current.id
  }

  function isCurrent(generation: number) {
    return current?.id === generation
  }

  function replay(generation: number) {
    if (!isCurrent(generation) || !current || current.overflowed) return false
    const events = current.events.splice(0)
    current.bytes = 0
    for (const event of events) {
      if (!isCurrent(generation)) return false
      applyEvent(event)
    }
    return isCurrent(generation)
  }

  function buffer(generation: number, event: Event) {
    if (!isCurrent(generation) || !current) return false
    if (current.buffering) {
      if (current.overflowed) return true
      const bytes = (JSON.stringify(event)?.length ?? 0) * 2
      if (current.events.length >= (options.maxEvents ?? MAX_RECOVERY_BUFFER_EVENTS)
        || current.bytes + bytes > (options.maxBytes ?? MAX_RECOVERY_BUFFER_BYTES)) {
        current.events = []
        current.bytes = 0
        current.overflowed = true
        options.onOverflow?.(generation)
        return true
      }
      current.events.push(event)
      current.bytes += bytes
      return true
    }
    applyEvent(event)
    return false
  }

  function applySnapshot(generation: number, apply: () => void) {
    if (!isCurrent(generation) || current?.overflowed) return false
    apply()
    return replay(generation)
  }

  function finish(generation: number) {
    if (!isCurrent(generation) || !current || current.overflowed) return false
    if (!replay(generation) || !isCurrent(generation) || !current) return false
    current.buffering = false
    return true
  }

  return {
    begin,
    buffer,
    applySnapshot,
    finish,
    isCurrent,
    needsResync(generation: number) {
      return isCurrent(generation) && Boolean(current?.overflowed)
    },
    clear() {
      current = undefined
    },
    sessionID() {
      return current?.sessionID
    },
  }
}

export interface SessionRecoveryDependencies<
  Message,
  Status extends { type: string },
  Question extends { sessionID: string },
  Permission extends { sessionID: string },
> {
  getMessages(sessionID: string): Promise<Message[]>
  getStatuses(): Promise<Record<string, Status>>
  getQuestions(): Promise<Question[]>
  getPermissions(): Promise<Permission[]>
  onMessages?(messages: Message[]): void
}

export async function loadSessionRecoverySnapshot<
  Message,
  Status extends { type: string },
  Question extends { sessionID: string },
  Permission extends { sessionID: string },
>(
  sessionID: string,
  dependencies: SessionRecoveryDependencies<Message, Status, Question, Permission>,
  signal?: AbortSignal,
) {
  const failures: string[] = []
  let messagesError: string | undefined
  const cancellable = async <T>(load: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    if (!signal) return load()
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try { return await Promise.race([load(), aborted]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }
  const optional = async <T>(label: string, load: () => Promise<T>): Promise<T | null> => {
    try { return await cancellable(load) } catch {
      signal?.throwIfAborted()
      failures.push(label)
      return null
    }
  }
  const [messages, statuses, questions, permissions] = await Promise.all([
    cancellable(() => dependencies.getMessages(sessionID)).then(messages => {
      signal?.throwIfAborted()
      dependencies.onMessages?.(messages)
      return messages
    }).catch((error: unknown) => {
      signal?.throwIfAborted()
      failures.push('历史消息')
      messagesError = error instanceof Error ? error.message : '历史消息加载失败，请重试'
      return null
    }),
    optional('运行状态', dependencies.getStatuses),
    optional('待回答问题', dependencies.getQuestions),
    optional('权限请求', dependencies.getPermissions),
  ])

  return {
    messages,
    ...(messagesError ? { messagesError } : {}),
    status: statuses ? statuses[sessionID] ?? { type: 'idle' as const } : null,
    questions: questions?.filter((question) => question.sessionID === sessionID) ?? null,
    permissions: permissions?.filter((permission) => permission.sessionID === sessionID) ?? null,
    ...(failures.length ? { failures } : {}),
  }
}
