import { stat } from 'fs/promises'
import { extname, isAbsolute, resolve } from 'path'
import { Readable } from 'stream'
import { AppType, Client, Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import type { AuthConfig, FeishuConfig } from '../config/schema'
import { FeishuBindingStore } from './store'
import { getFeishuBindingStorePath } from './store'
import type { FeishuConversationBinding, FeishuEventDedupEntry, FeishuMessageLockState } from './types'

const BUSY_TEXT = '当前会话正在处理中，请稍后再发，或发送 /new 新开会话。'
const UNSUPPORTED_TEXT = '目前飞书私聊只支持文本、图片和文件消息。'
const UNKNOWN_COMMAND_TEXT = [
  '当前支持的命令：',
  '/new 新建对话',
  '/cwd 查看当前工作目录',
  '/cwd <path> 切换工作目录并新建会话',
].join('\n')
const WEB_CONTINUE_TEXT = '这个操作需要在 web 端继续处理。'
const WELCOME_TEXT = [
  '欢迎使用 Nine1Bot 飞书私聊版。',
  '你可以直接给我发消息开始对话，也可以发送图片或文件。',
  '',
  '常用命令：',
  '/new 新建对话',
  '/cwd 查看当前工作目录',
  '/cwd <path> 切换工作目录并新建会话',
].join('\n')
const PROJECT_COMMAND_TEXT = [
  '/project 查看当前项目',
  '/project list 查看可切换的项目',
  '/project <id或名称> 切换项目并新建会话',
].join('\n')
const FEISHU_SYSTEM_PROMPT = [
  'You are replying inside a Feishu private chat.',
  'Keep replies plain text, concise, and easy to read in chat.',
  'Do not use markdown in this chat, and do not include code blocks.',
  'If a permission request or follow-up question is rejected, clearly tell the user that they need to continue in the web UI.',
].join('\n')
const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024
const FILE_LIMIT_BYTES = 10 * 1024 * 1024
const DEDUP_TTL_MS = 10 * 60 * 1000
const PROGRESS_FLUSH_MS = 2500
const EVENT_RETRY_DELAY_MS = 1000
const PROJECT_LIST_LIMIT = 12

type FeishuMessageEvent = {
  event_id?: string
  uuid?: string
  sender: {
    sender_id?: {
      open_id?: string
    }
    sender_type: string
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
  }
}

type FeishuP2PChatCreateEvent = {
  event_id?: string
  uuid?: string
  chat_id: string
  user?: {
    open_id?: string
  }
}

type IncomingAttachment = {
  filename: string
  mime: string
  url: string
}

type NormalizedMessage = {
  openId: string
  chatId: string
  messageId: string
  text: string
  attachments: IncomingAttachment[]
}

type ActiveSessionContext = FeishuMessageLockState & {
  chatId: string
  directory: string
  progressBuffer: string
  progressTimer?: ReturnType<typeof setTimeout>
  assistantMessageIds: Set<string>
  partLengths: Map<string, number>
  needsWebContinuation: boolean
}

type LocalSessionInfo = {
  id: string
  projectID: string
  directory: string
}

type LocalProjectInfo = {
  id: string
  name?: string
  worktree?: string
  rootDirectory?: string
  time?: {
    updated: number
  }
}

type AssistantResult = {
  parts: Array<{
    type: string
    text?: string
    synthetic?: boolean
  }>
}

type SessionPartPayload = {
  id: string
  type: string
  messageID: string
  sessionID: string
  synthetic?: boolean
  text?: string
}

type GlobalEventEnvelope = {
  directory?: string
  payload: {
    type: string
    properties: Record<string, any>
  }
}

type PendingPermission = {
  id: string
  sessionID: string
}

type PendingQuestion = {
  id: string
  sessionID: string
}

type FeishuLogger = {
  error: (...msg: any[]) => void | Promise<void>
  warn: (...msg: any[]) => void | Promise<void>
  info: (...msg: any[]) => void | Promise<void>
  debug: (...msg: any[]) => void | Promise<void>
  trace: (...msg: any[]) => void | Promise<void>
}

export interface FeishuServiceHandle {
  stop(): Promise<void>
}

function toBindingKey(openId: string): string {
  return `feishu:dm:${openId}`
}

function trimWrappedQuotes(input: string): string {
  if (input.length >= 2) {
    const first = input[0]
    const last = input[input.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return input.slice(1, -1)
    }
  }
  return input
}

function headerValue(headers: any, key: string): string | undefined {
  if (!headers) {
    return undefined
  }

  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()]
  if (Array.isArray(direct)) {
    return direct[0]
  }
  if (typeof direct === 'string') {
    return direct
  }
  if (typeof headers.get === 'function') {
    return headers.get(key) ?? headers.get(key.toLowerCase()) ?? undefined
  }
  return undefined
}

