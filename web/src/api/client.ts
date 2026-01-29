const BASE_URL = ''  // 使用相对路径，由 vite proxy 或同源处理

export interface Session {
  id: string
  slug?: string
  title: string
  directory: string
  projectID?: string
  parentID?: string
  time: {
    created: number
    updated: number
    archived?: number
  }
  // Computed field for display
  createdAt?: string
}

// 后端返回格式: { info: MessageInfo, parts: Part[] }
export interface Message {
  info: MessageInfo
  parts: MessagePart[]
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time: {
    created: number
    completed?: number
  }
  // user message fields
  agent?: string
  model?: { providerID: string; modelID: string }
  // assistant message fields
  parentID?: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  error?: any
}

export interface MessagePart {
  id: string
  sessionID: string
  messageID: string
  type: 'text' | 'tool' | 'step-start' | 'step-finish' | 'reasoning' | 'file' | 'snapshot' | 'patch' | 'agent' | 'retry' | 'compaction' | 'subtask'
  // text part
  text?: string
  synthetic?: boolean
  ignored?: boolean
  // tool part
  tool?: string
  callID?: string
  state?: ToolState
  // step-start/step-finish
  snapshot?: string
  reason?: string
  cost?: number
  tokens?: any
  // reasoning / text time
  time?: { start?: number; end?: number }
  metadata?: Record<string, any>
}

export interface ToolState {
  status: 'pending' | 'running' | 'completed' | 'error'
  input?: Record<string, any>
  raw?: string
  output?: string
  title?: string
  error?: string
  time?: { start?: number; end?: number; compacted?: number }
  metadata?: Record<string, any>
  attachments?: any[]
}

export interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
}

// === Todo Types ===
export interface TodoItem {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy?: string[]
}

// === File Content Types ===
export interface FileContent {
  content: string
  path: string
  encoding?: string
}

export interface FileSearchResult {
  path: string
  name: string
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
    const sessions = Array.isArray(data) ? data : (data.data || [])
    // 添加 createdAt 字段用于显示
    return sessions.map((s: Session) => ({
      ...s,
      createdAt: s.time ? new Date(s.time.created).toISOString() : undefined
    }))
  },

  // 创建会话
  async createSession(directory?: string): Promise<Session> {
    const res = await fetch(`${BASE_URL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(directory ? { directory } : {})
    })
    const data = await res.json()
    const session = data.data || data
    return {
      ...session,
      createdAt: session.time ? new Date(session.time.created).toISOString() : undefined
    }
  },

  // 获取消息历史
  // 后端返回 { info: MessageInfo, parts: Part[] }[]
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
    onError?: (error: Error) => void,
    model?: { providerID: string; modelID: string }
  ): Promise<void> {
    try {
      const body: Record<string, any> = {
        parts: [{ type: 'text', text: content }]
      }
      // 如果指定了模型，添加到请求体
      if (model) {
        body.model = model
      }
      const res = await fetch(`${BASE_URL}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
        // 处理普通 JSON 响应 - 后端返回 { info, parts }
        const data = await res.json()
        if (data.info) {
          const message: Message = {
            info: data.info,
            parts: data.parts || []
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

  // 删除会话
  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      throw new Error(`Failed to delete session: ${res.status}`)
    }
    return true
  },

  // 更新会话（重命名等）
  async updateSession(sessionId: string, updates: { title?: string }): Promise<Session> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    if (!res.ok) {
      throw new Error(`Failed to update session: ${res.status}`)
    }
    const data = await res.json()
    const session = data.data || data
    return {
      ...session,
      createdAt: session.time ? new Date(session.time.created).toISOString() : undefined
    }
  },

  // 删除消息部分
  async deleteMessagePart(sessionId: string, messageId: string, partId: string): Promise<boolean> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}/message/${messageId}/part/${partId}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      throw new Error(`Failed to delete message part: ${res.status}`)
    }
    return true
  },

  // 更新消息部分
  async updateMessagePart(sessionId: string, messageId: string, partId: string, updates: { text?: string }): Promise<MessagePart> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}/message/${messageId}/part/${partId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    if (!res.ok) {
      throw new Error(`Failed to update message part: ${res.status}`)
    }
    const data = await res.json()
    return data.data || data
  },

  // 压缩会话
  async summarizeSession(sessionId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}/summarize`, {
      method: 'POST'
    })
    if (!res.ok) {
      throw new Error(`Failed to summarize session: ${res.status}`)
    }
  },

  // 获取会话待办事项
  async getSessionTodo(sessionId: string): Promise<TodoItem[]> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}/todo`)
    if (!res.ok) {
      throw new Error(`Failed to get session todo: ${res.status}`)
    }
    const data = await res.json()
    return Array.isArray(data) ? data : (data.data || [])
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

  // 获取文件内容
  async getFileContent(path: string): Promise<FileContent> {
    const params = new URLSearchParams({ path })
    const res = await fetch(`${BASE_URL}/file/content?${params}`)
    if (!res.ok) {
      throw new Error(`Failed to get file content: ${res.status}`)
    }
    const data = await res.json()
    return data.data || data
  },

  // 搜索文件
  async searchFiles(pattern: string): Promise<FileSearchResult[]> {
    const params = new URLSearchParams({ pattern })
    const res = await fetch(`${BASE_URL}/find/file?${params}`)
    if (!res.ok) {
      throw new Error(`Failed to search files: ${res.status}`)
    }
    const data = await res.json()
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

// === Question Types ===
export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: {
    messageID: string
    callID: string
  }
}

