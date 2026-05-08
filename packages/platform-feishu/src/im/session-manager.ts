import {
  FEISHU_CONTROLLER_CAPABILITIES,
  feishuControllerEntry,
  projectDirectory,
  projectDisplayName,
  type FeishuControllerBridge,
  type FeishuControllerContextBlock,
  type FeishuControllerProject,
} from './controller-bridge'
import { evaluateFeishuIMGate } from './inbound/gate'
import { isFeishuIMAbortMessage } from './abort'
import { parseFeishuRouteKey, routeKeyForFeishuMessage, serializeFeishuRouteKey, type FeishuIMRouteKey } from './route'
import type { FeishuIMBindingStore, FeishuIMSessionBinding } from './store/binding-store'
import {
  type FeishuIMAccount,
  type FeishuIMControlResult,
  type FeishuIMControllerMessagePart,
  type FeishuIMHandleMessageResult,
  type FeishuIMIncomingMessage,
  type FeishuIMNormalizedConfig,
} from './types'
import {
  FeishuIMMessageBuffer,
  type FeishuIMBufferedBatch,
  type FeishuIMBufferSnapshotEntry,
} from './buffer/message-buffer'
import { FeishuIMHistoryStore } from './history'
import type { FeishuCardActionPayload, FeishuCardActionValue } from './interactions'
import { recordFeishuIMCardAction, recordFeishuIMSessionManagerSnapshot } from './reply-telemetry'

export type FeishuIMReplySinkFactoryInput = {
  account: FeishuIMAccount
  config: FeishuIMNormalizedConfig
  routeKey: FeishuIMRouteKey
  routeKeyString: string
  binding: FeishuIMSessionBinding
  batch: FeishuIMBufferedBatch
  rootMessageId?: string
}

export type FeishuIMReplySinkHandle = {
  done?: Promise<unknown>
  start?: () => void | Promise<void>
  bindTurnSnapshotId?: (turnSnapshotId?: string) => void | Promise<void>
  stop: () => void | Promise<void>
}

export type FeishuIMImmediateReplyInput = {
  result: FeishuIMHandleMessageResult
  routeKey?: FeishuIMRouteKey
  routeKeyString?: string
  binding?: FeishuIMSessionBinding
}

export type FeishuIMActiveTurnSnapshot = {
  routeKey: FeishuIMRouteKey
  routeKeyString: string
  sessionId?: string
  turnSnapshotId?: string
  startedAt: string
}

type FeishuIMActiveTurn = FeishuIMActiveTurnSnapshot & {
  binding?: FeishuIMSessionBinding
  sink?: FeishuIMReplySinkHandle
}

export type FeishuIMSessionManagerOptions = {
  account: FeishuIMAccount
  config: FeishuIMNormalizedConfig
  controller: FeishuControllerBridge
  store: FeishuIMBindingStore
  defaultDirectory?: string
  botOpenId?: string
  botUserId?: string
  resolveDirectory?: (baseDirectory: string | undefined, input: string) => Promise<string>
  history?: FeishuIMHistoryStore
  onFlushResult?: (result: FeishuIMHandleMessageResult) => void | Promise<void>
  replySinkFactory?: (input: FeishuIMReplySinkFactoryInput) => FeishuIMReplySinkHandle | Promise<FeishuIMReplySinkHandle>
  onImmediateReply?: (input: FeishuIMImmediateReplyInput) => void | Promise<void>
}

export class FeishuIMSessionManager {
  private readonly buffer: FeishuIMMessageBuffer
  private readonly history: FeishuIMHistoryStore
  private readonly activeTurns = new Map<string, FeishuIMActiveTurn>()
  private readonly replySinks = new Set<FeishuIMReplySinkHandle>()

  constructor(private readonly options: FeishuIMSessionManagerOptions) {
    this.history = options.history ?? new FeishuIMHistoryStore()
    this.buffer = new FeishuIMMessageBuffer({
      messageBufferMs: options.config.policy.messageBufferMs,
      maxBufferMs: options.config.policy.maxBufferMs,
      onDue: async (routeKeyString) => {
        const result = await this.flushRoute(routeKeyString)
        if (result) await this.options.onFlushResult?.(result)
      },
    })
  }

