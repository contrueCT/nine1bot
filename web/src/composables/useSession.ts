import { ref, computed } from 'vue'
import { createInteractionResponder } from './interaction-state'
import {
  api,
  createRequestID,
  createMessageSubmission,
  type MessageAttempt,
  type ContextEnrichmentSummary,
  type EventStreamSubscription,
  type Message,
  type MessagePart,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type SessionStatus,
  type SSEEvent,
  type TodoItem,
  permissionApi,
  questionApi,
  SessionBusyError,
  setApiDirectory,
} from '../api/client'
import { collectActivePageContext } from '../api/page-context'
import { useParallelSessions, MAX_PARALLEL_AGENTS } from './useParallelSessions'
import {
  createSessionEventReconciler,
  loadSessionRecoverySnapshot,
} from './sessionEventReconciler'
import { createFrameDeltaBuffer } from './streaming-render-buffer'
import { moveComposerDraft, clearComposerDrafts } from './composer-drafts'

export type SessionNotification = {
  id: string
  sessionId: string
  sessionTitle: string
  message: string
  type: 'success' | 'info' | 'error'
}

export function useSession() {
  const sessions = ref<Session[]>([])
  const sessionsLoading = ref(false)
  const sessionsLoadError = ref(false)
  const currentSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const isLoading = ref(false)
  const historyError = ref<string | null>(null)
  const connectionState = ref<'connecting' | 'connected' | 'reconnecting' | 'offline'>('connecting')
  const currentDirectory = ref('')
  const composerKey = ref(`draft-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  // 是否处于草稿模式（新建会话但未发送消息）
  const isDraftSession = ref(false)

  // Use parallel sessions for streaming state tracking
  const {
    isSessionRunning,
    setSessionRunning,
    canStartNewAgent,
    handleGlobalSSEEvent,
    syncSessionStatus,
    runningCount,
    clearSession
  } = useParallelSessions()

  type LocalSend = { key: string; sessionID?: string; cancelled: boolean; posted: boolean; onCancel?: () => void }
  const localSends = ref<LocalSend[]>([])
  const ownsCurrentView = (send: LocalSend) => send.sessionID
    ? send.sessionID === currentSession.value?.id
    : send.key === composerKey.value

  // Preflight is stoppable too, including draft creation and context collection.
  const isStreaming = computed(() => {
    return localSends.value.some(send => !send.cancelled && ownsCurrentView(send))
      || Boolean(currentSession.value && isSessionRunning(currentSession.value.id))
  })

  // 当前正在流式接收的消息
  const streamingMessage = ref<Message | null>(null)

  // 待处理的问题和权限请求
  const pendingQuestions = ref<QuestionRequest[]>([])
  const pendingPermissions = ref<PermissionRequest[]>([])
  const { states: interactionStates, respond: respondToInteraction } = createInteractionResponder()

  // 会话错误（如模型不可用）
  const sessionError = ref<{ message: string; dismissable?: boolean } | null>(null)

  // 重试状态（后端正在指数退避重试时显示）
  const retryInfo = ref<{ attempt: number; message: string; next: number } | null>(null)

  // 页面级会话通知
  const sessionNotifications = ref<SessionNotification[]>([])

  // 待办事项
  const todoItems = ref<TodoItem[]>([])
  const summarizingSessions = ref(new Set<string>())
  const isSummarizing = computed(() => Boolean(currentSession.value && summarizingSessions.value.has(currentSession.value.id)))

  // 事件源订阅
  let eventSource: EventStreamSubscription | null = null
  let sessionEventSource: EventStreamSubscription | null = null
  let sessionEventAlive = false
  let subscribedRuntimeSessionId: string | null = null
  let sessionEventGeneration = 0
  let sessionEventSubscriptionVersion = 0
  let selectionVersion = 0
  let directoryVersion = 0
  let todoVersion = 0
  // Capture view ownership before awaiting work, including same-session reselection.
  function viewOwner() {
    const version = selectionVersion
    const sessionID = currentSession.value?.id
    return () => version === selectionVersion && sessionID === currentSession.value?.id
  }
  function cancelLocalSend(send: LocalSend) {
    if (send.cancelled) return
    send.cancelled = true
    send.onCancel?.()
  }
  function cancelPreflight() {
    for (const send of localSends.value) if (!send.posted) cancelLocalSend(send)
  }
  const pendingCreations = new Map<string, Promise<Session>>()
  let sessionsLoadVersion = 0
  const sessionEventReconciler = createSessionEventReconciler<SSEEvent>(dispatchSessionEvent)
  const messagePositions = new Map<string, number>()
  const partPositions = new Map<string, number>()
  const frameDeltaBuffer = createFrameDeltaBuffer({
    apply({ messageID, partID, field, delta }) {
      let messageIndex = messagePositions.get(messageID)
      if (messageIndex === undefined || messages.value[messageIndex]?.info.id !== messageID) {
        messageIndex = messages.value.findIndex(message => message.info.id === messageID)
        if (messageIndex >= 0) messagePositions.set(messageID, messageIndex)
      }
      if (messageIndex === -1) return
      const message = messages.value[messageIndex]
      const partKey = `${messageID}\u0000${partID}`
      let partIndex = partPositions.get(partKey)
      if (partIndex === undefined || message.parts[partIndex]?.id !== partID) {
        partIndex = message.parts.findIndex(part => part.id === partID)
        if (partIndex >= 0) partPositions.set(partKey, partIndex)
      }
      if (partIndex === -1) return
      const part = message.parts[partIndex]
      if (field !== 'text') return
      part.text = (part.text ?? '') + delta
    },
  })

  function reconnectEventsForDirectory() {
    if (eventSource) {
      subscribeToEvents()
    }
  }

  // 通知定时器追踪（用于清理）
  const notificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  function pushSessionNotification(input: {
    sessionId: string
    message: string
    type?: SessionNotification['type']
    ttlMs?: number | null
  }) {
    const type = input.type ?? 'info'
    const duplicate = sessionNotifications.value.find(notification =>
      notification.sessionId === input.sessionId &&
      notification.type === type &&
      notification.message === input.message
    )
    if (duplicate) return duplicate.id

    const session = sessions.value.find(s => s.id === input.sessionId)
      ?? (currentSession.value?.id === input.sessionId ? currentSession.value : null)
    const notificationId = `${input.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    sessionNotifications.value.push({
      id: notificationId,
      sessionId: input.sessionId,
      sessionTitle: session?.title || input.sessionId,
      message: input.message,
      type
    })

    // 错误默认保留到用户手动关闭，其他通知保持原有自动关闭行为。
    if (input.ttlMs === null || (type === 'error' && input.ttlMs === undefined)) {
      return notificationId
    }

    const timerId = setTimeout(() => {
      sessionNotifications.value = sessionNotifications.value.filter(n => n.id !== notificationId)
      notificationTimers.delete(notificationId)
    }, input.ttlMs ?? 5000)
    notificationTimers.set(notificationId, timerId)
    return notificationId
  }

  function notifySessionFailure(event: SSEEvent) {
    const sessionId = extractSessionID(event)
    if (!sessionId) return

    if (event.type === 'session.error') {
      const error = event.properties?.error
      pushSessionNotification({
        sessionId,
        message: error?.data?.message || error?.message || event.properties?.message || '发生未知错误',
        type: 'error',
      })
      return
    }

    if (event.type === 'runtime.resource.failed') {
      pushSessionNotification({
        sessionId,
        message: event.properties?.message || '资源不可用，请检查当前配置',
        type: 'error',
      })
    }
  }

  function showContextEnrichmentNotice(sessionId: string, summary?: ContextEnrichmentSummary) {
    if (!summary || summary.platform !== 'feishu') return
    if (summary.status === 'not_applicable') return
    pushSessionNotification({
      sessionId,
      message: contextEnrichmentMessage(summary),
      type: summary.status === 'loaded' ? 'success' : 'info',
      ttlMs: summary.status === 'loaded' ? 3500 : 6000
    })
  }

  function contextEnrichmentMessage(summary: ContextEnrichmentSummary) {
    if (summary.status === 'loaded') return 'Feishu metadata loaded'
    if (summary.status === 'visible_only') return 'Feishu visible context only'
    if (summary.status === 'need_login') return 'Feishu metadata needs lark-cli login'
    if (summary.status === 'need_config') return 'Feishu metadata needs lark-cli config'
    if (summary.status === 'permission_denied') return 'Feishu metadata permission denied'
    if (summary.status === 'timeout') return 'Feishu metadata lookup timed out'
    if (summary.status === 'missing_cli') return 'lark-cli not found; using visible context'
    return summary.message || 'Feishu metadata unavailable'
  }

  // 外部事件处理器
  const externalEventHandlers: ((event: SSEEvent) => void)[] = []

  function registerEventHandler(handler: (event: SSEEvent) => void) {
    externalEventHandlers.push(handler)
    return () => {
      const index = externalEventHandlers.indexOf(handler)
      if (index > -1) {
        externalEventHandlers.splice(index, 1)
      }
    }
  }

  async function loadSessions(directory?: string): Promise<boolean> {
    const requestVersion = ++sessionsLoadVersion
    sessionsLoading.value = true
    try {
      const loaded = await api.getSessions(directory)
      if (requestVersion !== sessionsLoadVersion) return false
      sessions.value = loaded
      sessionsLoadError.value = false
      return true
    } catch (error) {
      if (requestVersion === sessionsLoadVersion) {
        sessionsLoadError.value = true
        console.error('Failed to load sessions:', error)
      }
      return false
    } finally {
      if (requestVersion === sessionsLoadVersion) sessionsLoading.value = false
    }
  }

  function invalidateSessionsLoad() {
    sessionsLoadVersion++
    sessionsLoading.value = false
    sessionsLoadError.value = false
  }

  /**
   * 创建新会话（草稿模式）
   * 不会立即调用后端 API，只有发送消息时才真正创建
   */
  function createSession(directory: string) {
    if (isDraftSession.value && currentDirectory.value === (directory || '.') && !currentSession.value) return
    // 使任何在途的选择/创建请求失效，防止其返回后抢占新草稿
    cancelPreflight()
    selectionVersion++
    composerKey.value = `draft:${directory || '.'}`
    isLoading.value = false
    historyError.value = null
    // 进入草稿模式，清空当前会话状态
    isDraftSession.value = true
    currentSession.value = null
    currentDirectory.value = directory || '.'
    setApiDirectory(currentDirectory.value)
    reconnectEventsForDirectory()
    messages.value = []
    // 重置所有会话级状态，防止旧会话的状态残留
    streamingMessage.value = null
    pendingQuestions.value = []
    pendingPermissions.value = []
    sessionError.value = null
    retryInfo.value = null
    todoItems.value = []
    seenUserMessageIds.clear()
    unsubscribeSessionRuntimeEvents()
  }

  /**
   * 更改当前会话的工作目录
   * 只能在草稿模式或会话没有消息时更改
   */
  async function changeDirectory(directory: string) {
    // 如果是草稿模式，直接更新本地状态
    if (isDraftSession.value) {
      composerKey.value = `draft:${directory}`
      currentDirectory.value = directory
      setApiDirectory(currentDirectory.value)
      reconnectEventsForDirectory()
      return
    }

    // Keep the request's owner even if a different session/directory is selected meanwhile.
    if (currentSession.value && messages.value.length === 0) {
      const sessionID = currentSession.value.id
      const isOwner = viewOwner()
      const version = ++directoryVersion
      try {
        const updated = await api.updateSession(sessionID, { directory })
        if (!isOwner() || version !== directoryVersion) return
        currentSession.value = updated
        currentDirectory.value = updated.directory
        setApiDirectory(currentDirectory.value)
        reconnectEventsForDirectory()
        const index = sessions.value.findIndex(s => s.id === updated.id)
        if (index !== -1) sessions.value[index] = updated
        unsubscribeSessionRuntimeEvents()
        await openSessionEventStreamAndReconcile(updated.id)
      } catch (error) {
        if (isOwner() && version === directoryVersion) {
          console.error('Failed to change directory:', error)
          pushSessionNotification({ sessionId: sessionID, message: error instanceof Error ? error.message : '修改目录失败', type: 'error' })
          throw error
        }
      }
    } else if (messages.value.length > 0) {
      throw new Error('无法修改已有消息的会话工作目录')
    }
  }

  /**
   * 检查当前会话是否可以更改工作目录
   */
  function canChangeDirectory(): boolean {
    return isDraftSession.value || (currentSession.value !== null && messages.value.length === 0)
  }

  function applyRecoveryStatus(sessionID: string, status: SessionStatus) {
    const running = status.type === 'busy' || status.type === 'retry'
    setSessionRunning(sessionID, running)
    if (currentSession.value?.id !== sessionID) return
    retryInfo.value = status.type === 'retry'
      ? {
          attempt: status.attempt,
          message: status.message,
          next: status.next,
        }
      : null
  }

  async function reconcileSession(sessionID: string, generation: number) {
    try {
      const snapshot = await loadSessionRecoverySnapshot(sessionID, {
        getMessages: api.getMessages,
        getStatuses: api.getSessionStatus,
        getQuestions: questionApi.list,
        getPermissions: permissionApi.list,
        onMessages(loaded) {
          if (!sessionEventReconciler.isCurrent(generation) || currentSession.value?.id !== sessionID) return
          messages.value = loaded
          isLoading.value = false
          historyError.value = null
        },
      })

      if (
        !sessionEventReconciler.isCurrent(generation) ||
        currentSession.value?.id !== sessionID
      ) {
        return false
      }

      const applied = sessionEventReconciler.applySnapshot(generation, () => {
        // A failed history endpoint must not discard an independently known idle
        // status or erase displayed messages. Buffered SSE still follows the snapshot.
        if (snapshot.messages) {
          frameDeltaBuffer.clear()
          messages.value = snapshot.messages
          seenUserMessageIds.clear()
          for (const message of snapshot.messages) {
            if (message.info.role === 'user') seenUserMessageIds.add(message.info.id)
          }
        }
        if (snapshot.questions) pendingQuestions.value = snapshot.questions
        if (snapshot.permissions) pendingPermissions.value = snapshot.permissions
        if (snapshot.status) applyRecoveryStatus(sessionID, snapshot.status)
        historyError.value = snapshot.messagesError ?? (snapshot.failures?.length
          ? `${snapshot.failures.join('、')}加载失败，消息已显示，请重试同步。`
          : null)
      })
      return applied && !snapshot.failures?.length
    } catch (error) {
      if (
        sessionEventReconciler.isCurrent(generation) &&
        currentSession.value?.id === sessionID
      ) {
        console.error('Failed to reconcile session state:', error)
        historyError.value = error instanceof Error ? error.message : '历史消息加载失败，请重试'
      }
      return false
    } finally {
      sessionEventReconciler.finish(generation)
    }
  }

  async function openSessionEventStreamAndReconcile(sessionID: string) {
    connectionState.value = 'connecting'
    const generation = sessionEventReconciler.begin(sessionID)
    sessionEventGeneration = generation
    const subscription = subscribeToSessionRuntimeEvents(sessionID, generation)
    try {
      await subscription.ready
      if (sessionEventReconciler.isCurrent(generation) && currentSession.value?.id === sessionID && sessionEventAlive) connectionState.value = 'connected'
    } catch (error) {
      sessionEventReconciler.finish(generation)
      if (sessionEventReconciler.isCurrent(generation) && currentSession.value?.id === sessionID) connectionState.value = 'offline'
      if (sessionEventSource === subscription) {
        unsubscribeSessionRuntimeEvents()
      } else {
        subscription.close()
      }
      throw error
    }
    await reconcileSession(sessionID, generation)
    return subscription
  }

  async function reconcileCurrentSessionState(sessionID: string) {
    if (currentSession.value?.id !== sessionID) return false
    const generation = sessionEventReconciler.begin(sessionID)
    sessionEventGeneration = generation
    return reconcileSession(sessionID, generation)
  }

  /**
   * 实际创建会话（内部方法，发送消息时调用）
   */
  async function _createSessionInternal(
    directory: string,
    pageContext?: Awaited<ReturnType<typeof collectActivePageContext>>
  ): Promise<Session> {
    const requestVersion = ++selectionVersion
    const draftKey = composerKey.value
    try {
      isLoading.value = true
      setApiDirectory(directory)
      reconnectEventsForDirectory()
      const session = await api.createSession(directory, pageContext)
      moveComposerDraft(draftKey, session.id)
      // 创建请求在途期间用户可能已选择其他会话：新会话照常加入列表，
      // 但不抢占 currentSession、不订阅其事件流
      const ownsDraft = !currentSession.value && isDraftSession.value && composerKey.value === draftKey
      if (requestVersion !== selectionVersion && !ownsDraft) {
        await loadSessions()
        return session
      }
      for (const send of localSends.value) if (send.key === draftKey) send.sessionID = session.id
      currentSession.value = session
      composerKey.value = session.id
      isDraftSession.value = false
      // 使用服务器返回的实际目录，而不是传入的参数
      currentDirectory.value = session.directory
      setApiDirectory(currentDirectory.value)
      reconnectEventsForDirectory()
      unsubscribeSessionRuntimeEvents()
      await openSessionEventStreamAndReconcile(session.id)
      // 重新加载所有会话，不过滤目录
      await loadSessions()
      return session
    } catch (error) {
      console.error('Failed to create session:', error)
      throw error
    } finally {
      if (requestVersion === selectionVersion) {
        isLoading.value = false
      }
    }
  }

  async function selectSession(session: Session) {
    cancelPreflight()
    const requestVersion = ++selectionVersion
    try {
      isLoading.value = true
      historyError.value = null
      // 切换到已存在的会话，退出草稿模式
      isDraftSession.value = false
      // 重置所有会话级状态，防止旧会话的状态残留
      streamingMessage.value = null
      pendingQuestions.value = []
      pendingPermissions.value = []
      sessionError.value = null
      retryInfo.value = null
      todoItems.value = []
      seenUserMessageIds.clear()
      currentSession.value = session
      composerKey.value = session.id
      currentDirectory.value = session.directory
      setApiDirectory(currentDirectory.value)
      reconnectEventsForDirectory()
      unsubscribeSessionRuntimeEvents()
      messages.value = []  // Clear immediately to avoid flash of old content
      // reconcile 统一由 openSessionEventStreamAndReconcile 在事件流就绪后执行一次
      await openSessionEventStreamAndReconcile(session.id)
    } catch (error) {
      if (requestVersion === selectionVersion) {
        console.error('Failed to load session:', error)
        historyError.value = error instanceof Error ? error.message : '会话加载失败，请重试'
      }
    } finally {
      if (requestVersion === selectionVersion) {
        isLoading.value = false
      }
    }
  }

  // 用于防止用户消息重复
  const seenUserMessageIds = new Set<string>()

  function isSameModel(
    current: { providerID: string; modelID: string } | undefined,
    next: { providerID: string; modelID: string }
  ): boolean {
    return current?.providerID === next.providerID && current?.modelID === next.modelID
  }

  function applyCurrentSessionRuntime(update: {
    currentModel?: { providerID: string; modelID: string; source?: string }
    profileSnapshotId?: string
  }) {
    if (!currentSession.value) return

    const runtime = {
      ...(currentSession.value.runtime || {}),
      ...(update.profileSnapshotId ? { profileSnapshotId: update.profileSnapshotId } : {}),
      ...(update.currentModel ? { currentModel: update.currentModel } : {}),
    }
    const updated = {
      ...currentSession.value,
      runtime,
    }
    currentSession.value = updated

    const index = sessions.value.findIndex(s => s.id === updated.id)
    if (index !== -1) {
      sessions.value[index] = updated
    }
  }

  async function sendMessage(
    content: string,
    model?: { providerID: string; modelID: string },
    files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>,
    attempt: MessageAttempt = { id: createRequestID() },
  ): Promise<boolean> {
    // Lock before the first await, and never reuse a cancelled local operation.
    if (localSends.value.some(send => !send.cancelled && ownsCurrentView(send))) return false
    if (attempt.submission && attempt.submission.sessionID !== currentSession.value?.id) return false
    if (!attempt.modelCaptured) {
      attempt.model = model ? { ...model } : undefined
      attempt.modelCaptured = true
    }
    const originalFiles = files?.map(file => ({ ...file }))
    const send: LocalSend = { key: composerKey.value, sessionID: currentSession.value?.id, cancelled: false, posted: false, onCancel: attempt.onCancel }
    localSends.value.push(send)
    // Vue proxies objects inserted into refs; keep the proxy for reactive cancellation.
    const operation = localSends.value[localSends.value.length - 1]
    let sessionId = operation.sessionID
    let isOwner = viewOwner()
    const isCurrentSend = () => !operation.cancelled && isOwner()
    try {
      const draftPageContext = !attempt.submission && (isDraftSession.value || !currentSession.value)
        ? await collectActivePageContext().catch(() => undefined)
        : undefined
      if (!isCurrentSend()) return false
      const ensuredSession = await ensureSession(draftPageContext)
      if (!ensuredSession || operation.cancelled || currentSession.value?.id !== ensuredSession.id) return false
      sessionId = ensuredSession.id
      operation.sessionID = sessionId
      isOwner = viewOwner()

      if (isSessionRunning(sessionId) && !attempt.submitted) return false
      if (!canStartNewAgent.value && !attempt.submitted) {
        pushSessionNotification({ sessionId, message: `最多支持 ${MAX_PARALLEL_AGENTS} 个并行 agent，请等待其中一个完成`, type: 'error' })
        return false
      }
      const subscription = sessionEventSource && sessionEventAlive && subscribedRuntimeSessionId === sessionId
        ? sessionEventSource
        : await openSessionEventStreamAndReconcile(sessionId)
      await subscription.ready
      if (!isCurrentSend() || !sessionEventAlive) return false
      // Recovery may reveal another client's running turn.
      if (isSessionRunning(sessionId) && !attempt.submitted) return false

      if (!attempt.submission) {
        const pageContext = draftPageContext ?? await collectActivePageContext().catch(() => undefined)
        if (!isCurrentSend()) return false
        attempt.submission = {
          sessionID: sessionId,
          request: createMessageSubmission(content, originalFiles, pageContext, attempt.model ?? currentSession.value?.runtime?.currentModel, attempt.id),
        }
      }
      // Replays must not mutate the session model or collect a different page payload.
      if (!attempt.submitted && attempt.model && !isSameModel(currentSession.value?.runtime?.currentModel, attempt.model)) {
        const modelResult = await api.changeSessionModel(sessionId, attempt.model)
        if (!isCurrentSend()) return false
        applyCurrentSessionRuntime({ currentModel: modelResult.currentModel, profileSnapshotId: modelResult.profileSnapshotId })
      }
      if (!isCurrentSend()) return false
      const replaying = Boolean(attempt.submitted)
      operation.posted = true
      attempt.submitted = true
      setSessionRunning(sessionId, true)
      const sendResult = await api.sendMessage(sessionId, attempt.submission.request)
      // Acceptance is authoritative even if display recovery is partial. Keep
      // historyError/retryHistory visible while independently reconciling idle;
      // restoring history must not require posting an accepted message again.
      if (replaying) await reconcileCurrentSessionState(sessionId)
      if (attempt.notificationId) dismissNotification(attempt.notificationId)
      showContextEnrichmentNotice(sessionId, sendResult.contextEnrichment)
      return true
    } catch (error: any) {
      if (sessionId) {
        await reconcileCurrentSessionState(sessionId)
        // A matching requestID identifies the persisted user message, but is not
        // proof that acceptance/receipt persistence completed. Keep the attempt
        // until the same request receives a positive acknowledgement on replay.
        if (!operation.cancelled) {
          if (attempt.notificationId) dismissNotification(attempt.notificationId)
          attempt.notificationId = pushSessionNotification({
            sessionId,
            message: error instanceof SessionBusyError
              ? '该会话正在被其他客户端使用中，请稍后重试或创建新会话'
              : attempt.submitted ? `发送结果待确认，可安全重试原消息: ${error.message || '网络错误'}` : `发送失败: ${error.message || '未知错误'}`,
            type: 'error',
          })
        }
      }
      return false
    } finally {
      localSends.value = localSends.value.filter(item => item !== operation)
      if (isCurrentSend()) streamingMessage.value = null
    }
  }

  async function ensureSession(
    pageContext?: Awaited<ReturnType<typeof collectActivePageContext>>
  ): Promise<Session | null> {
    if (!isDraftSession.value && currentSession.value) {
      return currentSession.value
    }

    let version = selectionVersion
    const draftKey = composerKey.value
    try {
      const existing = pendingCreations.get(draftKey)
      if (existing) return await existing
      const promise = _createSessionInternal(currentDirectory.value || '.', pageContext)
      version = selectionVersion
      pendingCreations.set(draftKey, promise)
      try { return await promise } finally {
        if (pendingCreations.get(draftKey) === promise) pendingCreations.delete(draftKey)
      }
    } catch (error) {
      console.error('Failed to ensure session:', error)
      if (version !== selectionVersion && composerKey.value !== draftKey) return null
      sessionError.value = {
        message: '创建会话失败，请重试',
        dismissable: true
      }
      return null
    }
  }

  function applySessionTitle(updated: Pick<Session, 'id' | 'title'>) {
    if (!updated || typeof updated.id !== 'string' || typeof updated.title !== 'string') return
    if (currentSession.value?.id === updated.id) currentSession.value.title = updated.title
    const listed = sessions.value.find(session => session.id === updated.id)
    if (listed) listed.title = updated.title
  }

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event

    switch (type) {
      case 'session.updated':
        applySessionTitle(properties?.info)
        break

      case 'message.created':
        // 新消息创建
        if (properties.message) {
          const msg = properties.message as Message
          // 防御性校验：跳过不属于当前会话的消息
          if (msg.info.sessionID && currentSession.value && msg.info.sessionID !== currentSession.value.id) {
            break
          }
          streamingMessage.value = msg
          const msgId = msg.info.id
          const msgRole = msg.info.role

          if (msgRole === 'user') {
            // 使用消息 ID 去重
            if (seenUserMessageIds.has(msgId)) {
              return
            }
            seenUserMessageIds.add(msgId)

            // 检查是否已存在相同 ID 的消息
            const existingIndex = messages.value.findIndex(m => m.info.id === msgId)
            if (existingIndex === -1) {
              messages.value.push(msg)
            }
          } else {
            // assistant 消息
            const existingIndex = messages.value.findIndex(m => m.info.id === msgId)
            if (existingIndex !== -1) {
              // 合并 parts
              const existingParts = messages.value[existingIndex].parts
              messages.value[existingIndex] = {
                ...msg,
                parts: [...existingParts, ...(msg.parts || []).filter(p => !existingParts.find(ep => ep.id === p.id))]
              }
            } else {
              messages.value.push(msg)
            }
          }
        }
        break

      case 'message.updated':
        // 消息更新 - 仅更新已存在的消息
        if (properties.info) {
          const info = properties.info
          // 防御性校验：跳过不属于当前会话的消息
          if (info.sessionID && currentSession.value && info.sessionID !== currentSession.value.id) {
            break
          }
          const index = messages.value.findIndex(m => m.info.id === info.id)
          if (index !== -1) {
            messages.value[index] = {
              ...messages.value[index],
              info: { ...messages.value[index].info, ...info }
            }
          }
          // 注意：不再在 message.updated 中创建新消息，避免重复
        }
        break

      case 'message.part.updated':
        // 部分更新（流式文本、工具调用等）
        if (properties.part) {
          const part = properties.part as MessagePart
          // 防御性校验：跳过不属于当前会话的消息部分
          if (part.sessionID && currentSession.value && part.sessionID !== currentSession.value.id) {
            break
          }
          const messageID = part.messageID
          if (messageID) {
            frameDeltaBuffer.flush(part.id)
            let messageIndex = messages.value.findIndex(m => m.info.id === messageID)

            // 如果消息不存在，创建一个新的 assistant 消息
            if (messageIndex === -1) {
              const newMessage: Message = {
                info: {
                  id: messageID,
                  sessionID: part.sessionID || currentSession.value?.id || '',
                  role: 'assistant',
                  time: { created: Date.now() }
                },
                parts: []
              }
              messages.value.push(newMessage)
              messageIndex = messages.value.length - 1
            }

            const message = messages.value[messageIndex]
            const partIndex = message.parts.findIndex(p => p.id === part.id)
            if (partIndex !== -1) {
              message.parts[partIndex] = part
            } else {
              message.parts.push(part)
            }
            // 触发响应式更新
            messages.value[messageIndex] = { ...message }
          }
        }
        break

      case 'message.part.delta':
        if (
          properties.sessionID &&
          currentSession.value &&
          properties.sessionID !== currentSession.value.id
        ) {
          break
        }
        if (
          properties.messageID &&
          properties.partID &&
          properties.field === 'text' &&
          typeof properties.delta === 'string'
        ) {
          frameDeltaBuffer.push({
            messageID: properties.messageID,
            partID: properties.partID,
            field: properties.field,
            delta: properties.delta,
          })
        }
        break

      case 'message.completed':
        // 消息完成
        break

      case 'message.removed':
        // 消息被完全删除（含级联删除配对的 assistant 消息）
        if (properties?.messageID) {
          const messageID = properties.messageID
          const sessionID = properties.sessionID
          // 防御性校验：跳过不属于当前会话的事件
          if (sessionID && currentSession.value && sessionID !== currentSession.value.id) {
            break
          }
          const index = messages.value.findIndex(m => m.info.id === messageID)
          if (index !== -1) {
            messages.value.splice(index, 1)
          }
        }
        break

      case 'question.asked':
        // 新问题请求
        if (properties) {
          const request = properties as QuestionRequest
          // 只处理当前会话的问题
          if (currentSession.value && request.sessionID === currentSession.value.id) {
            // 避免重复添加
            if (!pendingQuestions.value.find(q => q.id === request.id)) {
              pendingQuestions.value.push(request)
            }
          }
        }
        break

      case 'question.replied':
      case 'question.rejected':
        // 问题已回复或被拒绝，从待处理列表移除
        if (properties?.requestID) {
          pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== properties.requestID)
        }
        break

      case 'permission.asked':
        // 新权限请求
        if (properties) {
          const request = properties as PermissionRequest
          // 只处理当前会话的权限请求
          if (currentSession.value && request.sessionID === currentSession.value.id) {
            // 避免重复添加
            if (!pendingPermissions.value.find(p => p.id === request.id)) {
              pendingPermissions.value.push(request)
            }
          }
        }
        break

      case 'permission.replied':
      case 'permission.cancelled':
        // 权限已回复或取消，从待处理列表移除
        if (properties?.requestID) {
          pendingPermissions.value = pendingPermissions.value.filter(p => p.id !== properties.requestID)
        }
        break

      case 'session.status':
        // 会话状态变更（busy/retry/idle）
        if (properties?.status) {
          const status = properties.status
          // 防御性校验：跳过不属于当前会话的状态事件
          if (status.sessionID && currentSession.value && status.sessionID !== currentSession.value.id) {
            break
          }
          if (status.type === 'retry') {
            retryInfo.value = {
              attempt: status.attempt ?? 1,
              message: status.message ?? '网络错误',
              next: status.next ?? Date.now()
            }
          } else {
            retryInfo.value = null
          }
        }
        break

      case 'session.error':
        // 页面级错误通知由 notifySessionFailure 统一处理。
        if (
          (properties?.sessionID || properties?.error?.sessionID) &&
          currentSession.value &&
          (properties.sessionID || properties.error.sessionID) !== currentSession.value.id
        ) {
          break
        }
        retryInfo.value = null
        break

      case 'runtime.resource.failed':
        // 页面级错误通知由 notifySessionFailure 统一处理。
        break

      case 'session.idle':
        // Note: session running state is handled by handleGlobalSSEEvent
        if (properties?.sessionID && currentSession.value && properties.sessionID !== currentSession.value.id) {
          break
        }
        retryInfo.value = null
        break

      case 'todo.updated':
        // 待办事项更新事件
        if (properties?.sessionID && properties?.todos) {
          // 只处理当前会话的 todo 更新
          if (currentSession.value && properties.sessionID === currentSession.value.id) {
            todoItems.value = properties.todos
          }
        }
        break
    }
  }

  // Abort any session by ID
  async function abortSession(sessionId: string) {
    const local = localSends.value.filter(send => send.sessionID === sessionId)
    for (const send of local) cancelLocalSend(send)
    if (local.length && local.every(send => !send.posted) && !isSessionRunning(sessionId)) return
    try {
      await api.abortSession(sessionId)
    } catch (error) {
      console.error('Failed to abort session:', error)
    }

    if (currentSession.value?.id === sessionId) {
      await reconcileCurrentSessionState(sessionId)
      return
    }

    try {
      const statuses = await api.getSessionStatus()
      applyRecoveryStatus(sessionId, statuses[sessionId] ?? { type: 'idle' })
    } catch (error) {
      console.error('Failed to reconcile aborted session status:', error)
    }
  }

  async function abortCurrentSession() {
    for (const send of localSends.value) if (ownsCurrentView(send)) cancelLocalSend(send)
    if (currentSession.value) {
      await abortSession(currentSession.value.id)
    }
  }

  function extractSessionID(event: SSEEvent) {
    return event.properties?.sessionID
      || event.properties?.message?.info?.sessionID
      || event.properties?.part?.sessionID
      || event.properties?.info?.sessionID
      || event.properties?.status?.sessionID
      || event.properties?.error?.sessionID
  }

  function isSessionContentEvent(event: SSEEvent) {
    return event.type === 'message.created'
      || event.type === 'message.updated'
      || event.type === 'message.completed'
      || event.type === 'message.removed'
      || event.type === 'message.part.updated'
      || event.type === 'message.part.delta'
      || event.type === 'message.part.removed'
  }

  function dispatchExternalEvent(event: SSEEvent) {
    for (const handler of externalEventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('External event handler error:', error)
      }
    }
  }

  function dispatchSessionEvent(event: SSEEvent) {
    handleGlobalSSEEvent(event)
    notifySessionFailure(event)
    dispatchExternalEvent(event)
    handleSSEEvent(event)
  }

  // 订阅全局事件流
  function subscribeToEvents() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }

    eventSource = api.subscribeEvents((event: SSEEvent) => {
      // Metadata must also update background conversations and the list while composing a draft.
      if (event.type === 'session.updated') applySessionTitle(event.properties?.info)
      // ALWAYS process for parallel session tracking (status events for ALL sessions)
      handleGlobalSSEEvent(event)

      // Extract sessionID from all possible locations
      const sessionID = extractSessionID(event)
      notifySessionFailure(event)

      // Dedicated per-session SSE is authoritative for current message content.
      if (
        currentSession.value &&
        sessionID === currentSession.value.id &&
        isSessionContentEvent(event)
      ) {
        return
      }

      // 调用外部事件处理器（如 agent terminal）
      dispatchExternalEvent(event)

      // 草稿模式下没有当前会话，跳过所有会话级事件，防止其他会话的消息泄漏
      if (!currentSession.value) {
        return
      }

      // Handle notifications for other sessions
      if (sessionID && sessionID !== currentSession.value.id) {
        // Show friendly notification when other session completes
        if (event.type === 'session.idle' || (event.type === 'session.status' && event.properties?.status?.type === 'idle')) {
          pushSessionNotification({
            sessionId: sessionID,
            message: '任务已完成',
            type: 'success',
          })
        }
        return
      }

      // 在流式响应期间，跳过用户消息事件（由 POST 响应处理）
      if (isStreaming.value && event.type === 'message.created') {
        const msg = event.properties?.message
        if (msg?.info?.role === 'user') {
          return
        }
      }

      handleSSEEvent(event)
    })
  }

  function subscribeToSessionRuntimeEvents(sessionId: string, generation: number) {
    if (sessionEventSource && sessionEventAlive && subscribedRuntimeSessionId === sessionId) {
      return sessionEventSource
    }

    unsubscribeSessionRuntimeEvents()
    const subscriptionVersion = ++sessionEventSubscriptionVersion
    subscribedRuntimeSessionId = sessionId
    sessionEventGeneration = generation
    sessionEventAlive = true
    sessionEventSource = api.subscribeSessionRuntimeEvents(
      sessionId,
      (event: SSEEvent) => {
        if (subscriptionVersion !== sessionEventSubscriptionVersion) return
        sessionEventReconciler.buffer(sessionEventGeneration, event)
      },
      {
        onDisconnect() {
          if (subscriptionVersion === sessionEventSubscriptionVersion) connectionState.value = 'reconnecting'
        },
        onReconnect() {
          if (
            subscriptionVersion !== sessionEventSubscriptionVersion ||
            currentSession.value?.id !== sessionId
          ) {
            return
          }
          const reconnectGeneration = sessionEventReconciler.begin(sessionId)
          connectionState.value = 'connected'
          sessionEventGeneration = reconnectGeneration
          void reconcileSession(sessionId, reconnectGeneration)
        },
        onGiveUp() {
          if (subscriptionVersion !== sessionEventSubscriptionVersion) return
          sessionEventAlive = false
          sessionEventSubscriptionVersion++
          sessionEventSource?.close()
          sessionEventReconciler.finish(sessionEventGeneration)
          connectionState.value = 'offline'
          // 重连彻底失败：复位 running 状态，避免 runningCount 泄漏锁死新 agent
          setSessionRunning(sessionId, false)
          if (currentSession.value?.id === sessionId) {
            pushSessionNotification({
              sessionId,
              message: '连接已断开，请刷新或重新发送',
              type: 'error',
            })
          }
        },
      },
    )
    return sessionEventSource
  }

  function unsubscribeSessionRuntimeEvents() {
    sessionEventAlive = false
    messagePositions.clear()
    partPositions.clear()
    sessionEventSubscriptionVersion++
    frameDeltaBuffer.clear()
    if (sessionEventSource) {
      sessionEventSource.close()
      sessionEventSource = null
    }
    subscribedRuntimeSessionId = null
  }

  // 取消订阅
  function unsubscribe() {
    cancelPreflight()
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    unsubscribeSessionRuntimeEvents()
    // 清理所有通知定时器
    for (const timerId of notificationTimers.values()) {
      clearTimeout(timerId)
    }
    notificationTimers.clear()
  }

  async function retryHistory() {
    const session = currentSession.value
    if (!session) return false
    const version = selectionVersion
    isLoading.value = messages.value.length === 0
    try {
      await openSessionEventStreamAndReconcile(session.id)
      return version === selectionVersion && sessionEventAlive && connectionState.value === 'connected' && !historyError.value
    } catch (error) {
      if (version === selectionVersion) historyError.value = error instanceof Error ? error.message : '重新连接失败'
      return false
    } finally {
      if (version === selectionVersion) isLoading.value = false
    }
  }

  // 加载待处理的问题和权限请求
  async function loadPendingRequests() {
    const version = selectionVersion
    try {
      const [questions, permissions] = await Promise.all([
        questionApi.list(),
        permissionApi.list()
      ])
      if (version !== selectionVersion) return
      // 只保留当前会话的请求
      if (currentSession.value) {
        pendingQuestions.value = questions.filter(q => q.sessionID === currentSession.value!.id)
        pendingPermissions.value = permissions.filter(p => p.sessionID === currentSession.value!.id)
      } else {
        pendingQuestions.value = questions
        pendingPermissions.value = permissions
      }
    } catch (error) {
      console.error('Failed to load pending requests:', error)
    }
  }

  // Requests are submitted once by the parent. Cards retain their input until success.
  function answerQuestion(requestId: string, answers: string[][]) {
    const snapshot = answers.map(answer => [...answer])
    return respondToInteraction(requestId, 'answer', () => questionApi.reply(requestId, snapshot), () => {
      pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== requestId)
    })
  }

  function rejectQuestion(requestId: string) {
    return respondToInteraction(requestId, 'reject', () => questionApi.reject(requestId), () => {
      pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== requestId)
    })
  }

  function respondPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string) {
    return respondToInteraction(requestId, reply, () => permissionApi.reply(requestId, reply, message), () => {
      pendingPermissions.value = pendingPermissions.value.filter(p => p.id !== requestId)
    })
  }

  // 清除会话错误
  function clearSessionError() {
    sessionError.value = null
  }

  // 删除会话
  async function deleteSession(sessionId: string) {
    try {
      await api.deleteSession(sessionId)
      clearComposerDrafts(sessionId)
      sessions.value = sessions.value.filter(s => s.id !== sessionId)
      // Clean up running state tracking
      clearSession(sessionId)

      // 如果删除的是当前会话，切换到其他会话
      if (currentSession.value?.id === sessionId) {
        if (sessions.value.length > 0) {
          await selectSession(sessions.value[0])
        } else {
          currentSession.value = null
          messages.value = []
          unsubscribeSessionRuntimeEvents()
        }
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
      pushSessionNotification({ sessionId, message: error instanceof Error ? error.message : '删除会话失败', type: 'error' })
      throw error
    }
  }

  // 重命名会话
  async function renameSession(sessionId: string, title: string) {
    try {
      const updated = await api.updateSession(sessionId, { title })

      // 更新本地状态
      const index = sessions.value.findIndex(s => s.id === sessionId)
      if (index !== -1) {
        sessions.value[index] = updated
      }
      if (currentSession.value?.id === sessionId) {
        currentSession.value = updated
      }
      return updated
    } catch (error) {
      console.error('Failed to rename session:', error)
      throw error
    }
  }

  // 删除消息部分
  async function deleteMessagePart(messageId: string, partId: string) {
    if (!currentSession.value) throw new Error('No active session')
    const sessionId = currentSession.value.id
    const isOwner = viewOwner()

    try {
      await api.deleteMessagePart(sessionId, messageId, partId)

      if (!isOwner()) return
      // Confirmed server update: only remove the part
      const msgIndex = messages.value.findIndex(m => m.info.id === messageId)
      if (msgIndex !== -1) {
        messages.value[msgIndex].parts = messages.value[msgIndex].parts.filter(p => p.id !== partId)
        // 当所有 parts 被移除后，后端会级联删除消息及其配对的 assistant
        // 通过 SSE message.removed 事件自动从本地列表中移除
        if (messages.value[msgIndex].parts.length > 0) {
          // 触发响应式更新
          messages.value[msgIndex] = { ...messages.value[msgIndex] }
        }
      }
    } catch (error) {
      console.error('Failed to delete message part:', error)
      throw error
    }
  }

  // 更新消息部分
  async function updateMessagePart(messageId: string, partId: string, updates: { text?: string }) {
    if (!currentSession.value) throw new Error('No active session')
    const sessionId = currentSession.value.id
    const isOwner = viewOwner()

    try {
      const updatedPart = await api.updateMessagePart(sessionId, messageId, partId, updates)

      if (!isOwner()) return updatedPart
      // 更新本地消息
      const msgIndex = messages.value.findIndex(m => m.info.id === messageId)
      if (msgIndex !== -1) {
        const partIndex = messages.value[msgIndex].parts.findIndex(p => p.id === partId)
        if (partIndex !== -1) {
          messages.value[msgIndex].parts[partIndex] = updatedPart
          // 触发响应式更新
          messages.value[msgIndex] = { ...messages.value[msgIndex] }
        }
      }
      return updatedPart
    } catch (error) {
      console.error('Failed to update message part:', error)
      throw error
    }
  }

  // 压缩会话
  async function summarizeSession() {
    if (!currentSession.value || isSummarizing.value) return

    // 从最近的 assistant 消息中获取模型信息
    const lastAssistantMsg = [...messages.value].reverse().find(m => m.info.role === 'assistant')
    const model = lastAssistantMsg?.info.model ||
      (lastAssistantMsg?.info.providerID && lastAssistantMsg?.info.modelID
        ? { providerID: lastAssistantMsg.info.providerID, modelID: lastAssistantMsg.info.modelID }
        : null)

    if (!model) {
      sessionError.value = {
        message: '无法获取模型信息，请先发送一条消息',
        dismissable: true
      }
      return
    }

    const sessionID = currentSession.value.id
    const isOwner = viewOwner()
    summarizingSessions.value.add(sessionID)
    try {
      await api.summarizeSession(sessionID, model)
      if (!isOwner()) return
      // Use the same generation-guarded snapshot path as reconnects.
      await reconcileCurrentSessionState(sessionID)
    } catch (error) {
      console.error('Failed to summarize session:', error)
      throw error
    } finally {
      summarizingSessions.value.delete(sessionID)
    }
  }

  // 加载待办事项
  async function loadTodoItems() {
    if (!currentSession.value) return

    const sessionID = currentSession.value.id
    const isOwner = viewOwner()
    const version = ++todoVersion
    try {
      const items = await api.getSessionTodo(sessionID)
      if (isOwner() && version === todoVersion) todoItems.value = items
    } catch (error) {
      if (isOwner() && version === todoVersion) {
        console.error('Failed to load todo items:', error)
        todoItems.value = []
      }
    }
  }

  // 关闭通知
  function dismissNotification(notificationId: string) {
    sessionNotifications.value = sessionNotifications.value.filter(n => n.id !== notificationId)
    // 清理对应的定时器
    const timerId = notificationTimers.get(notificationId)
    if (timerId) {
      clearTimeout(timerId)
      notificationTimers.delete(notificationId)
    }
  }

  return {
    sessions,
    sessionsLoading,
    sessionsLoadError,
    currentSession,
    messages,
    isLoading,
    historyError,
    connectionState,
    retryHistory,
    isStreaming,
    isDraftSession,
    currentDirectory,
    composerKey,
    clearDrafts: clearComposerDrafts,
    streamingMessage,
    pendingQuestions,
    pendingPermissions,
    interactionStates,
    sessionError,
    retryInfo,
    loadSessions,
    invalidateSessionsLoad,
    createSession,
    ensureSession,
    selectSession,
    viewOwner,
    sendMessage,
    abortSession,
    abortCurrentSession,
    subscribeToEvents,
    unsubscribe,
    loadPendingRequests,
    answerQuestion,
    rejectQuestion,
    respondPermission,
    clearSessionError,
    deleteSession,
    renameSession,
    applySessionTitle,
    // 工作目录管理
    changeDirectory,
    canChangeDirectory,
    // 消息管理
    deleteMessagePart,
    updateMessagePart,
    // 会话高级功能
    summarizeSession,
    isSummarizing,
    // 待办事项
    todoItems,
    loadTodoItems,
    // 事件处理器注册
    registerEventHandler,
    // 并行会话
    syncSessionStatus,
    runningCount,
    isSessionRunning,
    canStartNewAgent,
    // 会话通知
    sessionNotifications,
    dismissNotification,
  }
}