// === Permission Types ===
export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, any>
}

// === MCP Types ===
export interface McpServer {
  name: string
  // 后端状态: connected, disabled, failed, needs_auth, needs_client_registration
  status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'connecting'
  error?: string
  tools?: McpTool[]
  resources?: McpResource[]
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, any>
}

export interface McpResource {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

// === Provider Types ===
export interface Provider {
  id: string
  name: string
  models: Model[]
  authenticated: boolean
  authMethods?: AuthMethod[]
}

export interface Model {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
}

export interface AuthMethod {
  type: 'oauth' | 'apiKey'
  name?: string
}

// === Skill Types ===
export interface Skill {
  name: string
  description?: string
  source: 'builtin' | 'plugin'
}

// === Config Types ===
export interface Config {
  // model 格式: "provider/model", 如 "anthropic/claude-2"
  model?: string
  directory?: string
  [key: string]: any
}

// === Extended API ===
export const mcpApi = {
  // 获取所有 MCP 服务器状态
  // 后端返回 Record<string, MCP.Status>，转换为数组
  async list(): Promise<McpServer[]> {
    const res = await fetch(`${BASE_URL}/mcp`)
    const data = await res.json()
    // 后端返回 { serverName: { status, tools, ... }, ... }
    if (typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([name, info]: [string, any]) => ({
        name,
        status: info.status || 'disconnected',
        error: info.error,
        tools: info.tools || [],
        resources: info.resources || []
      }))
    }
    return []
  },

  // 添加新 MCP 服务器
  async add(config: { name: string; command?: string; args?: string[]; env?: Record<string, string> }): Promise<McpServer> {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.name, config })
    })
    const data = await res.json()
    return data
  },

  // 连接 MCP 服务器
  async connect(name: string): Promise<void> {
    await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}/connect`, {
      method: 'POST'
    })
  },

  // 断开 MCP 服务器
  async disconnect(name: string): Promise<void> {
    await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: 'POST'
    })
  },

  // 启动 OAuth 认证
  async startAuth(name: string): Promise<{ url: string }> {
    const res = await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}/auth`, {
      method: 'POST'
    })
    const data = await res.json()
    return { url: data.authorizationUrl || data.url }
  }
}