  async resolveOrCreateSession(routeKey: FeishuIMRouteKey, directory?: string): Promise<FeishuIMSessionBinding> {
    const routeKeyString = serializeFeishuRouteKey(routeKey)
    const existing = await this.options.store.get(routeKeyString)
    if (existing) {
      const session = await this.options.controller.getSession({
        sessionId: existing.sessionId,
        directory: existing.directory,
      })
      if (session) return existing
    }
    return this.createAndBindSession(routeKey, directory ?? this.defaultDirectory())
  }

  async handleIncomingMessage(message: FeishuIMIncomingMessage): Promise<FeishuIMHandleMessageResult> {
    const routeKey = routeKeyForFeishuMessage(message, { accountId: this.options.account.id })
    const routeKeyString = serializeFeishuRouteKey(routeKey)
    const gate = evaluateFeishuIMGate(message, this.options.config, {
      botOpenId: this.options.botOpenId,
      botUserId: this.options.botUserId,
    })
    const bypassMentionGate = gate.action === 'history' && shouldBypassMentionGateForControl(message)

    if (gate.action === 'drop') {
      return { status: 'ignored', reason: gate.reason }
    }

    if (gate.action === 'history' && !bypassMentionGate) {
      this.history.record(routeKeyString, message)
      return { status: 'history-recorded', routeKey: routeKeyString }
    }

    if (isFeishuIMAbortMessage(message)) {
      return this.handleAbort(routeKey, routeKeyString)
    }

    const control = await this.handleControlCommand(routeKey, message)
    if (control) {
      const result = { status: 'control', routeKey: routeKeyString, control } satisfies FeishuIMHandleMessageResult
      await this.options.onImmediateReply?.({ result, routeKey, routeKeyString })
      return result
    }

    if (this.activeTurns.has(routeKeyString)) {
      const result = { status: 'busy', routeKey: routeKeyString, message: this.options.config.policy.busyRejectText } satisfies FeishuIMHandleMessageResult
      await this.options.onImmediateReply?.({ result, routeKey, routeKeyString })
      return result
    }

    const enqueued = this.buffer.enqueue({
      routeKey,
      routeKeyString,
      message,
    })
    this.recordSnapshot()
    if (enqueued.status === 'ready') {
      return await this.flushRoute(routeKeyString) ?? {
        status: 'failed',
        routeKey: routeKeyString,
        message: 'No buffered messages to flush',
      }
    }

    return {
      status: 'buffered',
      routeKey: routeKeyString,
      messageCount: enqueued.messageCount,
    }
  }

