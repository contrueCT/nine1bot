export function createSessionEventReconciler<Event>(applyEvent: (event: Event) => void) {
  let nextGeneration = 0
  let current:
    | {
        id: number
        sessionID: string
        buffering: boolean
        events: Event[]
      }
    | undefined

  function begin(sessionID: string) {
    current = {
      id: ++nextGeneration,
      sessionID,
      buffering: true,
      events: [],
    }
    return current.id
  }

  function isCurrent(generation: number) {
    return current?.id === generation
  }

  function replay(generation: number) {
    if (!isCurrent(generation) || !current) return false
    const events = current.events.splice(0)
    events.forEach(applyEvent)
    return true
  }

  function buffer(generation: number, event: Event) {
    if (!isCurrent(generation) || !current) return false
    if (current.buffering) {
      current.events.push(event)
      return true
    }
    applyEvent(event)
    return false
  }

  function applySnapshot(generation: number, apply: () => void) {
    if (!isCurrent(generation)) return false
    apply()
    return replay(generation)
  }

  function finish(generation: number) {
    if (!isCurrent(generation) || !current) return false
    replay(generation)
    current.buffering = false
    return true
  }

  return {
    begin,
    buffer,
    applySnapshot,
    finish,
    isCurrent,
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
) {
  const failures: string[] = []
  let messagesError: string | undefined
  const optional = async <T>(label: string, load: () => Promise<T>): Promise<T | null> => {
    try { return await load() } catch { failures.push(label); return null }
  }
  const [messages, statuses, questions, permissions] = await Promise.all([
    dependencies.getMessages(sessionID).then(messages => {
      dependencies.onMessages?.(messages)
      return messages
    }).catch((error: unknown) => {
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
