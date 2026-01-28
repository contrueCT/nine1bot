const BASE_URL = ''  // 使用相对路径，由 vite proxy 或同源处理

export interface Session {
  id: string
  title?: string
  directory: string
  createdAt: string
}

export interface Message {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  createdAt: string
}

export interface MessagePart {
  id: string
  sessionID?: string
  messageID?: string
  type: 'text' | 'tool' | 'step-start' | 'step-finish' | 'reasoning'
  // text part
  text?: string
  // tool part
  tool?: string
  callID?: string
  state?: ToolState
  // step-start/step-finish
  snapshot?: string
  reason?: string
  cost?: number
  tokens?: any
  // reasoning
  time?: { start?: number; end?: number }
}

export interface ToolState {
  status: 'pending' | 'running' | 'completed' | 'error'
  input?: Record<string, any>
  output?: any
  title?: string
  error?: string
  time?: { start?: number; end?: number }
  metadata?: Record<string, any>
}

export interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
}

export const api = {
  // 健康检查
  async health(): Promise<{ healthy: boolean; version: string }> {
    const res = await fetch(`${BASE_URL}/global/health`)
    const data = await res.json()
    return data.data
  },

  // 获取会话列表
  async getSessions(directory?: string): Promise<Session[]> {
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    const res = await fetch(`${BASE_URL}/session?${params}`)
    const data = await res.json()
    return Array.isArray(data) ? data : (data.data || [])
  },

  // 创建会话
  async createSession(directory: string): Promise<Session> {
    const res = await fetch(`${BASE_URL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory })
    })
    const data = await res.json()
    return data.data || data
  },

  // 获取消息历史
  async getMessages(sessionId: string): Promise<Message[]> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}/message`)
    const data = await res.json()
    return Array.isArray(data) ? data : (data.data || [])
  },

  // 发送消息 (支持 SSE 流式响应和普通 JSON 响应)
  async sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: SSEEvent) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    try {
      const res = await fetch(`${BASE_URL}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: content }]
        })
      })

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`)
      }

      const contentType = res.headers.get('content-type') || ''

      // 处理 SSE 流式响应
      if (contentType.includes('text/event-stream')) {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6))
                onEvent(event)
              } catch (e) {
                console.warn('Failed to parse SSE event:', line)
              }
            }
          }
        }
      } else {
        // 处理普通 JSON 响应
        const data = await res.json()
        if (data.info) {
          // 构造消息事件
          const message: Message = {
            id: data.info.id,
            sessionID: data.info.sessionID,
            role: data.info.role,
            parts: data.parts || [],
            createdAt: new Date(data.info.time?.created || Date.now()).toISOString()
          }
          onEvent({ type: 'message.created', properties: { message } })
          onEvent({ type: 'message.completed', properties: { message } })
        }
      }
    } catch (error) {
      onError?.(error as Error)
    }
  },

  // 中止会话
  async abortSession(sessionId: string): Promise<void> {
    await fetch(`${BASE_URL}/session/${sessionId}/abort`, {
      method: 'POST'
    })
  },

  // 获取文件列表
  async getFiles(path: string = ''): Promise<FileItem[]> {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    const res = await fetch(`${BASE_URL}/file?${params}`)
    const data = await res.json()
    // API 直接返回数组
    return Array.isArray(data) ? data : (data.data || [])
  },

  // 获取项目列表
  async getProjects(): Promise<any[]> {
    const res = await fetch(`${BASE_URL}/project`)
    const data = await res.json()
    return data.data || []
  },

  // 订阅事件流
  subscribeEvents(onEvent: (event: SSEEvent) => void): EventSource {
    const eventSource = new EventSource(`${BASE_URL}/event`)
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        // 服务器发送格式: { directory, payload: { type, properties } }
        const event = data.payload || data
        if (event.type) {
          onEvent(event)
        }
      } catch (err) {
        console.warn('Failed to parse event:', e.data)
      }
    }
    eventSource.onerror = (e) => {
      console.error('EventSource error:', e)
    }
    return eventSource
  }
}

export interface SSEEvent {
  type: string
  properties: Record<string, any>
}
