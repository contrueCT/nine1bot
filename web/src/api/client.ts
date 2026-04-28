import {
  RUNTIME_EVENT_TYPES,
  normalizeRuntimeEventEnvelope,
  type RuntimeEventEnvelope,
} from './runtime-events'
import { gitLabTemplateIdsForPage } from '@nine1bot/platform-gitlab/browser'
import type { RequestPagePayload } from './page-context'

const BASE_URL = ''  // 使用相对路径，由 vite proxy 或同源处理

// 默认请求超时时间 (30秒)
const DEFAULT_TIMEOUT = 30000
let activeDirectory = ''

export function setApiDirectory(directory?: string) {
  activeDirectory = (directory || '').trim()
}

function applyDirectoryToUrl(url: string): string {
  if (!activeDirectory) return url
  try {
    const parsed = new URL(url, window.location.origin)
    if (!parsed.searchParams.has('directory')) {
      parsed.searchParams.set('directory', activeDirectory)
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return parsed.toString()
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

function applyDirectoryHeaders(options: RequestInit): RequestInit {
  if (!activeDirectory) return options
  const headers = new Headers(options.headers || {})
  if (!headers.has('x-opencode-directory')) {
    headers.set('x-opencode-directory', activeDirectory)
  }
  return {
    ...options,
    headers,
  }
}

function fetchWithDirectory(url: string, options: RequestInit = {}) {
  return fetch(applyDirectoryToUrl(url), applyDirectoryHeaders(options))
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    createdAt: session.time ? new Date(session.time.created).toISOString() : undefined
  }
}

function webClientCapabilities(page?: RequestPagePayload) {
  return {
    interactions: true,
    permissionRequests: true,
    questionRequests: true,
    artifacts: true,
    filePreview: true,
    pageContext: Boolean(page),
    selectionContext: Boolean(page?.selection),
    debug: true,
    resourceFailures: true,
    contextAudit: true,
    turnSnapshots: true,
    continueInWeb: true,
  }
}

function controllerEntry(page?: RequestPagePayload) {
  if (!page) {
    return {
      source: 'web',
      mode: 'web-chat',
      templateIds: ['default-user-template', 'web-chat'],
    }
  }

  const templateIds = ['default-user-template', 'browser-generic']
  templateIds.push(...gitLabTemplateIdsForPage(page))

  return {
    source: 'browser-extension',
    platform: page.platform,
    mode: 'browser-sidepanel',
    templateIds,
  }
}

// 带超时的 fetch 封装
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = DEFAULT_TIMEOUT
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const preparedUrl = applyDirectoryToUrl(url)
  const preparedOptions = applyDirectoryHeaders(options)

  try {
    const response = await fetch(preparedUrl, {
      ...preparedOptions,
      signal: controller.signal
    })
    return response
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeout / 1000)}s: ${preparedUrl}`)
    }
    throw error
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
  runtime?: SessionRuntimeSummary
  time: {
    created: number
    updated: number
    archived?: number
  }
  // Computed field for display
  createdAt?: string
}

export interface SessionRuntimeSummary {
  protocolVersion?: string
  profileSnapshotId?: string
  profileSource?: string
  agent?: string
  currentModel?: {
    providerID: string
    modelID: string
    source?: string
  }
}

export interface Project {
  id: string
  worktree: string
  rootDirectory: string
  projectType: 'git' | 'directory'
  vcs?: 'git'
  name?: string
  icon?: { url?: string; override?: string; color?: string }
  instructions?: string
  time: { created: number; updated: number; initialized?: number; configUpdated?: number }
  sandboxes: string[]
}

export interface ProjectEnvironmentResponse {
  keys: string[]
  variables: Record<string, string>
}

export interface ProjectSharedFile {
  name: string
  relativePath: string
  size: number
  modified: number
  mime?: string
}

export interface WebhookSource {
  id: string
  name: string
  enabled: boolean
  projectID: string
  requestMapping: Record<string, string>
  promptTemplate: string
  runtimeProfile: WebhookRuntimeProfile
  permissionPolicy: WebhookPermissionPolicy
  requestGuards: WebhookRequestGuards
  secretMasked: string
  time: { created: number; updated: number }
  deletedAt?: number
}

export interface WebhookRuntimeProfile {
  modelMode: 'default' | 'custom'
  model?: { providerID: string; modelID: string }
  resourcesMode: 'default' | 'default-plus-selected'
  mcpServers: string[]
}

export interface WebhookPermissionPolicy {
  mode: 'default' | 'full'
}

export interface WebhookRequestGuards {
  dedupe: {
    enabled: boolean
    keyTemplate?: string
    ttlSeconds: number
  }
  rateLimit: {
    enabled: boolean
    maxRequests: number
    windowSeconds: number
  }
  cooldown: {
    enabled: boolean
    seconds: number
  }
  replayProtection: {
    enabled: boolean
    timestampHeader?: string
    maxSkewSeconds: number
  }
}

export interface WebhookSourceCreateResponse {
  source: WebhookSource
  secret: string
}

export interface WebhookRun {
  id: string
  sourceID: string
  projectID: string
  sessionID?: string
  turnSnapshotId?: string
  status: 'received' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'rejected'
  httpStatus?: number
  requestSummary?: unknown
  renderedPromptPreview?: string
  guardType?: 'dedupe' | 'rateLimit' | 'cooldown' | 'replayProtection'
  guardReason?: string
  dedupeKey?: string
  responseBody?: unknown
  error?: string
  time: {
    received: number
    started?: number
    finished?: number
  }
}

export interface WebhookStatus {
  listening: boolean
  localUrl: string
  publicUrl?: string
  localWebhookUrl: string
  publicWebhookUrl?: string
  tunnel: {
    enabled: boolean
    status: 'active' | 'disabled' | 'error' | string
  }
}

export interface WebhookSourceInput {
  name: string
  enabled?: boolean
  projectID: string
  requestMapping?: Record<string, string>
  promptTemplate?: string
  runtimeProfile?: WebhookRuntimeProfile
  permissionPolicy?: WebhookPermissionPolicy
  requestGuards?: WebhookRequestGuards
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

export interface SessionUploadResponse {
  type: 'file'
  filename: string
  mime: string
  url: string
  size: number
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
    return sessions.map((s: Session) => normalizeSession(s))
  },

  // 创建会话
  async createSession(directory?: string, pageContext?: RequestPagePayload): Promise<Session> {
    const res = await fetchWithDirectory(`${BASE_URL}/nine1bot/agent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(directory ? { directory } : {}),
        entry: controllerEntry(pageContext),
        ...(pageContext ? { page: pageContext } : {}),
        clientCapabilities: webClientCapabilities(pageContext),
      })
    })
    const data = await res.json()
    const session = data.session || data.data || data
    return normalizeSession(session)
  },

  // 获取消息历史
  // 后端返回 { info: MessageInfo, parts: Part[] }[]
  async getMessages(sessionId: string): Promise<Message[]> {
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}/message`)
    if (!res.ok) {
      console.error(`Failed to load messages: HTTP ${res.status}`)
      return []
    }
    const data = await res.json()
    return Array.isArray(data) ? data : (data.data || [])
  },

  // 发送消息。消息流通过 per-session runtime event stream 返回。
  async sendMessage(
    sessionId: string,
    content: string,
    files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>,
    pageContext?: RequestPagePayload
  ): Promise<{ accepted: boolean; sessionId: string; turnSnapshotId?: string; busy?: boolean }> {
    const parts: any[] = []

    if (content.trim()) {
      parts.push({ type: 'text', text: content })
    }

    if (files && files.length > 0) {
      parts.push(...files)
    }

    const res = await fetchWithDirectory(`${BASE_URL}/nine1bot/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts,
        entry: controllerEntry(pageContext),
        ...(pageContext ? { context: { page: pageContext } } : {}),
        clientCapabilities: webClientCapabilities(pageContext),
      })
    })

    if (!res.ok) {
      if (res.status === 409) {
        const error = await res.json().catch(() => ({}))
        throw new SessionBusyError(error.sessionId || error.data?.sessionID || sessionId)
      }
      throw new Error(`HTTP error! status: ${res.status}`)
    }

    return res.json()
  },

  async changeSessionModel(
    sessionId: string,
    model: { providerID: string; modelID: string }
  ): Promise<{ sessionId: string; currentModel?: SessionRuntimeSummary['currentModel']; profileSnapshotId?: string }> {
    const res = await fetchWithDirectory(`${BASE_URL}/nine1bot/agent/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    })
    if (!res.ok) {
      throw new Error(`Failed to change session model: ${res.status}`)
    }
    return res.json()
  },

  async uploadSessionFile(
    sessionId: string,
    file: File,
    options: {
      onProgress?: (progress: number) => void
      signal?: AbortSignal
    } = {}
  ): Promise<SessionUploadResponse> {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const url = applyDirectoryToUrl(`${BASE_URL}/session/${sessionId}/upload`)
      const headers = new Headers(applyDirectoryHeaders({}).headers || {})
      let settled = false

      const cleanup = () => {
        options.signal?.removeEventListener('abort', handleAbort)
      }

      const handleAbort = () => {
        if (!settled) {
          xhr.abort()
        }
      }

      options.signal?.addEventListener('abort', handleAbort, { once: true })

      xhr.open('POST', url)
      headers.forEach((value, key) => {
        xhr.setRequestHeader(key, value)
      })

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || !options.onProgress) return
        const progress = Math.min(100, Math.round((event.loaded / event.total) * 100))
        options.onProgress(progress)
      }

      xhr.onerror = () => {
        settled = true
        cleanup()
        reject(new Error('上传失败，网络连接中断'))
      }

      xhr.onabort = () => {
        settled = true
        cleanup()
        reject(new DOMException('Upload aborted', 'AbortError'))
      }

      xhr.onload = () => {
        settled = true
        cleanup()

        let payload: any = null
        try {
          payload = xhr.responseText ? JSON.parse(xhr.responseText) : null
        } catch {
          payload = null
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          options.onProgress?.(100)
          resolve(payload?.data || payload)
          return
        }

        const message =
          payload?.error ||
          payload?.message ||
          payload?.data?.error ||
          `HTTP error! status: ${xhr.status}`
        reject(new Error(message))
      }

      const formData = new FormData()
      formData.append('file', file, file.name)
      xhr.send(formData)
    })
  },

  // 中止会话
  async abortSession(sessionId: string): Promise<void> {
    await fetchWithDirectory(`${BASE_URL}/session/${sessionId}/abort`, {
      method: 'POST'
    })
  },

  // 获取所有会话状态
  async getSessionStatus(): Promise<Record<string, { type: string }>> {
    const res = await fetchWithDirectory(`${BASE_URL}/session/status`)
    const data = await res.json()
    return data
  },

  // 删除会话
  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      throw new Error(`Failed to delete session: ${res.status}`)
    }
    return true
  },

  // 更新会话（重命名、修改工作目录等）
  async updateSession(sessionId: string, updates: { title?: string; directory?: string }): Promise<Session> {
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}`, {
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
    return normalizeSession(session)
  },

  // 删除消息部分
  async deleteMessagePart(sessionId: string, messageId: string, partId: string): Promise<boolean> {
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}/message/${messageId}/part/${partId}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      throw new Error(`Failed to delete message part: ${res.status}`)
    }
    return true
  },

  // 更新消息部分
  async updateMessagePart(sessionId: string, messageId: string, partId: string, updates: { text?: string }): Promise<MessagePart> {
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}/message/${messageId}/part/${partId}`, {
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
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}/summarize`, {
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
    const res = await fetchWithDirectory(`${BASE_URL}/session/${sessionId}/todo`)
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
    return sessions.map((s: Session) => normalizeSession(s))
  },

  // 浏览目录（用于目录选择器）
  async browseDirectory(path: string = '~'): Promise<{
    kind: 'filesystem' | 'roots'
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
      eventSource = new EventSource(applyDirectoryToUrl(`${BASE_URL}/event`))

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
  },

  subscribeSessionRuntimeEvents(sessionId: string, onEvent: (event: SSEEvent) => void): EventSource {
    let eventSource: EventSource
    let reconnectAttempts = 0
    const maxReconnectAttempts = 5
    const baseReconnectDelay = 1000

    function dispatchEnvelope(raw: string) {
      try {
        const envelope = JSON.parse(raw) as RuntimeEventEnvelope
        for (const event of normalizeRuntimeEventEnvelope(envelope)) {
          onEvent(event)
        }
      } catch {
        console.warn('Failed to parse runtime event:', raw)
      }
    }

    function connect(): EventSource {
      eventSource = new EventSource(
        applyDirectoryToUrl(`${BASE_URL}/nine1bot/agent/sessions/${encodeURIComponent(sessionId)}/events`)
      )

      eventSource.onopen = () => {
        reconnectAttempts = 0
      }

      eventSource.onmessage = (e) => {
        dispatchEnvelope(e.data)
      }

      for (const eventType of RUNTIME_EVENT_TYPES) {
        eventSource.addEventListener(eventType, (e) => {
          dispatchEnvelope((e as MessageEvent).data)
        })
      }

      eventSource.onerror = (e) => {
        console.error('Runtime EventSource error:', e)

        if (eventSource.readyState === EventSource.CLOSED) {
          if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++
            const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts - 1)
            setTimeout(() => {
              if (eventSource.readyState === EventSource.CLOSED) {
                connect()
              }
            }, delay)
          } else {
            console.error('Runtime EventSource max reconnect attempts reached')
          }
        }
      }

      return eventSource
    }

    return connect()
  },

  // Subscribe global events (cross-directory / cross-instance updates)
  subscribeGlobalEvents(onEvent: (event: GlobalSSEEventEnvelope) => void): EventSource {
    let eventSource: EventSource
    let reconnectAttempts = 0
    const maxReconnectAttempts = 5
    const baseReconnectDelay = 1000

    function connect(): EventSource {
      eventSource = new EventSource(`${BASE_URL}/global/event`)

      eventSource.onopen = () => {
        reconnectAttempts = 0
      }

      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data?.payload?.type) {
            onEvent(data as GlobalSSEEventEnvelope)
          }
        } catch {
          // ignore malformed event payload
        }
      }

      eventSource.onerror = () => {
        if (eventSource.readyState === EventSource.CLOSED && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++
          const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts - 1)
          setTimeout(() => {
            if (eventSource.readyState === EventSource.CLOSED) {
              connect()
            }
          }, delay)
        }
      }

      return eventSource
    }

    return connect()
  },
}