  async flushRoute(routeKeyString: string): Promise<FeishuIMHandleMessageResult | undefined> {
    const batch = this.buffer.drain(routeKeyString)
    if (!batch) return undefined
    this.recordSnapshot()
    if (this.activeTurns.has(routeKeyString)) {
      const result = { status: 'busy', routeKey: routeKeyString, message: this.options.config.policy.busyRejectText } satisfies FeishuIMHandleMessageResult
      await this.options.onImmediateReply?.({ result, routeKey: batch.routeKey, routeKeyString })
      return result
    }
    this.activeTurns.set(routeKeyString, {
      routeKey: batch.routeKey,
      routeKeyString,
      startedAt: new Date().toISOString(),
    })
    this.recordSnapshot()
    let releaseOnFinally = true
    let sink: FeishuIMReplySinkHandle | undefined
    try {
      const binding = await this.resolveOrCreateSession(batch.routeKey)
      this.updateActiveTurn(routeKeyString, { binding, sessionId: binding.sessionId })
      sink = await this.options.replySinkFactory?.({
        account: this.options.account,
        config: this.options.config,
        routeKey: batch.routeKey,
        routeKeyString,
        binding,
        batch,
        rootMessageId: batch.messages.at(-1)?.messageId,
      })
      if (sink) {
        this.replySinks.add(sink)
        this.updateActiveTurn(routeKeyString, { sink })
        await sink.start?.()
      }
      const response = await this.options.controller.sendMessage({
        sessionId: binding.sessionId,
        directory: binding.directory,
        messageId: batch.messages.at(-1)?.messageId,
        parts: partsFromBatch(batch),
        contextBlocks: this.contextBlocksForBatch(batch),
        entry: feishuControllerEntry(batch.messages.at(-1)?.eventId),
      })

      if (!response.accepted || response.busy) {
        await this.stopReplySink(sink)
        const result = { status: 'busy', routeKey: routeKeyString, message: this.options.config.policy.busyRejectText } satisfies FeishuIMHandleMessageResult
        await this.options.onImmediateReply?.({ result, routeKey: batch.routeKey, routeKeyString, binding })
        return result
      }

      await this.options.store.set(routeKeyString, {
        ...binding,
        updatedAt: new Date().toISOString(),
      })
      this.updateActiveTurn(routeKeyString, { turnSnapshotId: response.turnSnapshotId })
      await sink?.bindTurnSnapshotId?.(response.turnSnapshotId)
      if (sink?.done) {
        const activeSink = sink
        releaseOnFinally = false
        void activeSink.done!.finally(() => {
          this.replySinks.delete(activeSink)
          this.activeTurns.delete(routeKeyString)
          this.recordSnapshot()
        })
      }
      return {
        status: 'accepted',
        routeKey: routeKeyString,
        sessionId: binding.sessionId,
        turnSnapshotId: response.turnSnapshotId,
      }
    } catch (error) {
      await this.stopReplySink(sink)
      const result = {
        status: 'failed',
        routeKey: routeKeyString,
        message: error instanceof Error ? error.message : String(error),
      } satisfies FeishuIMHandleMessageResult
      await this.options.onImmediateReply?.({ result, routeKey: batch.routeKey, routeKeyString })
      return result
    } finally {
      if (releaseOnFinally) {
        this.activeTurns.delete(routeKeyString)
        this.recordSnapshot()
      }
    }
  }

  async handleAbort(
    routeKey: FeishuIMRouteKey,
    routeKeyString = serializeFeishuRouteKey(routeKey),
    options: { notify?: boolean } = {},
  ): Promise<FeishuIMHandleMessageResult> {
    const notify = options.notify ?? true
    const pending = this.buffer.discard(routeKeyString)
    if (pending) {
      this.recordSnapshot()
      const result = {
        status: 'buffer-cancelled',
        routeKey: routeKeyString,
        messageCount: pending.messages.length,
        message: '已取消尚未发送到 Agent 的飞书消息。',
      } satisfies FeishuIMHandleMessageResult
      if (notify) await this.options.onImmediateReply?.({ result, routeKey, routeKeyString })
      return result
    }

    const active = this.activeTurns.get(routeKeyString)
    if (!active?.sessionId) {
      const result = {
        status: 'abort-noop',
        routeKey: routeKeyString,
        message: '当前飞书会话没有正在运行的 Agent turn。',
      } satisfies FeishuIMHandleMessageResult
      if (notify) await this.options.onImmediateReply?.({ result, routeKey, routeKeyString })
      return result
    }

    try {
      const aborted = await this.options.controller.abortSession({
        sessionId: active.sessionId,
        directory: active.binding?.directory,
        reason: 'feishu-im-abort',
      })
      if (!aborted) {
        const result = {
          status: 'failed',
          routeKey: routeKeyString,
          message: 'Controller rejected abort request',
        } satisfies FeishuIMHandleMessageResult
        if (notify) await this.options.onImmediateReply?.({ result, routeKey, routeKeyString, binding: active.binding })
        return result
      }
      await this.stopReplySink(active.sink)
      this.activeTurns.delete(routeKeyString)
      this.recordSnapshot()
      const result = {
        status: 'aborted',
        routeKey: routeKeyString,
        sessionId: active.sessionId,
        turnSnapshotId: active.turnSnapshotId,
        message: '已取消当前飞书会话的 Agent turn。',
      } satisfies FeishuIMHandleMessageResult
      if (notify) await this.options.onImmediateReply?.({ result, routeKey, routeKeyString, binding: active.binding })
      return result
    } catch (error) {
      const result = {
        status: 'failed',
        routeKey: routeKeyString,
        message: error instanceof Error ? error.message : String(error),
      } satisfies FeishuIMHandleMessageResult
      if (notify) await this.options.onImmediateReply?.({ result, routeKey, routeKeyString, binding: active.binding })
      return result
    }
  }