export const skillApi = {
  // 获取所有可用技能
  async list(): Promise<Skill[]> {
    const res = await fetch(`${BASE_URL}/skill`)
    const data = await res.json()
    return Array.isArray(data) ? data : (data.data || [])
  }
}

export const providerApi = {
  // 获取所有提供者和模型
  // 后端返回 { all: Provider[], default: Record<string, string>, connected: string[] }
  async list(): Promise<{ providers: Provider[]; defaults: Record<string, string>; connected: string[] }> {
    const res = await fetch(`${BASE_URL}/provider`)
    const data = await res.json()
    // 后端返回 { all: [...], default: {...}, connected: [...] }
    const providerList = data.all || data
    const connected = data.connected || []
    const defaults = data.default || {}
    const connectedSet = new Set(connected)

    const providers = Array.isArray(providerList)
      ? providerList.map((p: any) => ({
          id: p.id,
          name: p.name,
          models: Object.values(p.models || {}).map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            contextWindow: m.context,
            maxOutputTokens: m.maxOutput
          })),
          authenticated: connectedSet.has(p.id)
        }))
      : []

    return { providers, defaults, connected }
  },

  // 获取认证方法
  // 后端返回 Record<string, AuthMethod[]>
  async getAuthMethods(): Promise<Record<string, AuthMethod[]>> {
    const res = await fetch(`${BASE_URL}/provider/auth`)
    const data = await res.json()
    return data
  },

  // 启动 OAuth - 需要 method index
  async startOAuth(providerId: string, methodIndex: number = 0): Promise<{ url: string }> {
    const res = await fetch(`${BASE_URL}/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: methodIndex })
    })
    const data = await res.json()
    return { url: data.url || data.authorizationUrl }
  },

  // 完成 OAuth 回调
  async completeOAuth(providerId: string, code: string, methodIndex: number = 0): Promise<void> {
    await fetch(`${BASE_URL}/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: methodIndex, code })
    })
  }
}

export const configApi = {
  // 获取当前配置
  async get(): Promise<Config> {
    const res = await fetch(`${BASE_URL}/config`)
    const data = await res.json()
    return data
  },

  // 更新配置
  async update(config: Partial<Config>): Promise<Config> {
    const res = await fetch(`${BASE_URL}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
    const data = await res.json()
    return data
  }
}

export const authApi = {
  // 设置 API Key
  // 后端期望 Auth.Info 格式: { type: 'api', key: string }
  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await fetch(`${BASE_URL}/auth/${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key: apiKey })
    })
  },

  // 移除认证
  async remove(providerId: string): Promise<void> {
    await fetch(`${BASE_URL}/auth/${encodeURIComponent(providerId)}`, {
      method: 'DELETE'
    })
  }
}

// === Question API ===
export const questionApi = {
  // 获取待处理的问题列表
  async list(): Promise<QuestionRequest[]> {
    const res = await fetch(`${BASE_URL}/question`)
    const data = await res.json()
    return Array.isArray(data) ? data : []
  },

  // 回复问题
  // answers 是二维数组: 每个问题对应一个选中的答案数组
  async reply(requestId: string, answers: string[][]): Promise<void> {
    await fetch(`${BASE_URL}/question/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers })
    })
  },

  // 拒绝问题
  async reject(requestId: string): Promise<void> {
    await fetch(`${BASE_URL}/question/${encodeURIComponent(requestId)}/reject`, {
      method: 'POST'
    })
  }
}

// === Permission API ===
export const permissionApi = {
  // 获取待处理的权限请求列表
  async list(): Promise<PermissionRequest[]> {
    const res = await fetch(`${BASE_URL}/permission`)
    const data = await res.json()
    return Array.isArray(data) ? data : []
  },

  // 回复权限请求
  // reply: 'once' | 'always' | 'reject'
  async reply(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await fetch(`${BASE_URL}/permission/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply, message })
    })
  }
}