function sanitizeChatText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function chunkText(text: string, maxLength = 4000): string[] {
  const normalized = sanitizeChatText(text)
  if (!normalized) {
    return []
  }

  if (normalized.length <= maxLength) {
    return [normalized]
  }

  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = maxLength
    }
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) {
    chunks.push(remaining)
  }
  return chunks
}

function getProjectDisplayName(project: Pick<LocalProjectInfo, 'id' | 'name' | 'rootDirectory' | 'worktree'>): string {
  return project.name || project.rootDirectory || project.worktree || project.id
}

function getProjectDirectory(project: Pick<LocalProjectInfo, 'rootDirectory' | 'worktree'>): string | undefined {
  return project.rootDirectory || project.worktree
}

function inferMimeFromFilename(filename: string, fallback = 'application/octet-stream'): string {
  const ext = extname(filename).toLowerCase()
  const byExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
  }
  return byExt[ext] || fallback
}

function getBufferMime(headers: any, fallbackFilename: string, fallback = 'application/octet-stream'): string {
  const contentType = headerValue(headers, 'content-type')
  if (contentType) {
    return contentType.split(';')[0].trim()
  }
  return inferMimeFromFilename(fallbackFilename, fallback)
}

function extractFilenameFromDisposition(value?: string): string | undefined {
  if (!value) {
    return undefined
  }
  const match = value.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i)
  return decodeURIComponent(match?.[1] || match?.[2] || '')
}

async function readableToBuffer(stream: Readable, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limitBytes) {
      throw new Error(`Attachment exceeds limit of ${limitBytes} bytes`)
    }
    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

function getFinalAssistantText(result: AssistantResult): string {
  return sanitizeChatText(
    result.parts
      .filter((part) => part.type === 'text' && !part.synthetic)
      .map((part) => part.text || '')
      .join('\n\n'),
  )
}