  async resetRoute(routeKey: FeishuIMRouteKey): Promise<FeishuIMSessionBinding> {
    const current = await this.options.store.get(serializeFeishuRouteKey(routeKey))
    return this.createAndBindSession(routeKey, current?.directory ?? this.defaultDirectory())
  }

  async switchDirectory(routeKey: FeishuIMRouteKey, input: string): Promise<FeishuIMSessionBinding> {
    const current = await this.options.store.get(serializeFeishuRouteKey(routeKey))
    const directory = await this.resolveDirectory(current?.directory ?? this.defaultDirectory(), input)
    return this.createAndBindSession(routeKey, directory)
  }

  async switchProject(routeKey: FeishuIMRouteKey, input: string): Promise<FeishuIMSessionBinding & { project: FeishuControllerProject }> {
    const projects = await this.sortedProjects()
    const project = matchProject(projects, input)
    if (!project) throw new Error(`Project not found: ${input}`)
    const directory = projectDirectory(project)
    if (!directory) throw new Error(`Project has no usable directory: ${project.id}`)
    const binding = await this.createAndBindSession(routeKey, directory)
    return { ...binding, project }
  }

  async handleCardAction(payload: FeishuCardActionPayload, value: FeishuCardActionValue = {}): Promise<FeishuIMControlResult> {
    recordFeishuIMCardAction(payload.action)
    if (payload.accountId !== this.options.account.id) {
      return { type: 'failed', command: payload.action, message: 'Card action account does not match this IM account' }
    }
    const routeKey = parseFeishuRouteKey(payload.routeKey)
    if (!routeKey) {
      return { type: 'failed', command: payload.action, message: 'Card action route is invalid' }
    }
    const current = await this.options.store.get(payload.routeKey)
    if (payload.sessionId && current?.sessionId && payload.sessionId !== current.sessionId && payload.action !== 'control.newSession') {
      return { type: 'failed', command: payload.action, message: 'Card action session is no longer current' }
    }

    try {
      if (payload.action === 'turn.abort') {
        const active = this.activeTurns.get(payload.routeKey)
        if (!active?.sessionId) {
          return { type: 'failed', command: payload.action, message: 'Card action route has no active turn' }
        }
        if (payload.sessionId && payload.sessionId !== active.sessionId) {
          return { type: 'failed', command: payload.action, message: 'Card action session is no longer active' }
        }
        if (!payload.turnSnapshotId || payload.turnSnapshotId !== active.turnSnapshotId) {
          return { type: 'failed', command: payload.action, message: 'Card action turn is no longer active' }
        }
        const result = await this.handleAbort(routeKey, payload.routeKey, { notify: false })
        if (result.status === 'aborted') {
          return {
            type: 'turn-aborted',
            sessionId: result.sessionId,
            turnSnapshotId: result.turnSnapshotId,
            message: result.message,
          }
        }
        return {
          type: 'failed',
          command: payload.action,
          message: 'message' in result ? result.message : 'Abort did not complete',
        }
      }
      if (payload.action === 'control.newSession') {
        const binding = await this.resetRoute(routeKey)
        return {
          type: 'new-session',
          sessionId: binding.sessionId,
          directory: binding.directory,
          projectId: binding.projectId,
        }
      }
      if (payload.action === 'control.projectList') {
        const projects = await this.sortedProjects()
        return {
          type: 'project-list',
          projects: projects.map((project) => ({
            id: project.id,
            name: projectDisplayName(project),
            directory: projectDirectory(project),
          })),
        }
      }
      if (payload.action === 'control.switchProject') {
        const projectId = value.projectId ?? value.value
        if (!projectId) return { type: 'failed', command: payload.action, message: 'Project id is required' }
        const binding = await this.switchProject(routeKey, projectId)
        return {
          type: 'project-switched',
          sessionId: binding.sessionId,
          projectId: binding.project.id,
          projectName: projectDisplayName(binding.project),
          directory: binding.directory ?? projectDirectory(binding.project) ?? '',
        }
      }
      if (payload.action === 'control.showCwd') {
        const binding = await this.resolveOrCreateSession(routeKey)
        return {
          type: 'cwd-current',
          sessionId: binding.sessionId,
          directory: binding.directory,
          projectId: binding.projectId,
        }
      }
      if (payload.action === 'control.help' || payload.action === 'control.openWeb') {
        return { type: 'help', commands: CONTROL_COMMANDS }
      }
    } catch (error) {
      return { type: 'failed', command: payload.action, message: error instanceof Error ? error.message : String(error) }
    }

    return { type: 'failed', command: payload.action, message: 'Unsupported control card action' }
  }