export interface SSEEvent {
  type: string
  properties: Record<string, any>
}

export interface GlobalSSEEventEnvelope {
  directory?: string
  payload: SSEEvent
}

export const projectApi = {
  async list(): Promise<Project[]> {
    const res = await fetchWithTimeout(`${BASE_URL}/project`)
    if (!res.ok) {
      throw new Error(`Failed to list projects: ${res.status}`)
    }
    return res.json()
  },

  async current(directory?: string): Promise<Project> {
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    const suffix = params.toString() ? `?${params}` : ''
    const res = await fetchWithTimeout(`${BASE_URL}/project/current${suffix}`)
    if (!res.ok) {
      throw new Error(`Failed to discover project: ${res.status}`)
    }
    return res.json()
  },

  async get(projectID: string): Promise<Project> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}`)
    if (!res.ok) {
      throw new Error(`Failed to get project: ${res.status}`)
    }
    return res.json()
  },

  async update(projectID: string, updates: { name?: string; instructions?: string }): Promise<Project> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to update project: ${res.status}`)
    }
    return res.json()
  },

  async forget(projectID: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/forget`, {
      method: 'POST',
    })
    if (!res.ok) {
      throw new Error(`Failed to forget project: ${res.status}`)
    }
    return true
  },

  async sessions(projectID: string, opts: { roots?: boolean; search?: string; limit?: number } = {}): Promise<Session[]> {
    const params = new URLSearchParams()
    if (opts.roots !== undefined) params.set('roots', String(opts.roots))
    if (opts.search) params.set('search', opts.search)
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    const suffix = params.toString() ? `?${params}` : ''
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/session${suffix}`)
    if (!res.ok) {
      throw new Error(`Failed to list project sessions: ${res.status}`)
    }
    const sessions = await res.json()
    return (sessions || []).map((s: Session) => normalizeSession(s))
  },

  async getEnvironment(projectID: string): Promise<ProjectEnvironmentResponse> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/environment`)
    if (!res.ok) {
      throw new Error(`Failed to get project environment: ${res.status}`)
    }
    return res.json()
  },

  async replaceEnvironment(projectID: string, variables: Record<string, string>): Promise<Record<string, string>> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/environment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to update project environment: ${res.status}`)
    }
    return res.json()
  },

  async setEnvironmentKey(projectID: string, key: string, value: string): Promise<Record<string, string>> {
    const res = await fetchWithTimeout(
      `${BASE_URL}/project/${encodeURIComponent(projectID)}/environment/${encodeURIComponent(key)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      },
    )
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to set project environment variable: ${res.status}`)
    }
    return res.json()
  },

  async deleteEnvironmentKey(projectID: string, key: string): Promise<Record<string, string>> {
    const res = await fetchWithTimeout(
      `${BASE_URL}/project/${encodeURIComponent(projectID)}/environment/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to delete project environment variable: ${res.status}`)
    }
    return res.json()
  },

  async listSharedFiles(projectID: string): Promise<ProjectSharedFile[]> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/shared-files`)
    if (!res.ok) {
      throw new Error(`Failed to list project shared files: ${res.status}`)
    }
    return res.json()
  },

  async uploadSharedFile(projectID: string, payload: { filename: string; url: string; mime?: string }): Promise<ProjectSharedFile> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/shared-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to upload project shared file: ${res.status}`)
    }
    return res.json()
  },

  async deleteSharedFile(projectID: string, relativePath: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${BASE_URL}/project/${encodeURIComponent(projectID)}/shared-files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to delete project shared file: ${res.status}`)
    }
    return true
  },
}

export const webhookApi = {
  async status(): Promise<WebhookStatus> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/status`)
    if (!res.ok) {
      throw new Error(`Failed to get webhook status: ${res.status}`)
    }
    return res.json()
  },

  async sources(): Promise<WebhookSource[]> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/sources`)
    if (!res.ok) {
      throw new Error(`Failed to list webhook sources: ${res.status}`)
    }
    return res.json()
  },

  async createSource(input: WebhookSourceInput): Promise<WebhookSourceCreateResponse> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to create webhook source: ${res.status}`)
    }
    return res.json()
  },

  async updateSource(sourceID: string, input: Partial<WebhookSourceInput>): Promise<WebhookSource> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/sources/${encodeURIComponent(sourceID)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to update webhook source: ${res.status}`)
    }
    return res.json()
  },

  async refreshSecret(sourceID: string): Promise<WebhookSourceCreateResponse> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/sources/${encodeURIComponent(sourceID)}/secret/refresh`, {
      method: 'POST',
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to refresh webhook secret: ${res.status}`)
    }
    return res.json()
  },

  async deleteSource(sourceID: string): Promise<WebhookSource> {
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/sources/${encodeURIComponent(sourceID)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to delete webhook source: ${res.status}`)
    }
    return res.json()
  },

  async runs(opts: { sourceID?: string; limit?: number } = {}): Promise<WebhookRun[]> {
    const params = new URLSearchParams()
    if (opts.sourceID) params.set('sourceID', opts.sourceID)
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    const suffix = params.toString() ? `?${params}` : ''
    const res = await fetchWithTimeout(`${BASE_URL}/webhooks/runs${suffix}`)
    if (!res.ok) {
      throw new Error(`Failed to list webhook runs: ${res.status}`)
    }
    return res.json()
  },

  async sendTest(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    return {
      status: res.status,
      body,
    }
  },
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
  // 后端状态: connected, disabled, failed, needs_auth, auth_in_progress, needs_client_registration
  status:
    | 'connected'
    | 'disabled'
    | 'failed'
    | 'needs_auth'
    | 'auth_in_progress'
    | 'needs_client_registration'
    | 'connecting'
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

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface McpRemoteConfig {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig | false
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
  isCustom?: boolean
}