async function ensureDirectoryExists(directory: string): Promise<string> {
  const stats = await stat(directory)
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`)
  }
  return directory
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class FeishuService implements FeishuServiceHandle {
  private readonly config: Required<Pick<FeishuConfig, 'appId' | 'appSecret' | 'mode'>> & FeishuConfig
  private readonly defaultDirectory: string
  private readonly store = new FeishuBindingStore()
  private readonly client: Client
  private readonly wsClient: WSClient
  private readonly localUrl: string
  private readonly authHeader?: string
  private readonly activeByOpenId = new Map<string, ActiveSessionContext>()
  private readonly activeBySessionId = new Map<string, ActiveSessionContext>()
  private readonly recentEvents = new Map<string, FeishuEventDedupEntry>()
  private stopped = false
  private eventStreamAbort?: AbortController
  private eventStreamTask?: Promise<void>

  constructor(config: FeishuConfig, options: { localUrl: string; auth?: AuthConfig }) {
    if (!config.appId || !config.appSecret) {
      throw new Error('Feishu is enabled but appId/appSecret is missing')
    }

    this.config = {
      ...config,
      appId: config.appId,
      appSecret: config.appSecret,
      mode: config.mode || 'websocket',
    }
    const baseDirectory = process.env.NINE1BOT_PROJECT_DIR || process.cwd()
    this.defaultDirectory = config.defaultDirectory
      ? (isAbsolute(config.defaultDirectory)
        ? resolve(config.defaultDirectory)
        : resolve(baseDirectory, config.defaultDirectory))
      : resolve(baseDirectory)
    this.localUrl = options.localUrl
    this.authHeader =
      options.auth?.enabled && options.auth.password
        ? `Basic ${Buffer.from(`nine1bot:${options.auth.password}`).toString('base64')}`
        : undefined

    const logger = this.createSdkLogger()
    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: AppType.SelfBuild,
      domain: Domain.Feishu,
      logger,
      loggerLevel: LoggerLevel.info,
    })

    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Domain.Feishu,
      logger,
      loggerLevel: LoggerLevel.info,
      autoReconnect: true,
    })
  }

  async start(): Promise<void> {
    await ensureDirectoryExists(this.defaultDirectory)
    this.eventStreamAbort = new AbortController()
    this.eventStreamTask = this.runGlobalEventStream(this.eventStreamAbort.signal)

    try {
      await this.wsClient.start({
        eventDispatcher: new EventDispatcher({}).register({
          p2p_chat_create: async (event: FeishuP2PChatCreateEvent) => {
            await this.handleP2PChatCreate(event)
          },
          'im.message.receive_v1': async (event: FeishuMessageEvent) => {
            await this.handleEvent(event)
          },
        }),
      })
      console.log(`[Nine1Bot] 飞书长连接已连接，绑定存储：${getFeishuBindingStorePath()}`)
    } catch (error: any) {
      this.eventStreamAbort.abort()
      console.error(`[Nine1Bot] 飞书长连接失败: ${error?.message || error}`)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true

    this.eventStreamAbort?.abort()
    await this.eventStreamTask?.catch(() => undefined)
    this.wsClient.close({ force: true })

    for (const context of this.activeByOpenId.values()) {
      if (context.progressTimer) {
        clearTimeout(context.progressTimer)
      }
    }

    this.activeByOpenId.clear()
    this.activeBySessionId.clear()
  }

  async resolveBinding(openId: string): Promise<FeishuConversationBinding> {
    const bindingKey = toBindingKey(openId)
    const existing = await this.store.get(bindingKey)
    if (existing) {
      const valid = await this.requestJson<LocalSessionInfo>(`/session/${existing.sessionId}`, {
        directory: existing.directory,
        timeoutMs: 10000,
      }).then(() => true).catch(() => false)

      if (valid) {
        return existing
      }
    }

    return this.createAndBindSession(openId, this.defaultDirectory)
  }

  async sendSessionPrompt(
    sessionId: string,
    parts: Array<{ type: 'text'; text: string } | { type: 'file'; filename: string; mime: string; url: string }>,
    directory: string,
    system = FEISHU_SYSTEM_PROMPT,
  ): Promise<AssistantResult> {
    return this.requestJson<AssistantResult>(`/session/${sessionId}/message`, {
      method: 'POST',
      directory,
      body: {
        parts,
        system,
      },
      timeoutMs: 10 * 60 * 1000,
    })
  }

  async autoHandlePendingRequests(sessionId: string, directory: string): Promise<void> {
    const permissions = await this.requestJson<PendingPermission[]>('/permission', {
      directory,
      timeoutMs: 10000,
    }).catch(() => [])

    for (const permission of permissions) {
      if (permission.sessionID !== sessionId) {
        continue
      }
      await this.requestJson<boolean>(`/permission/${permission.id}/reply`, {
        method: 'POST',
        directory,
        body: {
          reply: 'reject',
          message: WEB_CONTINUE_TEXT,
        },
        timeoutMs: 10000,
      }).catch(() => false)
    }

    const questions = await this.requestJson<PendingQuestion[]>('/question', {
      directory,
      timeoutMs: 10000,
    }).catch(() => [])

    for (const question of questions) {
      if (question.sessionID !== sessionId) {
        continue
      }
      await this.requestJson<boolean>(`/question/${question.id}/reject`, {
        method: 'POST',
        directory,
        timeoutMs: 10000,
      }).catch(() => false)
    }
  }

  async handleEvent(event: FeishuMessageEvent): Promise<void> {
    if (this.stopped) {
      return
    }

    const dedupKey = event.event_id || event.uuid || event.message?.message_id
    if (!dedupKey || this.isDuplicateEvent(dedupKey)) {
      return
    }

    const normalized = await this.normalizeEvent(event)
    if (!normalized) {
      return
    }

    if (this.activeByOpenId.has(normalized.openId)) {
      await this.replyText(normalized.chatId, BUSY_TEXT)
      return
    }

    if (normalized.text.startsWith('/')) {
      await this.handleCommand(normalized)
      return
    }

    await this.handleConversation(normalized)
  }

  async handleP2PChatCreate(event: FeishuP2PChatCreateEvent): Promise<void> {
    if (this.stopped) {
      return
    }

    const dedupKey = event.event_id || event.uuid || `p2p:${event.chat_id}:${event.user?.open_id || 'unknown'}`
    if (this.isDuplicateEvent(dedupKey)) {
      return
    }

    const openId = event.user?.open_id
    const chatId = event.chat_id
    if (!openId || !chatId) {
      return
    }

    try {
      const binding = await this.resolveBinding(openId)
      const projectName = await this.getProjectLabel(binding)
      await this.replyText(chatId, [
        WELCOME_TEXT,
        PROJECT_COMMAND_TEXT,
        '',
        `当前目录：${binding.directory}`,
        `项目：${projectName}`,
        `Session：${binding.sessionId}`,
      ].join('\n'))
    } catch (error: any) {
      console.warn(`[Nine1Bot][Feishu] failed to handle p2p_chat_create: ${error?.message || error}`)
      await this.replyText(chatId, [WELCOME_TEXT, PROJECT_COMMAND_TEXT].join('\n')).catch(() => undefined)
    }
  }

  private createSdkLogger(): FeishuLogger {
    return {
      error: (...msg: any[]) => {
        console.error('[Nine1Bot][Feishu]', ...msg)
      },
      warn: (...msg: any[]) => {
        const rendered = msg.map((item) => String(item)).join(' ')
        if (rendered.toLowerCase().includes('reconnect')) {
          console.log('[Nine1Bot] 飞书长连接重连中')
          return
        }
        console.warn('[Nine1Bot][Feishu]', ...msg)
      },
      info: (...msg: any[]) => {
        const rendered = msg.map((item) => String(item)).join(' ')
        if (rendered.toLowerCase().includes('reconnect')) {
          console.log('[Nine1Bot] 飞书长连接重连中')
        }
      },
      debug: () => {},
      trace: () => {},
    }
  }

  private isDuplicateEvent(eventId: string): boolean {
    const now = Date.now()
    for (const [key, value] of this.recentEvents) {
      if (now - value.createdAt > DEDUP_TTL_MS) {
        this.recentEvents.delete(key)
      }
    }

    if (this.recentEvents.has(eventId)) {
      return true
    }

    this.recentEvents.set(eventId, {
      eventId,
      createdAt: now,
    })
    return false
  }

  private async normalizeEvent(event: FeishuMessageEvent): Promise<NormalizedMessage | null> {
    if (event.sender?.sender_type !== 'user') {
      return null
    }

    if (event.message?.chat_type !== 'p2p') {
      return null
    }

    const openId = event.sender.sender_id?.open_id
    if (!openId) {
      return null
    }

    const chatId = event.message.chat_id
    const messageId = event.message.message_id
    const messageType = event.message.message_type
    const content = this.parseJson(event.message.content)

    if (messageType === 'text') {
      return {
        openId,
        chatId,
        messageId,
        text: sanitizeChatText(typeof content?.text === 'string' ? content.text : ''),
        attachments: [],
      }
    }

    if (messageType === 'image') {
      const imageKey = typeof content?.image_key === 'string' ? content.image_key : ''
      if (!imageKey) {
        return null
      }
      const attachment = await this.downloadMessageAttachment({
        messageId,
        resourceKey: imageKey,
        resourceType: 'image',
        fallbackFilename: `image-${messageId}.png`,
        limitBytes: IMAGE_LIMIT_BYTES,
      })
      return {
        openId,
        chatId,
        messageId,
        text: '',
        attachments: [attachment],
      }
    }

    if (messageType === 'file') {
      const fileKey = typeof content?.file_key === 'string' ? content.file_key : ''
      if (!fileKey) {
        return null
      }
      const attachment = await this.downloadMessageAttachment({
        messageId,
        resourceKey: fileKey,
        resourceType: 'file',
        fallbackFilename: content?.file_name || `file-${messageId}`,
        limitBytes: FILE_LIMIT_BYTES,
      })
      return {
        openId,
        chatId,
        messageId,
        text: '',
        attachments: [attachment],
      }
    }

    await this.replyText(chatId, UNSUPPORTED_TEXT)
    return null
  }

  private async handleCommand(message: NormalizedMessage): Promise<void> {
    const text = message.text.trim()

    if (text === '/new') {
      const binding = await this.resolveBinding(message.openId)
      const nextBinding = await this.createAndBindSession(message.openId, binding.directory)
      await this.replyText(message.chatId, [
        '已新建对话。',
        `目录：${nextBinding.directory}`,
        `Session：${nextBinding.sessionId}`,
      ].join('\n'))
      return
    }

    if (text === '/cwd') {
      const binding = await this.resolveBinding(message.openId)
      const projectName = await this.getProjectLabel(binding)
      await this.replyText(message.chatId, [
        `当前目录：${binding.directory}`,
        `项目：${projectName}`,
        `Session：${binding.sessionId}`,
      ].join('\n'))
      return
    }

    if (text.startsWith('/cwd ')) {
      const binding = await this.resolveBinding(message.openId)
      const rawInput = trimWrappedQuotes(text.slice(5).trim())
      if (!rawInput) {
        await this.replyText(message.chatId, '请提供要切换到的目录。')
        return
      }

      try {
        const targetDirectory = await this.resolveDirectoryInput(binding.directory, rawInput)
        const nextBinding = await this.createAndBindSession(message.openId, targetDirectory)
        const projectName = await this.getProjectLabel(nextBinding)
        await this.replyText(message.chatId, [
          '已切换工作目录，并为你新建了会话。',
          `当前目录：${nextBinding.directory}`,
          `项目：${projectName}`,
          `Session：${nextBinding.sessionId}`,
        ].join('\n'))
      } catch (error: any) {
        await this.replyText(message.chatId, `切换目录失败：${error?.message || error}`)
      }
      return
    }

    if (text === '/project') {
      const binding = await this.resolveBinding(message.openId)
      const project = await this.getProjectInfo(binding.projectId)
      const projectName = project ? getProjectDisplayName(project) : binding.projectId
      const projectDirectory = project ? getProjectDirectory(project) || binding.directory : binding.directory
      await this.replyText(message.chatId, [
        `当前项目：${projectName}`,
        `Project ID：${binding.projectId}`,
        `目录：${projectDirectory}`,
        `Session：${binding.sessionId}`,
      ].join('\n'))
      return
    }

    if (text === '/project list') {
      const projects = await this.listProjects()
      if (projects.length === 0) {
        await this.replyText(message.chatId, '当前没有可切换的项目。')
        return
      }

      const lines = ['可切换的项目：']
      for (const [index, project] of projects.slice(0, PROJECT_LIST_LIMIT).entries()) {
        lines.push(`${index + 1}. ${getProjectDisplayName(project)}`)
        lines.push(`ID：${project.id}`)
        lines.push(`目录：${getProjectDirectory(project) || '未提供目录信息'}`)
      }
      if (projects.length > PROJECT_LIST_LIMIT) {
        lines.push(`还有 ${projects.length - PROJECT_LIST_LIMIT} 个项目未显示，请使用更具体的 ID 或名称。`)
      }
      await this.replyText(message.chatId, lines.join('\n'))
      return
    }

    if (text.startsWith('/project ')) {
      const rawInput = trimWrappedQuotes(text.slice(9).trim())
      if (!rawInput) {
        await this.replyText(message.chatId, '请提供要切换的项目 ID 或名称。')
        return
      }

      const projects = await this.listProjects()
      const exactById = projects.find((project) => project.id === rawInput)
      if (exactById) {
        const projectDirectory = getProjectDirectory(exactById)
        if (!projectDirectory) {
          await this.replyText(message.chatId, `项目存在但缺少可用目录：${exactById.id}`)
          return
        }
        const nextBinding = await this.createAndBindSession(message.openId, projectDirectory)
        await this.replyText(message.chatId, [
          '已切换到新项目，并为你新建了会话。',
          `当前项目：${getProjectDisplayName(exactById)}`,
          `Project ID：${exactById.id}`,
          `目录：${nextBinding.directory}`,
          `Session：${nextBinding.sessionId}`,
        ].join('\n'))
        return
      }

      const exactByName = projects.filter((project) => getProjectDisplayName(project) === rawInput)
      if (exactByName.length === 1) {
        const project = exactByName[0]
        const projectDirectory = getProjectDirectory(project)
        if (!projectDirectory) {
          await this.replyText(message.chatId, `项目存在但缺少可用目录：${project.id}`)
          return
        }
        const nextBinding = await this.createAndBindSession(message.openId, projectDirectory)
        await this.replyText(message.chatId, [
          '已切换到新项目，并为你新建了会话。',
          `当前项目：${getProjectDisplayName(project)}`,
          `Project ID：${project.id}`,
          `目录：${nextBinding.directory}`,
          `Session：${nextBinding.sessionId}`,
        ].join('\n'))
        return
      }

      if (exactByName.length > 1) {
        const lines = ['匹配到多个同名项目，请改用 projectId：']
        for (const project of exactByName) {
          lines.push(`${getProjectDisplayName(project)} | ${project.id}`)
        }
        await this.replyText(message.chatId, lines.join('\n'))
        return
      }

      await this.replyText(message.chatId, `未找到匹配的项目：${rawInput}`)
      return
    }

    await this.replyText(message.chatId, [UNKNOWN_COMMAND_TEXT, PROJECT_COMMAND_TEXT].join('\n'))
  }

  private async handleConversation(message: NormalizedMessage): Promise<void> {
    let binding = await this.resolveBinding(message.openId)

    const context: ActiveSessionContext = {
      openId: message.openId,
      sessionId: binding.sessionId,
      messageId: message.messageId,
      startedAt: Date.now(),
      chatId: message.chatId,
      directory: binding.directory,
      progressBuffer: '',
      assistantMessageIds: new Set<string>(),
      partLengths: new Map<string, number>(),
      needsWebContinuation: false,
    }

    this.activeByOpenId.set(message.openId, context)
    this.activeBySessionId.set(binding.sessionId, context)

    try {
      await this.autoHandlePendingRequests(binding.sessionId, binding.directory)

      const parts: Array<{ type: 'text'; text: string } | { type: 'file'; filename: string; mime: string; url: string }> = []
      if (message.text) {
        parts.push({ type: 'text', text: message.text })
      }
      for (const attachment of message.attachments) {
        parts.push({
          type: 'file',
          filename: attachment.filename,
          mime: attachment.mime,
          url: attachment.url,
        })
      }

      if (parts.length === 0) {
        await this.replyText(message.chatId, '没有识别到可处理的消息内容。')
        return
      }

      const result = await this.sendSessionPrompt(binding.sessionId, parts, binding.directory)
      await this.flushProgress(context, true)

      let finalText = getFinalAssistantText(result)
      if (!finalText) {
        finalText = '处理完成，但这次没有生成可发送到飞书的文本结果。'
      }
      if (context.needsWebContinuation) {
        finalText = `${finalText}\n\n${WEB_CONTINUE_TEXT}`
      }
      await this.replyText(message.chatId, finalText)

      binding = {
        ...binding,
        updatedAt: Date.now(),
      }
      await this.store.set(binding)
    } catch (error: any) {
      await this.flushProgress(context, true)
      const messageText = context.needsWebContinuation
        ? WEB_CONTINUE_TEXT
        : `处理失败：${error?.message || error}`
      await this.replyText(message.chatId, messageText)
    } finally {
      if (context.progressTimer) {
        clearTimeout(context.progressTimer)
      }
      this.activeByOpenId.delete(message.openId)
      this.activeBySessionId.delete(binding.sessionId)
    }
  }

  private async createAndBindSession(openId: string, directory: string): Promise<FeishuConversationBinding> {
    const normalizedDirectory = await ensureDirectoryExists(resolve(directory))
    const session = await this.requestJson<LocalSessionInfo>('/session', {
      method: 'POST',
      directory: normalizedDirectory,
      body: {
        directory: normalizedDirectory,
      },
      timeoutMs: 30000,
    })

    const binding: FeishuConversationBinding = {
      bindingKey: toBindingKey(openId),
      openId,
      sessionId: session.id,
      directory: normalizedDirectory,
      projectId: session.projectID,
      updatedAt: Date.now(),
    }

    await this.store.set(binding)
    return binding
  }

  private async getProjectLabel(binding: FeishuConversationBinding): Promise<string> {
    const project = await this.getProjectInfo(binding.projectId)
    return project ? getProjectDisplayName(project) : binding.projectId
  }

  private async getProjectInfo(projectId: string): Promise<LocalProjectInfo | undefined> {
    return this.requestJson<LocalProjectInfo>(`/project/${encodeURIComponent(projectId)}`, {
      timeoutMs: 10000,
    }).catch(() => undefined)
  }

  private async listProjects(): Promise<LocalProjectInfo[]> {
    const projects = await this.requestJson<LocalProjectInfo[]>('/project', {
      timeoutMs: 10000,
    }).catch(() => [])
    return [...projects].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
  }

  private async resolveDirectoryInput(baseDirectory: string, input: string): Promise<string> {
    const target = isAbsolute(input) ? resolve(input) : resolve(baseDirectory, input)
    return ensureDirectoryExists(target)
  }

  private async replyText(chatId: string, text: string): Promise<void> {
    const chunks = chunkText(text)
    if (chunks.length === 0) {
      return
    }

    for (const chunk of chunks) {
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      })
    }
  }

  private async runGlobalEventStream(signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal.aborted) {
      try {
        const response = await this.request('/global/event', {
          signal,
          timeoutMs: 0,
          acceptSse: true,
        })

        if (!response.body) {
          throw new Error('Global event stream has no body')
        }

        await this.consumeSse(response.body, async (line) => {
          const parsed = this.parseJson(line) as GlobalEventEnvelope
          if (parsed?.payload?.type) {
            await this.handleServerEvent(parsed)
          }
        }, signal)
      } catch (error: any) {
        if (this.stopped || signal.aborted) {
          return
        }
        console.warn(`[Nine1Bot] Global event stream disconnected: ${error?.message || error}`)
        await sleep(EVENT_RETRY_DELAY_MS)
      }
    }
  }

  private async consumeSse(
    body: ReadableStream<Uint8Array>,
    onData: (line: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue
          }
          await onData(line.slice(6))
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async handleServerEvent(event: GlobalEventEnvelope): Promise<void> {
    const sessionId =
      event.payload?.properties?.sessionID ||
      event.payload?.properties?.part?.sessionID

    if (!sessionId) {
      return
    }

    const context = this.activeBySessionId.get(sessionId)
    if (!context) {
      return
    }

    if (event.directory) {
      context.directory = event.directory
    }

    if (event.payload.type === 'message.updated') {
      if (event.payload.properties?.info?.role === 'assistant') {
        context.assistantMessageIds.add(event.payload.properties.info.id)
      }
      return
    }

    if (event.payload.type === 'message.part.updated') {
      await this.handlePartUpdated(context, event.payload.properties as { part: SessionPartPayload; delta?: string })
      return
    }

    if (event.payload.type === 'permission.asked') {
      await this.handlePermissionAsked(context, event.payload.properties as { id: string })
      return
    }

    if (event.payload.type === 'question.asked') {
      await this.handleQuestionAsked(context, event.payload.properties as { id: string })
    }
  }

  private async handlePartUpdated(
    context: ActiveSessionContext,
    properties: {
      part: SessionPartPayload
      delta?: string
    },
  ): Promise<void> {
    const part = properties.part
    if (part.type !== 'text' || part.synthetic) {
      return
    }

    if (!context.assistantMessageIds.has(part.messageID)) {
      return
    }

    let delta = properties.delta
    if (!delta) {
      const previousLength = context.partLengths.get(part.id) || 0
      const currentLength = part.text?.length || 0
      delta = (part.text || '').slice(previousLength)
      context.partLengths.set(part.id, currentLength)
    } else {
      const currentLength = (context.partLengths.get(part.id) || 0) + delta.length
      context.partLengths.set(part.id, currentLength)
    }

    const normalized = delta?.replace(/\r\n/g, '\n') || ''
    if (!normalized.trim()) {
      return
    }

    context.progressBuffer += normalized
    if (!context.progressTimer) {
      context.progressTimer = setTimeout(() => {
        void this.flushProgress(context)
      }, PROGRESS_FLUSH_MS)
    }
  }

  private async flushProgress(context: ActiveSessionContext, force = false): Promise<void> {
    if (context.progressTimer) {
      clearTimeout(context.progressTimer)
      context.progressTimer = undefined
    }

    const content = force ? context.progressBuffer : context.progressBuffer.trim()
    if (!content) {
      return
    }

    context.progressBuffer = ''
    await this.replyText(context.chatId, sanitizeChatText(content))
  }

  private async handlePermissionAsked(
    context: ActiveSessionContext,
    properties: {
      id: string
    },
  ): Promise<void> {
    context.needsWebContinuation = true
    await this.requestJson<boolean>(`/permission/${properties.id}/reply`, {
      method: 'POST',
      directory: context.directory,
      body: {
        reply: 'reject',
        message: WEB_CONTINUE_TEXT,
      },
      timeoutMs: 10000,
    }).catch(() => false)
  }

  private async handleQuestionAsked(
    context: ActiveSessionContext,
    properties: {
      id: string
    },
  ): Promise<void> {
    context.needsWebContinuation = true
    await this.requestJson<boolean>(`/question/${properties.id}/reject`, {
      method: 'POST',
      directory: context.directory,
      timeoutMs: 10000,
    }).catch(() => false)
  }

  private async downloadMessageAttachment(input: {
    messageId: string
    resourceKey: string
    resourceType: 'image' | 'file'
    fallbackFilename: string
    limitBytes: number
  }): Promise<IncomingAttachment> {
    const response = await this.client.im.v1.messageResource.get({
      params: {
        type: input.resourceType,
      },
      path: {
        message_id: input.messageId,
        file_key: input.resourceKey,
      },
    })

    const buffer = await readableToBuffer(response.getReadableStream(), input.limitBytes)
    const disposition = headerValue(response.headers, 'content-disposition')
    const filename = extractFilenameFromDisposition(disposition) || input.fallbackFilename
    const mime = getBufferMime(response.headers, filename, input.resourceType === 'image' ? 'image/png' : 'application/octet-stream')

    return {
      filename,
      mime,
      url: `data:${mime};base64,${buffer.toString('base64')}`,
    }
  }

  private parseJson(content: string): Record<string, any> {
    try {
      return JSON.parse(content)
    } catch {
      return {}
    }
  }

  private async requestJson<T>(
    path: string,
    options: {
      method?: string
      directory?: string
      body?: unknown
      timeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    const response = await this.request(path, options)
    const text = await response.text()
    if (!text) {
      return true as T
    }
    return JSON.parse(text) as T
  }

  private async request(
    path: string,
    options: {
      method?: string
      directory?: string
      body?: unknown
      timeoutMs?: number
      signal?: AbortSignal
      acceptSse?: boolean
    } = {},
  ): Promise<Response> {
    const url = new URL(path, this.localUrl)
    const headers = new Headers()

    if (this.authHeader) {
      headers.set('authorization', this.authHeader)
    }
    if (options.directory) {
      headers.set('x-opencode-directory', options.directory)
      if (!url.searchParams.has('directory')) {
        url.searchParams.set('directory', options.directory)
      }
    }
    if (options.acceptSse) {
      headers.set('accept', 'text/event-stream')
    } else if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
    }

    const timeoutMs = options.timeoutMs ?? 30000
    const controller = new AbortController()
    const timeoutId =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
        : undefined

    const linkedAbort = () => controller.abort()
    options.signal?.addEventListener('abort', linkedAbort, { once: true })

    try {
      const response = await fetch(url.toString(), {
        method: options.method || 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(text || `Request failed: ${response.status} ${response.statusText}`)
      }

      return response
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      options.signal?.removeEventListener('abort', linkedAbort)
    }
  }
}

export async function startFeishuService(
  config: FeishuConfig,
  options: { localUrl: string; auth?: AuthConfig },
): Promise<FeishuServiceHandle | undefined> {
  if (!config.enabled) {
    return undefined
  }

  const service = new FeishuService(config, options)
  await service.start()
  return service
}