  stop() {
    this.buffer.clear()
    for (const sink of this.replySinks) {
      void this.stopReplySink(sink)
    }
    this.replySinks.clear()
    this.activeTurns.clear()
    this.recordSnapshot()
  }

  activeTurnSnapshot(): FeishuIMActiveTurnSnapshot[] {
    this.recordSnapshot()
    return [...this.activeTurns.values()].map((turn) => ({
      routeKey: { ...turn.routeKey },
      routeKeyString: turn.routeKeyString,
      sessionId: turn.sessionId,
      turnSnapshotId: turn.turnSnapshotId,
      startedAt: turn.startedAt,
    }))
  }

  bufferSnapshot(): FeishuIMBufferSnapshotEntry[] {
    this.recordSnapshot()
    return this.buffer.snapshot()
  }

  private async handleControlCommand(
    routeKey: FeishuIMRouteKey,
    message: FeishuIMIncomingMessage,
  ): Promise<FeishuIMControlResult | undefined> {
    const text = message.text?.trim()
    if (!text?.startsWith('/')) return undefined

    if (text === '/control') {
      const binding = await this.resolveOrCreateSession(routeKey)
      const project = binding.projectId ? await this.options.controller.getProject(binding.projectId) : undefined
      return {
        type: 'control-panel',
        sessionId: binding.sessionId,
        routeKey: serializeFeishuRouteKey(routeKey),
        projectId: binding.projectId,
        projectName: project ? projectDisplayName(project) : undefined,
        directory: project ? projectDirectory(project) ?? binding.directory : binding.directory,
      }
    }

    if (text === '/help') {
      return { type: 'help', commands: CONTROL_COMMANDS }
    }

    if (text === '/new') {
      const binding = await this.resetRoute(routeKey)
      return {
        type: 'new-session',
        sessionId: binding.sessionId,
        directory: binding.directory,
        projectId: binding.projectId,
      }
    }

    if (text === '/cwd') {
      const binding = await this.resolveOrCreateSession(routeKey)
      return {
        type: 'cwd-current',
        sessionId: binding.sessionId,
        directory: binding.directory,
        projectId: binding.projectId,
      }
    }

    if (text.startsWith('/cwd ')) {
      const raw = trimWrappedQuotes(text.slice(5).trim())
      if (!raw) return { type: 'failed', command: '/cwd', message: 'Directory is required' }
      try {
        const binding = await this.switchDirectory(routeKey, raw)
        return {
          type: 'cwd-switched',
          sessionId: binding.sessionId,
          directory: binding.directory ?? raw,
          projectId: binding.projectId,
        }
      } catch (error) {
        return { type: 'failed', command: '/cwd', message: error instanceof Error ? error.message : String(error) }
      }
    }

    if (text === '/project') {
      const binding = await this.resolveOrCreateSession(routeKey)
      const project = binding.projectId ? await this.options.controller.getProject(binding.projectId) : undefined
      return {
        type: 'project-current',
        sessionId: binding.sessionId,
        projectId: binding.projectId,
        projectName: project ? projectDisplayName(project) : undefined,
        directory: project ? projectDirectory(project) ?? binding.directory : binding.directory,
      }
    }

    if (text === '/project list') {
      const projects = await this.sortedProjects()
      return {
        type: 'project-list',
        projects: projects.map((project) => ({
          id: project.id,
          name: projectDisplayName(project),
          directory: projectDirectory(project),
        })),
      }
    }

    if (text.startsWith('/project ')) {
      const raw = trimWrappedQuotes(text.slice(9).trim())
      if (!raw) return { type: 'failed', command: '/project', message: 'Project id or name is required' }
      try {
        const binding = await this.switchProject(routeKey, raw)
        return {
          type: 'project-switched',
          sessionId: binding.sessionId,
          projectId: binding.project.id,
          projectName: projectDisplayName(binding.project),
          directory: binding.directory ?? projectDirectory(binding.project) ?? '',
        }
      } catch (error) {
        return { type: 'failed', command: '/project', message: error instanceof Error ? error.message : String(error) }
      }
    }

    return {
      type: 'unknown-command',
      command: text,
    }
  }

