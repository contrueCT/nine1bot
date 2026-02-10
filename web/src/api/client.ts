const BASE_URL = ''  // 使用相对路径，由 vite proxy 或同源处理

// 默认请求超时时间 (30秒)
const DEFAULT_TIMEOUT = 30000

// 带超时的 fetch 封装
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = DEFAULT_TIMEOUT
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

// Session busy error - thrown when another client is using the session
export class SessionBusyError extends Error {
  constructor(public sessionID: string) {
    super(`Session ${sessionID} is busy`)
    this.name = 'SessionBusyError'
  }
}

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

// 文件附件类型
export interface FilePart {
  id: string
  sessionID?: string
  messageID?: string
  type: 'file'
  mime: string
  filename?: string
  url: string
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
  attachments?: FilePart[]
}

export interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
}

// === Todo Types ===
export interface TodoItem {
  id: string
  content: string  // 任务内容
  status: string   // pending, in_progress, completed, cancelled
  priority: string // high, medium, low
  activeForm?: string  // 任务执行时显示的进行时态描述 (e.g., 'Running tests')
  planMode?: boolean   // 是否为规划模式中的任务
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
    const res = await fetchWithTimeout(`${BASE_URL}/global/health`, {}, 10000) // 10秒超时
    const data = await res.json()
    return data.data
  },

  // 获取会话列表
  async getSessions(directory?: string): Promise<Session[]> {
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    params.set('roots', 'true')  // 只获取主会话，过滤掉 subagent 会话
    const res = await fetchWithTimeout(`${BASE_URL}/session?${params}`)
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
    model?: { providerID: string; modelID: string },
    files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>
  ): Promise<void> {
    try {
      const parts: any[] = []

      // Add text content if not empty
      if (content.trim()) {
        parts.push({ type: 'text', text: content })
      }

      // Add file parts
      if (files && files.length > 0) {
        parts.push(...files)
      }

      const body: Record<string, any> = { parts }

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
        // Handle session busy error (409 Conflict)
        if (res.status === 409) {
          const error = await res.json().catch(() => ({}))
          throw new SessionBusyError(error.data?.sessionID || sessionId)
        }
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

  // 获取所有会话状态
  async getSessionStatus(): Promise<Record<string, { type: string }>> {
    const res = await fetch(`${BASE_URL}/session/status`)
    const data = await res.json()
    return data
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

  // 更新会话（重命名、修改工作目录等）
  async updateSession(sessionId: string, updates: { title?: string; directory?: string }): Promise<Session> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}))
      throw new Error(errorData.error || `Failed to update session: ${res.status}`)
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
  async summarizeSession(sessionId: string, model: { providerID: string; modelID: string }): Promise<void> {
    const res = await fetch(`${BASE_URL}/session/${sessionId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model)
    })
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}))
      throw new Error(errorData.error?.[0]?.message || `Failed to summarize session: ${res.status}`)
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
  async getFiles(path: string = '', directory?: string): Promise<FileItem[]> {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    if (directory) params.set('directory', directory)
    const res = await fetch(`${BASE_URL}/file?${params}`)
    const data = await res.json()
    // API 直接返回数组
    return Array.isArray(data) ? data : (data.data || [])
  },

  // 获取文件内容
  async getFileContent(path: string, directory?: string): Promise<FileContent> {
    const params = new URLSearchParams({ path })
    if (directory) params.set('directory', directory)
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

  // 搜索会话
  async searchSessions(query: string, limit: number = 20): Promise<Session[]> {
    const params = new URLSearchParams({
      search: query,
      roots: 'true',
      limit: String(limit)
    })
    const res = await fetchWithTimeout(`${BASE_URL}/session?${params}`)
    const data = await res.json()
    const sessions = Array.isArray(data) ? data : (data.data || [])
    return sessions.map((s: Session) => ({
      ...s,
      createdAt: s.time ? new Date(s.time.created).toISOString() : undefined
    }))
  },

  // 获取项目列表
  async getProjects(): Promise<any[]> {
    const res = await fetch(`${BASE_URL}/project`)
    const data = await res.json()
    return Array.isArray(data) ? data : (data.data || [])
  },

  // 获取单个项目
  async getProject(projectId: string): Promise<any> {
    // Use the list endpoint and find by ID since there's no individual GET endpoint
    const projects = await api.getProjects()
    const project = projects.find((p: any) => p.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return project
  },

  // 更新项目
  async updateProject(projectId: string, updates: { name?: string; instructions?: string; icon?: any }): Promise<any> {
    const res = await fetch(`${BASE_URL}/project/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    if (!res.ok) {
      throw new Error(`Failed to update project: ${res.status}`)
    }
    const data = await res.json()
    return data.data || data
  },

  // 获取项目的会话列表
  async getProjectSessions(projectId: string): Promise<Session[]> {
    const params = new URLSearchParams({ roots: 'true' })
    const res = await fetchWithTimeout(`${BASE_URL}/session?${params}`)
    const data = await res.json()
    const sessions = Array.isArray(data) ? data : (data.data || [])
    return sessions
      .filter((s: Session) => s.projectID === projectId)
      .map((s: Session) => ({
        ...s,
        createdAt: s.time ? new Date(s.time.created).toISOString() : undefined
      }))
  },

  // 选择目录（调用系统原生文件选择器）
  async pickDirectory(): Promise<{ path: string } | null> {
    try {
      const res = await fetchWithTimeout(`${BASE_URL}/browse/pick`, {
        method: 'POST'
      }, 60000)
      if (!res.ok) {
        if (res.status === 204) return null
        throw new Error(`Failed to pick directory: ${res.status}`)
      }
      return await res.json()
    } catch (e) {
      console.error('pickDirectory failed:', e)
      return null
    }
  },

  // 浏览目录（用于目录选择器）
  async browseDirectory(path: string = '~'): Promise<{
    path: string
    parent: string | null
    items: Array<{
      name: string
      path: string
      type: 'file' | 'directory'
      size?: number
      modified?: number
    }>
  }> {
    const params = new URLSearchParams({ path })
    const res = await fetch(`${BASE_URL}/browse?${params}`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to browse directory: ${res.status}`)
    }
    return res.json()
  },

  // 订阅事件流（带自动重连）
  subscribeEvents(onEvent: (event: SSEEvent) => void): EventSource {
    let eventSource: EventSource
    let reconnectAttempts = 0
    const maxReconnectAttempts = 5
    const baseReconnectDelay = 1000 // 1秒

    function connect(): EventSource {
      eventSource = new EventSource(`${BASE_URL}/event`)

      eventSource.onopen = () => {
        // 连接成功，重置重连计数
        reconnectAttempts = 0
      }

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

        // 尝试重连
        if (eventSource.readyState === EventSource.CLOSED) {
          if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++
            const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts - 1) // 指数退避
            console.log(`EventSource disconnected, reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`)
            setTimeout(() => {
              if (eventSource.readyState === EventSource.CLOSED) {
                connect()
              }
            }, delay)
          } else {
            console.error('EventSource max reconnect attempts reached')
          }
        }
      }

      return eventSource
    }

    return connect()
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
  health?: McpHealth
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

export interface McpHealth {
  ok: boolean
  checkedAt: string
  latencyMs?: number
  tools?: number
  resources?: number
  error?: string
}

// MCP 配置类型
export interface McpLocalConfig {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface McpRemoteConfig {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export type McpConfig = McpLocalConfig | McpRemoteConfig

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
  // 后端返回 Record<string, MCP.StatusInfo>，转换为数组
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
        resources: info.resources || [],
        health: info.health
      }))
    }
    return []
  },

  // 添加新 MCP 服务器
  async add(name: string, config: McpConfig): Promise<void> {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to add MCP server: ${res.status}`)
    }
  },

  // 删除 MCP 服务器
  async remove(name: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to remove MCP server: ${res.status}`)
    }
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
  },

  async health(name: string): Promise<McpHealth> {
    const res = await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}/health`, {
      method: 'POST'
    })
    const data = await res.json()
    return data
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
    const res = await fetchWithTimeout(`${BASE_URL}/permission`, {}, 10000)
    if (!res.ok) {
      throw new Error(`Failed to list permissions: ${res.status}`)
    }
    const data = await res.json()
    return Array.isArray(data) ? data : []
  },

  // 回复权限请求
  // reply: 'once' | 'always' | 'reject'
  async reply(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    const res = await fetchWithTimeout(
      `${BASE_URL}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply, message })
      },
      10000  // 10秒超时
    )
    if (!res.ok) {
      throw new Error(`Permission reply failed: ${res.status}`)
    }
  }
}

// === Preferences API ===
export interface Preference {
  id: string
  content: string
  source: 'user' | 'ai'
  createdAt: number
  scope: 'global' | 'project'
}

export interface PreferencesState {
  preferences: Preference[]
  global: Preference[]
  project: Preference[]
}

export const preferencesApi = {
  // 获取所有偏好
  async list(): Promise<PreferencesState> {
    const res = await fetchWithTimeout(`${BASE_URL}/preferences`)
    if (!res.ok) {
      throw new Error('Failed to fetch preferences')
    }
    return res.json()
  },

  // 添加偏好
  async add(content: string, scope: 'global' | 'project' = 'global', source: 'user' | 'ai' = 'user'): Promise<Preference> {
    const res = await fetchWithTimeout(`${BASE_URL}/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, scope, source })
    })
    if (!res.ok) {
      throw new Error('Failed to add preference')
    }
    return res.json()
  },

  // 更新偏好
  async update(id: string, content: string): Promise<Preference> {
    const res = await fetchWithTimeout(`${BASE_URL}/preferences/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })
    if (!res.ok) {
      throw new Error('Failed to update preference')
    }
    return res.json()
  },

  // 删除偏好
  async delete(id: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/preferences/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      throw new Error('Failed to delete preference')
    }
    return true
  },

  // 获取偏好提示词
  async getPrompt(): Promise<string> {
    const res = await fetchWithTimeout(`${BASE_URL}/preferences/prompt`)
    if (!res.ok) {
      throw new Error('Failed to fetch preferences prompt')
    }
    const data = await res.json()
    return data.prompt || ''
  }
}

// === Agent Terminal API ===
export interface AgentTerminalInfo {
  id: string
  name: string
  sessionID: string
  status: 'running' | 'exited'
  rows: number
  cols: number
  createdAt: number
  lastActivity: number
}

export const agentTerminalApi = {
  // 获取终端列表
  async list(sessionID?: string): Promise<AgentTerminalInfo[]> {
    const params = new URLSearchParams()
    if (sessionID) params.set('sessionID', sessionID)
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal?${params}`)
    if (!res.ok) {
      throw new Error('Failed to fetch agent terminals')
    }
    return res.json()
  },

  // 获取终端信息
  async get(id: string): Promise<AgentTerminalInfo> {
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal/${encodeURIComponent(id)}`)
    if (!res.ok) {
      throw new Error('Failed to fetch agent terminal')
    }
    return res.json()
  },

  // 调整终端大小
  async resize(id: string, rows: number, cols: number): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, cols })
    })
    if (!res.ok) {
      throw new Error('Failed to resize agent terminal')
    }
    return true
  },

  // 获取终端屏幕内容
  async getScreen(id: string): Promise<{ screen: string; screenAnsi: string; cursor: { row: number; col: number } }> {
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal/${encodeURIComponent(id)}/screen`)
    if (!res.ok) {
      throw new Error('Failed to fetch agent terminal screen')
    }
    return res.json()
  },

  // 获取终端原始缓冲区（用于初始化时回放历史）
  async getBuffer(id: string): Promise<{ buffer: string }> {
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal/${encodeURIComponent(id)}/buffer`)
    if (!res.ok) {
      throw new Error('Failed to fetch agent terminal buffer')
    }
    return res.json()
  },

  // 向终端发送输入
  async write(id: string, data: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal/${encodeURIComponent(id)}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    })
    if (!res.ok) {
      throw new Error('Failed to write to agent terminal')
    }
    return true
  },

  // 关闭终端
  async close(id: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/agent-terminal/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      throw new Error('Failed to close agent terminal')
    }
    return true
  }
}
