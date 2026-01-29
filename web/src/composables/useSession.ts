import { ref } from 'vue'
import { api, type Session, type Message, type SSEEvent, type MessagePart, type QuestionRequest, type PermissionRequest, type TodoItem, questionApi, permissionApi } from '../api/client'

export function useSession() {
  const sessions = ref<Session[]>([])
  const currentSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const isLoading = ref(false)
  const isStreaming = ref(false)
  const currentDirectory = ref('')

  // 当前正在流式接收的消息
  const streamingMessage = ref<Message | null>(null)

  // 待处理的问题和权限请求
  const pendingQuestions = ref<QuestionRequest[]>([])
  const pendingPermissions = ref<PermissionRequest[]>([])

  // 会话错误（如模型不可用）
  const sessionError = ref<{ message: string; dismissable?: boolean } | null>(null)

  // 待办事项
  const todoItems = ref<TodoItem[]>([])
  const isSummarizing = ref(false)

  // 事件源订阅
  let eventSource: EventSource | null = null

  async function loadSessions(directory?: string) {
    try {
      sessions.value = await api.getSessions(directory)
    } catch (error) {
      console.error('Failed to load sessions:', error)
    }
  }

  async function createSession(directory: string) {
    try {
      isLoading.value = true
      currentDirectory.value = directory
      const session = await api.createSession(directory)
      currentSession.value = session
      messages.value = []
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

  async function sendMessage(content: string, model?: { providerID: string; modelID: string }) {
    if (!currentSession.value || isStreaming.value) return

    isStreaming.value = true
    streamingMessage.value = null
    // 清空已见消息记录
    seenUserMessageIds.clear()

    try {
      await api.sendMessage(
        currentSession.value.id,
        content,
        handleSSEEvent,
        (error) => {
          console.error('Stream error:', error)
          sessionError.value = {
            message: `网络错误: ${error.message || '连接中断'}`,
            dismissable: true
          }
          isStreaming.value = false
        },
        model
      )
    } catch (error: any) {
      console.error('Failed to send message:', error)
      sessionError.value = {
        message: `发送失败: ${error.message || '未知错误'}`,
        dismissable: true
      }
    } finally {
      isStreaming.value = false
      streamingMessage.value = null
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
          // 停止流式状态
          isStreaming.value = false
        }
        break

      case 'session.idle':
        // 会话空闲，停止流式状态
        isStreaming.value = false
        break
    }
  }

  async function abortCurrentSession() {
    if (currentSession.value && isStreaming.value) {
      try {
        await api.abortSession(currentSession.value.id)
        isStreaming.value = false
      } catch (error) {
        console.error('Failed to abort session:', error)
      }
    }
  }

  // 订阅全局事件流
  function subscribeToEvents() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }

    eventSource = api.subscribeEvents((event: SSEEvent) => {
      // 只处理当前会话的事件
      const sessionID = event.properties?.sessionID
        || event.properties?.message?.info?.sessionID
        || event.properties?.part?.sessionID
      if (sessionID && currentSession.value && sessionID !== currentSession.value.id) {
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

  // 响应权限请求
  async function respondPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string) {
    try {
      await permissionApi.reply(requestId, reply, message)
      pendingPermissions.value = pendingPermissions.value.filter(p => p.id !== requestId)
    } catch (error) {
      console.error('Failed to respond to permission:', error)
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

    isSummarizing.value = true
    try {
      await api.summarizeSession(currentSession.value.id)
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

  return {
    sessions,
    currentSession,
    messages,
    isLoading,
    isStreaming,
    currentDirectory,
    streamingMessage,
    pendingQuestions,
    pendingPermissions,
    sessionError,
    loadSessions,
    createSession,
    selectSession,
    sendMessage,
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
    loadTodoItems
  }
}