  private async createAndBindSession(routeKey: FeishuIMRouteKey, directory?: string): Promise<FeishuIMSessionBinding> {
    const created = await this.options.controller.createSession({
      title: titleForRoute(routeKey),
      directory,
      entry: feishuControllerEntry(),
    })
    const binding: FeishuIMSessionBinding = {
      routeKey,
      sessionId: created.session.id,
      directory: created.session.directory || directory,
      projectId: created.session.projectID,
      updatedAt: new Date().toISOString(),
    }
    await this.options.store.set(serializeFeishuRouteKey(routeKey), binding)
    return binding
  }

  private contextBlocksForBatch(batch: FeishuIMBufferedBatch): FeishuControllerContextBlock[] {
    const history = this.history.list(batch.routeKeyString)
    const blocks: FeishuControllerContextBlock[] = [{
      id: 'platform:feishu-im-route',
      layer: 'platform',
      source: 'feishu-im.route',
      enabled: true,
      priority: 68,
      lifecycle: 'turn',
      visibility: 'system-required',
      mergeKey: batch.routeKeyString,
      content: renderRoute(batch.routeKey),
    }, {
      id: 'turn:feishu-im-batch',
      layer: 'turn',
      source: 'feishu-im.batch',
      enabled: true,
      priority: 66,
      lifecycle: 'turn',
      visibility: 'system-required',
      mergeKey: batch.routeKeyString,
      content: renderMessages('Feishu messages in this turn', batch.messages),
    }]

    if (history.length > 0) {
      blocks.push({
        id: 'turn:feishu-im-history',
        layer: 'turn',
        source: 'feishu-im.group-history',
        enabled: true,
        priority: 58,
        lifecycle: 'turn',
        visibility: 'developer-toggle',
        mergeKey: `${batch.routeKeyString}:history`,
        content: renderMessages('Recent Feishu group history', history),
      })
    }

    return blocks
  }

  private async sortedProjects(): Promise<FeishuControllerProject[]> {
    const projects = await this.options.controller.listProjects()
    return [...projects].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
  }

  private defaultDirectory(): string | undefined {
    return this.options.account.defaultDirectory ?? this.options.defaultDirectory
  }

  private async resolveDirectory(baseDirectory: string | undefined, input: string): Promise<string> {
    return this.options.resolveDirectory
      ? this.options.resolveDirectory(baseDirectory, input)
      : input
  }