export interface Model {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
}

export interface AuthMethod {
  type: 'oauth' | 'api'
  name?: string
}

export interface AuthImportResult {
  sourceFound: boolean
  imported: string[]
  skippedExisting: string[]
  skippedInvalid: string[]
  totalSource: number
}

export interface CustomProviderModel {
  id: string
  name?: string
}

export interface CustomProvider {
  name: string
  protocol: 'openai' | 'anthropic'
  baseURL: string
  models: CustomProviderModel[]
  options?: {
    timeout?: number | false
    headers?: Record<string, string>
    [key: string]: any
  }
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
    const res = await fetchWithTimeout(`${BASE_URL}/mcp`)
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
    const res = await fetchWithTimeout(`${BASE_URL}/mcp`, {
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
    const res = await fetchWithTimeout(`${BASE_URL}/mcp/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to remove MCP server: ${res.status}`)
    }
  },

  // 连接 MCP 服务器
  async connect(name: string): Promise<void> {
    await fetchWithTimeout(`${BASE_URL}/mcp/${encodeURIComponent(name)}/connect`, {
      method: 'POST'
    })
  },

  // 断开 MCP 服务器
  async disconnect(name: string): Promise<void> {
    await fetchWithTimeout(`${BASE_URL}/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: 'POST'
    })
  },

  // 启动 OAuth 认证
  async startAuth(name: string): Promise<{ url: string }> {
    const res = await fetchWithTimeout(`${BASE_URL}/mcp/${encodeURIComponent(name)}/auth`, {
      method: 'POST'
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to start MCP auth: ${res.status}`)
    }
    const data = await res.json()
    return { url: data.authorizationUrl || data.url }
  },

  async removeAuth(name: string): Promise<void> {
    const res = await fetchWithTimeout(`${BASE_URL}/mcp/${encodeURIComponent(name)}/auth`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to remove MCP auth: ${res.status}`)
    }
  },

  async health(name: string): Promise<McpHealth> {
    const res = await fetchWithTimeout(`${BASE_URL}/mcp/${encodeURIComponent(name)}/health`, {
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
    const normalized: Record<string, AuthMethod[]> = {}
    for (const [providerId, methods] of Object.entries(data || {})) {
      const list = Array.isArray(methods) ? methods : []
      normalized[providerId] = list
        .map((method: any) => ({
          type: method?.type === 'apiKey' ? 'api' : method?.type,
          name: method?.name
        }))
        .filter((method: any) => method.type === 'api' || method.type === 'oauth')
    }
    return normalized
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

export const nine1botConfigApi = {
  // 获取 Nine1Bot 默认配置（nine1bot.config.jsonc）
  async get(): Promise<{ model?: string; small_model?: string; customProviders?: Record<string, CustomProvider>; configPath: string }> {
    const res = await fetchWithTimeout(`${BASE_URL}/config/nine1bot`)
    return res.json()
  },
  // 更新 Nine1Bot 默认配置
  async update(config: { model?: string; small_model?: string; customProviders?: Record<string, CustomProvider> }): Promise<void> {
    await fetchWithTimeout(`${BASE_URL}/config/nine1bot`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
  }
}

export const customProviderApi = {
  async list(): Promise<Record<string, CustomProvider>> {
    const res = await fetchWithTimeout(`${BASE_URL}/config/nine1bot/custom-providers`)
    if (!res.ok) {
      throw new Error(`Failed to load custom providers: ${res.status}`)
    }
    return res.json()
  },

  async upsert(providerId: string, provider: CustomProvider): Promise<void> {
    const res = await fetchWithTimeout(`${BASE_URL}/config/nine1bot/custom-providers/${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider)
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to save custom provider: ${res.status}`)
    }
  },

  async remove(providerId: string): Promise<void> {
    const res = await fetchWithTimeout(`${BASE_URL}/config/nine1bot/custom-providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE'
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Failed to remove custom provider: ${res.status}`)
    }
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
  async list(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/auth`)
    if (!res.ok) return []
    const data = await res.json().catch(() => [])
    return Array.isArray(data) ? data : []
  },

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

export async function importAuthFromOpencode(): Promise<AuthImportResult> {
  const res = await fetch(`${BASE_URL}/auth/import/opencode`, {
    method: 'POST'
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Failed to import auth: ${res.status}`)
  }
  return res.json()
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
    const res = await fetchWithTimeout(`${BASE_URL}/nine1bot/agent/interactions/${encodeURIComponent(requestId)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'question',
        answer: { answers }
      })
    })
    if (!res.ok) {
      throw new Error(`Question reply failed: ${res.status}`)
    }
  },

  // 拒绝问题
  async reject(requestId: string): Promise<void> {
    const res = await fetchWithTimeout(`${BASE_URL}/nine1bot/agent/interactions/${encodeURIComponent(requestId)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'question',
        answer: 'deny'
      })
    })
    if (!res.ok) {
      throw new Error(`Question reject failed: ${res.status}`)
    }
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
    const answer =
      reply === 'once'
        ? 'allow-once'
        : reply === 'always'
          ? 'allow-session'
          : 'deny'
    const res = await fetchWithTimeout(
      `${BASE_URL}/nine1bot/agent/interactions/${encodeURIComponent(requestId)}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'permission',
          answer,
          message,
        })
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
