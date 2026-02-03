import { ref, computed } from 'vue'
import { api, type Session, type Message, type SSEEvent, type MessagePart, type QuestionRequest, type PermissionRequest, type TodoItem, questionApi, permissionApi, SessionBusyError } from '../api/client'
import { useParallelSessions, MAX_PARALLEL_AGENTS } from './useParallelSessions'

export function useSession() {
  const sessions = ref<Session[]>([])
  const currentSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const isLoading = ref(false)
  const currentDirectory = ref('')

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

  // isStreaming is now computed based on current session
  const isStreaming = computed(() => {
    if (!currentSession.value) return false
    return isSessionRunning(currentSession.value.id)
  })

  // 当前正在流式接收的消息
  const streamingMessage = ref<Message | null>(null)

  // 待处理的问题和权限请求
  const pendingQuestions = ref<QuestionRequest[]>([])
  const pendingPermissions = ref<PermissionRequest[]>([])

  // 会话错误（如模型不可用）
  const sessionError = ref<{ message: string; dismissable?: boolean } | null>(null)

  // 会话完成通知（用于其他会话完成时的友好提示）
  const sessionNotifications = ref<{ id: string; sessionId: string; sessionTitle: string; message: string; type: 'success' | 'info' }[]>([])

  // 待办事项
  const todoItems = ref<TodoItem[]>([])
  const isSummarizing = ref(false)

  // 事件源订阅
  let eventSource: EventSource | null = null

  // 通知定时器追踪（用于清理）
  const notificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

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

  async function loadSessions(directory?: string) {
    try {
      sessions.value = await api.getSessions(directory)
    } catch (error) {
      console.error('Failed to load sessions:', error)
    }
  }

  /**
   * 创建新会话（草稿模式）
   * 不会立即调用后端 API，只有发送消息时才真正创建
   */
  function createSession(directory: string) {
    // 进入草稿模式，清空当前会话状态
    isDraftSession.value = true
    currentSession.value = null
    currentDirectory.value = directory || '.'
    messages.value = []
  }

  /**
   * 实际创建会话（内部方法，发送消息时调用）
   */
  async function _createSessionInternal(directory: string): Promise<Session> {
    try {
      isLoading.value = true
      const session = await api.createSession(directory)
      currentSession.value = session
      // 使用服务器返回的实际目录，而不是传入的参数
      currentDirectory.value = session.directory
      isDraftSession.value = false
      // 重新加载所有会话，不过滤目录
      await loadSessions()
      return session
    } catch (error) {
      console.error('Failed to create session:', error)
      throw error
    } finally {
      isLoading.value = false
    }
  }

  async function selectSession(session: Session) {
    try {
      isLoading.value = true
      // 切换到已存在的会话，退出草稿模式
      isDraftSession.value = false
      currentSession.value = session
      currentDirectory.value = session.directory
      messages.value = await api.getMessages(session.id)
    } catch (error) {
      console.error('Failed to load messages:', error)
    } finally {
      isLoading.value = false
    }
  }

  // 用于防止用户消息重复
  const seenUserMessageIds = new Set<string>()

  async function sendMessage(
    content: string,
    model?: { providerID: string; modelID: string },
    files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>
  ) {
    // 如果是草稿模式或没有当前会话，先创建会话
    if (isDraftSession.value || !currentSession.value) {
      try {
        await _createSessionInternal(currentDirectory.value || '.')
      } catch (error) {
        console.error('Failed to create session before sending message:', error)
        sessionError.value = {
          message: '创建会话失败，请重试',
          dismissable: true
        }
        return
      }
    }

    if (!currentSession.value) return

    // Check if this session is already streaming
    if (isSessionRunning(currentSession.value.id)) return

    // Check parallel limit
    if (!canStartNewAgent.value) {
      sessionError.value = {
        message: `最多支持 ${MAX_PARALLEL_AGENTS} 个并行 agent，请等待其中一个完成`,
        dismissable: true
      }
      return
    }

    // Mark session as running BEFORE the API call
    setSessionRunning(currentSession.value.id, true)
    streamingMessage.value = null
    // 清空已见消息记录
    seenUserMessageIds.clear()

    const sessionId = currentSession.value.id

    try {
      await api.sendMessage(
        sessionId,
        content,
        handleSSEEvent,
        (error) => {
          // Ignore abort errors - these are normal when session completes or user cancels
          const errorMessage = error.message?.toLowerCase() || ''
          if (errorMessage.includes('aborted') || errorMessage.includes('abort') || error.name === 'AbortError') {
            console.log('Stream ended (aborted)')
            return
          }
          console.error('Stream error:', error)
          sessionError.value = {
            message: `网络错误: ${error.message || '连接中断'}`,
            dismissable: true
          }
          // Mark session as stopped on error
          setSessionRunning(sessionId, false)
        },
        model,
        files
      )
    } catch (error: any) {
      // Ignore abort errors
      const errorMessage = error.message?.toLowerCase() || ''
      if (errorMessage.includes('aborted') || errorMessage.includes('abort') || error.name === 'AbortError') {
        console.log('Request aborted')
        return
      }
      // Handle session busy error
      if (error instanceof SessionBusyError) {
        console.log('Session is busy:', error.sessionID)
        sessionError.value = {
          message: '该会话正在被其他客户端使用中，请稍后重试或创建新会话',
          dismissable: true
        }
        // Mark session as stopped since we couldn't start
        setSessionRunning(sessionId, false)
        return
      }
      console.error('Failed to send message:', error)
      sessionError.value = {
        message: `发送失败: ${error.message || '未知错误'}`,
        dismissable: true
      }
      // Mark session as stopped on error
      setSessionRunning(sessionId, false)
    } finally {
      streamingMessage.value = null
      // Note: Don't set running to false here - SSE events will handle that via session.idle
    }
  }

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event

    switch (type) {
      case 'message.created':
        // 新消息创建
        if (properties.message) {
          const msg = properties.message as Message
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
          const messageID = part.messageID
          if (messageID) {
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

      case 'message.completed':
        // 消息完成
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
        // 权限已回复，从待处理列表移除
        if (properties?.requestID) {
          pendingPermissions.value = pendingPermissions.value.filter(p => p.id !== properties.requestID)
        }
        break

      case 'session.error':
        // 会话错误（如模型不可用）
        if (properties?.error) {
          const error = properties.error
          const message = error.data?.message || error.message || '发生未知错误'
          sessionError.value = {
            message,
            dismissable: true
          }
          // Note: session running state is handled by handleGlobalSSEEvent
        }
        break

      case 'session.idle':
        // Note: session running state is handled by handleGlobalSSEEvent
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
    try {
      await api.abortSession(sessionId)
      setSessionRunning(sessionId, false)
    } catch (error) {
      console.error('Failed to abort session:', error)
    }
  }

  async function abortCurrentSession() {
    if (currentSession.value && isStreaming.value) {
      await abortSession(currentSession.value.id)
    }
  }

  // 订阅全局事件流
  function subscribeToEvents() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }

    eventSource = api.subscribeEvents((event: SSEEvent) => {
      // ALWAYS process for parallel session tracking (status events for ALL sessions)
      handleGlobalSSEEvent(event)

      // 调用外部事件处理器（如 agent terminal）
      for (const handler of externalEventHandlers) {
        try {
          handler(event)
        } catch (e) {
          console.error('External event handler error:', e)
        }
      }

      // Extract sessionID from all possible locations
      const sessionID = event.properties?.sessionID
        || event.properties?.message?.info?.sessionID
        || event.properties?.part?.sessionID
        || event.properties?.info?.sessionID
        || event.properties?.status?.sessionID
        || event.properties?.error?.sessionID

      // Handle notifications for other sessions
      if (sessionID && currentSession.value && sessionID !== currentSession.value.id) {
        // Show friendly notification when other session completes
        if (event.type === 'session.idle' || (event.type === 'session.status' && event.properties?.status?.type === 'idle')) {
          const session = sessions.value.find(s => s.id === sessionID)
          if (session) {
            const notificationId = `${sessionID}-${Date.now()}`
            sessionNotifications.value.push({
              id: notificationId,
              sessionId: sessionID,
              sessionTitle: session.title || '会话',
              message: '任务已完成',
              type: 'success'
            })
            // Auto-dismiss after 5 seconds (with cleanup tracking)
            const timerId = setTimeout(() => {
              sessionNotifications.value = sessionNotifications.value.filter(n => n.id !== notificationId)
              notificationTimers.delete(notificationId)
            }, 5000)
            notificationTimers.set(notificationId, timerId)
          }
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

  // 取消订阅
  function unsubscribe() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    // 清理所有通知定时器
    for (const timerId of notificationTimers.values()) {
      clearTimeout(timerId)
    }
    notificationTimers.clear()
  }

  // 加载待处理的问题和权限请求
  async function loadPendingRequests() {
    try {
      const [questions, permissions] = await Promise.all([
        questionApi.list(),
        permissionApi.list()
      ])
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

  // 回答问题
  async function answerQuestion(requestId: string, answers: string[][]) {
    try {
      await questionApi.reply(requestId, answers)
      pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== requestId)
    } catch (error) {
      console.error('Failed to answer question:', error)
      throw error
    }
  }

  // 拒绝问题
  async function rejectQuestion(requestId: string) {
    try {
      await questionApi.reject(requestId)
      pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== requestId)
    } catch (error) {
      console.error('Failed to reject question:', error)
      throw error
    }
  }

  // 刷新权限列表
  async function refreshPermissions() {
    try {
      const permissions = await permissionApi.list()
      pendingPermissions.value = permissions.filter(
        p => currentSession.value && p.sessionID === currentSession.value.id
      )
    } catch (e) {
      console.error('Failed to refresh permissions:', e)
    }
  }

  // 响应权限请求
  async function respondPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string) {
    try {
      await permissionApi.reply(requestId, reply, message)
      // 立即从列表移除
      pendingPermissions.value = pendingPermissions.value.filter(p => p.id !== requestId)
    } catch (error) {
      console.error('Failed to respond to permission:', error)
      // 刷新权限列表以恢复正确状态
      await refreshPermissions()
      throw error
    }
  }

  // 清除会话错误
  function clearSessionError() {
    sessionError.value = null
  }

  // 删除会话
  async function deleteSession(sessionId: string) {
    try {
      await api.deleteSession(sessionId)
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
        }
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
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
    if (!currentSession.value) return

    try {
      await api.deleteMessagePart(currentSession.value.id, messageId, partId)

      // 从本地消息列表中删除
      const msgIndex = messages.value.findIndex(m => m.info.id === messageId)
      if (msgIndex !== -1) {
        messages.value[msgIndex].parts = messages.value[msgIndex].parts.filter(p => p.id !== partId)
        // 如果消息没有任何部分了，也删除消息
        if (messages.value[msgIndex].parts.length === 0) {
          messages.value.splice(msgIndex, 1)
        } else {
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
    if (!currentSession.value) return

    try {
      const updatedPart = await api.updateMessagePart(currentSession.value.id, messageId, partId, updates)

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

    isSummarizing.value = true
    try {
      await api.summarizeSession(currentSession.value.id, model)
      // 重新加载消息以获取压缩后的内容
      messages.value = await api.getMessages(currentSession.value.id)
    } catch (error) {
      console.error('Failed to summarize session:', error)
      throw error
    } finally {
      isSummarizing.value = false
    }
  }

  // 加载待办事项
  async function loadTodoItems() {
    if (!currentSession.value) return

    try {
      todoItems.value = await api.getSessionTodo(currentSession.value.id)
    } catch (error) {
      console.error('Failed to load todo items:', error)
      todoItems.value = []
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
    currentSession,
    messages,
    isLoading,
    isStreaming,
    isDraftSession,
    currentDirectory,
    streamingMessage,
    pendingQuestions,
    pendingPermissions,
    sessionError,
    loadSessions,
    createSession,
    selectSession,
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
    dismissNotification
  }
}