  private async stopReplySink(sink: FeishuIMReplySinkHandle | undefined): Promise<void> {
    if (!sink) return
    this.replySinks.delete(sink)
    await sink.stop()
  }

  private updateActiveTurn(routeKeyString: string, patch: Partial<FeishuIMActiveTurn>) {
    const current = this.activeTurns.get(routeKeyString)
    if (!current) return
    this.activeTurns.set(routeKeyString, {
      ...current,
      ...patch,
    })
    this.recordSnapshot()
  }

  private recordSnapshot() {
    recordFeishuIMSessionManagerSnapshot({
      activeTurns: this.activeTurns.size,
      pendingBuffers: this.buffer.routeCount(),
      bufferedMessages: this.buffer.messageCount(),
    })
  }
}

const CONTROL_COMMANDS = [
  '/control',
  '/new',
  '/cwd',
  '/cwd <path>',
  '/project',
  '/project list',
  '/project <id或名称>',
]

function shouldBypassMentionGateForControl(message: FeishuIMIncomingMessage): boolean {
  const text = message.text?.trim()
  if (!text?.startsWith('/')) return false
  return isRecognizedControlCommandText(text) || isFeishuIMAbortMessage(message)
}

function isRecognizedControlCommandText(text: string): boolean {
  return (
    text === '/control' ||
    text === '/help' ||
    text === '/new' ||
    text === '/cwd' ||
    text.startsWith('/cwd ') ||
    text === '/project' ||
    text === '/project list' ||
    text.startsWith('/project ')
  )
}

function partsFromBatch(batch: FeishuIMBufferedBatch): FeishuIMControllerMessagePart[] {
  return [{
    type: 'text',
    text: renderUserMessages(batch.messages),
  }]
}

function renderUserMessages(messages: FeishuIMIncomingMessage[]): string {
  return messages
    .map((message) => message.text?.trim() || `[${message.messageType}]`)
    .filter(Boolean)
    .join('\n\n')
}

function renderRoute(routeKey: FeishuIMRouteKey): string {
  return [
    'Platform: Feishu/Lark IM',
    `Account: ${routeKey.accountId}`,
    `Route: ${serializeFeishuRouteKey(routeKey)}`,
    `Chat: ${routeKey.chatId}`,
    routeKey.openId ? `Open ID: ${routeKey.openId}` : undefined,
    routeKey.threadId ? `Thread: ${routeKey.threadId}` : undefined,
    `Controller capabilities: ${Object.keys(FEISHU_CONTROLLER_CAPABILITIES).join(', ')}`,
  ].filter(Boolean).join('\n')
}

function renderMessages(title: string, messages: FeishuIMIncomingMessage[]): string {
  return [
    `${title}:`,
    '',
    ...messages.map((message, index) => [
      `[${index + 1}] ${senderLabel(message)}, ${timeLabel(message)}, message_id: ${message.messageId}`,
      message.text || `[${message.messageType}]`,
    ].join('\n')),
  ].join('\n\n')
}

function senderLabel(message: FeishuIMIncomingMessage): string {
  return message.sender.name || message.sender.openId || message.sender.userId || message.sender.unionId || 'unknown sender'
}

function timeLabel(message: FeishuIMIncomingMessage): string {
  return message.createTime ? new Date(message.createTime).toISOString() : 'unknown time'
}

function titleForRoute(routeKey: FeishuIMRouteKey): string {
  if (routeKey.kind === 'dm') return `Feishu DM ${routeKey.openId || routeKey.chatId}`
  if (routeKey.kind === 'thread') return `Feishu thread ${routeKey.threadId || routeKey.chatId}`
  return `Feishu group ${routeKey.chatId}`
}

function matchProject(projects: FeishuControllerProject[], input: string): FeishuControllerProject | undefined {
  const byId = projects.find((project) => project.id === input)
  if (byId) return byId
  const byName = projects.filter((project) => projectDisplayName(project) === input)
  return byName.length === 1 ? byName[0] : undefined
}

function trimWrappedQuotes(input: string): string {
  const trimmed = input.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}
