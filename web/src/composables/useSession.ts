import { ref } from 'vue'
import { api, type Session, type Message, type SSEEvent, type MessagePart } from '../api/client'

export function useSession() {
  const sessions = ref<Session[]>([])
  const currentSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const isLoading = ref(false)
  const isStreaming = ref(false)
  const currentDirectory = ref('')

  // 当前正在流式接收的消息
  const streamingMessage = ref<Message | null>(null)

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
          isStreaming.value = false
        },
        model
      )
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

  return {
    sessions,
    currentSession,
    messages,
    isLoading,
    isStreaming,
    currentDirectory,
    streamingMessage,
    loadSessions,
    createSession,
    selectSession,
    sendMessage,
    abortCurrentSession,
    subscribeToEvents,
    unsubscribe
  }
}
