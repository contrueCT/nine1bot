import type { FeishuRuntimeEventEnvelope } from './controller-bridge'
import {
  FEISHU_STREAMING_CARD_CONTENT_ELEMENT_ID,
  FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID,
  renderFeishuStreamingCardKitFinalCard,
  renderFeishuStreamingCardKitInitialCard,
  renderFeishuStreamingTurnCard,
  type FeishuStreamingToolStatus,
  type FeishuTurnCardStatus,
} from './cards'
import type { FeishuIMRouteKey } from './route'
import {
  type FeishuIMReplyClient,
  type FeishuIMReplyDelivery,
  type FeishuIMSentMessage,
} from './reply-client'
import {
  recordFeishuIMCardUpdateFailure,
  recordFeishuIMStreamingFallback,
  recordFeishuIMStreamingTransport,
} from './reply-telemetry'

const PATCH_FALLBACK_UPDATE_MS = 1_500

type FeishuStreamingCardPhase =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'final'
  | 'error'
  | 'timeout'
  | 'aborted'
  | 'fallback'

type FeishuStreamingTransport = 'cardkit' | 'patch' | 'text'

export type FeishuStreamingCardControllerOptions = {
  accountId: string
  routeKey: FeishuIMRouteKey
  sessionId: string
  turnSnapshotId?: string
  client: FeishuIMReplyClient
  delivery: FeishuIMReplyDelivery
  updateMs?: number
  maxChars?: number
  continueUrl?: string
  onError?: (error: Error) => void | Promise<void>
}

export class FeishuStreamingCardController {
  private phase: FeishuStreamingCardPhase = 'idle'
  private transport: FeishuStreamingTransport | undefined
  private cardEntityId?: string
  private sentCard?: FeishuIMSentMessage
  private sequence = 0
  private textBuffer = ''
  private resourceFailure?: string
  private errorMessage?: string
  private fallbackReason?: string
  private fallbackTextSent = false
  private terminal = false
  private flushInProgress = false
  private reflushRequested = false
  private flushTimer?: ReturnType<typeof setTimeout>
  private lastFlushAt = 0
  private patchContentFlushed = false
  private readonly tools = new Map<string, FeishuStreamingToolStatus>()

  constructor(private readonly options: FeishuStreamingCardControllerOptions) {}

  async start(turnSnapshotId?: string): Promise<void> {
    if (turnSnapshotId !== undefined) this.options.turnSnapshotId = turnSnapshotId
    if (this.phase !== 'idle') return
    await this.ensureRunningTransport()
    if (this.transport === 'patch' && !this.sentCard?.messageId && !this.sentCard?.cardId) {
      await this.flushPatch('running')
      this.lastFlushAt = Date.now()
    }
  }

  async appendText(text: string): Promise<void> {
    if (!text || this.terminal) return
    this.textBuffer += text
    await this.scheduleRunningFlush()
  }

  clearText(): void {
    this.textBuffer = ''
    this.patchContentFlushed = false
    this.lastFlushAt = 0
    this.clearTimer()
  }

  replaceText(text: string): void {
    this.textBuffer = text
    this.patchContentFlushed = false
    this.lastFlushAt = 0
    this.clearTimer()
  }

  async handleRuntimeEvent(event: FeishuRuntimeEventEnvelope): Promise<boolean> {
    const tool = toolStatusFromEvent(event)
    if (!tool) return false
    this.tools.set(tool.id, tool)
    this.patchContentFlushed = false
    this.lastFlushAt = 0
    this.clearTimer()
    await this.scheduleRunningFlush()
    return true
  }

  async setResourceFailure(message: string): Promise<void> {
    if (this.terminal) return
    this.resourceFailure = message
    await this.flushNow('running')
  }

  async finish(status: Exclude<FeishuTurnCardStatus, 'running'>, message?: string): Promise<void> {
    if (this.terminal) return
    this.terminal = true
    this.phase = status
    if (status === 'error' || status === 'timeout') {
      this.errorMessage = message ?? (status === 'timeout' ? '飞书回复等待超时，请在 Web 端继续。' : '处理失败。')
    }
    this.clearTimer()
    await this.flushNow(status)
  }

  stop(): void {
    this.terminal = true
    this.phase = 'aborted'
    this.clearTimer()
  }

  private async ensureRunningTransport(): Promise<void> {
    if (this.transport) return
    const capabilities = this.options.client
    if (
      capabilities.createCardEntity &&
      capabilities.sendCardEntity &&
      capabilities.streamCardContent &&
      capabilities.updateCardEntity &&
      capabilities.setCardStreamingMode
    ) {
      this.transport = 'cardkit'
      recordFeishuIMStreamingTransport('cardkit')
      await this.createCardKitCard()
      return
    }
    this.transport = 'patch'
    recordFeishuIMStreamingTransport('patch')
  }

  private async createCardKitCard(): Promise<void> {
    if (this.cardEntityId) return
    this.phase = 'creating'
    try {
      const entity = await this.options.client.createCardEntity!({
        card: renderFeishuStreamingCardKitInitialCard(this.cardInput('running')),
      })
      this.cardEntityId = entity.cardId
      this.sentCard = await this.options.client.sendCardEntity!({
        ...this.options.delivery,
        cardId: entity.cardId,
      })
      this.phase = 'streaming'
      this.lastFlushAt = Date.now()
    } catch (error) {
      await this.fallbackToPatch(error, 'cardkit create failed')
    }
  }

  private async scheduleRunningFlush(): Promise<void> {
    if (this.terminal) return
    await this.ensureRunningTransport()
    const throttleMs = this.transport === 'patch'
      ? this.patchUpdateMs()
      : Math.max(1, this.options.updateMs ?? 1_000)
    const now = Date.now()
    const elapsed = now - this.lastFlushAt
    if (elapsed >= throttleMs) {
      this.clearTimer()
      await this.flushNow('running')
      return
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushNow('running').catch((error) => {
        recordFeishuIMCardUpdateFailure(error)
      })
    }, Math.max(1, throttleMs - elapsed))
    this.flushTimer.unref?.()
  }

  private async flushNow(status: FeishuTurnCardStatus): Promise<void> {
    if (this.flushInProgress) {
      this.reflushRequested = true
      return
    }
    this.flushInProgress = true
    this.reflushRequested = false
    try {
      await this.ensureRunningTransport()
      if (this.transport === 'cardkit') {
        await this.flushCardKit(status)
      } else if (this.transport === 'patch') {
        await this.flushPatch(status)
      } else {
        await this.flushText(status)
      }
      this.lastFlushAt = Date.now()
    } finally {
      this.flushInProgress = false
      if (this.reflushRequested && !this.terminal) {
        this.reflushRequested = false
        await this.scheduleRunningFlush()
      }
    }
  }

  private async flushCardKit(status: FeishuTurnCardStatus): Promise<void> {
    if (!this.cardEntityId) {
      await this.createCardKitCard()
      if (this.transport !== 'cardkit' || !this.cardEntityId) {
        await this.flushPatch(status)
        return
      }
    }
    try {
      if (status === 'running') {
        await this.options.client.streamCardContent!({
          cardId: this.cardEntityId,
          elementId: FEISHU_STREAMING_CARD_CONTENT_ELEMENT_ID,
          content: this.visibleText() || '正在等待 Agent 输出...',
          sequence: this.nextSequence(),
        })
        await this.options.client.streamCardContent!({
          cardId: this.cardEntityId,
          elementId: FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID,
          content: this.runningToolStatusText(),
          sequence: this.nextSequence(),
        })
        return
      }
      await this.options.client.updateCardEntity!({
        cardId: this.cardEntityId,
        card: renderFeishuStreamingCardKitFinalCard(this.cardInput(status)),
        sequence: this.nextSequence(),
      })
      await this.options.client.setCardStreamingMode!({
        cardId: this.cardEntityId,
        streaming: false,
        sequence: this.nextSequence(),
      })
    } catch (error) {
      await this.fallbackToPatch(error, `cardkit ${status === 'running' ? 'content' : 'final'} failed`)
      await this.flushPatch(status)
    }
  }

  private async flushPatch(status: FeishuTurnCardStatus): Promise<void> {
    try {
      await this.ensurePatchCard(status)
    } catch (error) {
      await this.fallbackToText(error, 'message patch failed')
      await this.flushText(status)
    }
  }

  private async ensurePatchCard(status: FeishuTurnCardStatus): Promise<void> {
    const card = renderFeishuStreamingTurnCard(this.cardInput(status))
    if (!this.sentCard?.messageId && !this.sentCard?.cardId) {
      this.sentCard = await this.options.client.sendCard({
        ...this.options.delivery,
        card,
      })
      this.phase = this.phase === 'idle' ? 'streaming' : this.phase
      this.markPatchProgressFlushed(status)
      return
    }
    this.sentCard = await this.options.client.updateCard({
      messageId: this.sentCard.messageId,
      cardId: this.sentCard.cardId,
      card,
    })
    this.markPatchProgressFlushed(status)
  }

  private async flushText(status: FeishuTurnCardStatus): Promise<void> {
    if (!this.fallbackTextSent) {
      this.fallbackTextSent = true
      await this.sendFallbackText()
    }
    if (status === 'running') return
    const text = this.visibleText()
      || this.errorMessage
      || (status === 'final' ? '已完成。' : '飞书回复已结束，请在 Web 端继续。')
    await this.options.client.sendText({
      ...this.options.delivery,
      text,
    }).catch((error) => {
      recordFeishuIMCardUpdateFailure(error)
    })
  }

  private async fallbackToPatch(error: unknown, reason: string): Promise<void> {
    const normalized = normalizeError(error)
    recordFeishuIMCardUpdateFailure(normalized)
    recordFeishuIMStreamingFallback(reason, 'patch')
    await this.options.onError?.(normalized)
    this.transport = 'patch'
    this.phase = 'fallback'
    this.fallbackReason = reason
    this.cardEntityId = undefined
    recordFeishuIMStreamingTransport('patch')
  }

  private async fallbackToText(error: unknown, reason: string): Promise<void> {
    const normalized = normalizeError(error)
    recordFeishuIMCardUpdateFailure(normalized)
    recordFeishuIMStreamingFallback(reason, 'text')
    await this.options.onError?.(normalized)
    this.transport = 'text'
    this.phase = 'fallback'
    this.fallbackReason = reason
    recordFeishuIMStreamingTransport('text')
  }

  private async sendFallbackText(): Promise<void> {
    await this.options.client.sendText({
      ...this.options.delivery,
      text: '飞书流式卡片更新失败，可以在 Web 端继续查看。',
    }).catch((error) => {
      recordFeishuIMCardUpdateFailure(error)
    })
  }

  private cardInput(status: FeishuTurnCardStatus) {
    return {
      accountId: this.options.accountId,
      status,
      routeKey: this.options.routeKey,
      sessionId: this.options.sessionId,
      turnSnapshotId: this.options.turnSnapshotId,
      continueUrl: this.options.continueUrl,
      content: this.visibleText() || undefined,
      error: this.errorMessage,
      resourceFailure: this.resourceFailure,
      maxChars: this.options.maxChars ?? 6_000,
      tools: status === 'running' ? this.runningTools() : undefined,
      transport: this.transport,
      fallbackReason: this.fallbackReason,
    }
  }

  private runningTools(): FeishuStreamingToolStatus[] {
    return [...this.tools.values()].filter((tool) => tool.status === 'running')
  }

  private runningToolStatusText(): string {
    const tools = this.runningTools()
    return tools.length > 0 ? renderRunningToolStatusLines(tools) : ''
  }

  private visibleText(): string {
    const text = this.textBuffer.trim()
    const maxChars = this.options.maxChars ?? 6_000
    if (!text || text.length <= maxChars) return text
    return `${text.slice(0, maxChars).trimEnd()}\n\n...`
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  private patchUpdateMs(): number {
    const base = Math.max(1, this.options.updateMs ?? 1_000)
    return this.patchContentFlushed ? Math.max(PATCH_FALLBACK_UPDATE_MS, base) : base
  }

  private markPatchProgressFlushed(status: FeishuTurnCardStatus): void {
    if (status !== 'running') return
    if (this.visibleText() || this.tools.size > 0 || this.resourceFailure) {
      this.patchContentFlushed = true
    }
  }

  private clearTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }
}

function toolStatusFromEvent(event: FeishuRuntimeEventEnvelope): FeishuStreamingToolStatus | undefined {
  const data = eventData(event)
  if (event.type === 'runtime.tool.started') {
    const id = stringValue(data.toolCallId) ?? stringValue(data.partID) ?? stringValue(data.partId)
    const name = stringValue(data.tool)
    if (!id || !name) return undefined
    return {
      id,
      name,
      status: 'running',
      detail: summarizeValue(data.input),
    }
  }
  if (event.type === 'runtime.tool.completed') {
    const id = stringValue(data.toolCallId) ?? stringValue(data.partID) ?? stringValue(data.partId)
    const name = stringValue(data.tool)
    if (!id || !name) return undefined
    return {
      id,
      name,
      status: 'completed',
      detail: stringValue(data.title),
      durationMs: numberValue(data.durationMs),
    }
  }
  if (event.type === 'runtime.tool.failed') {
    const id = stringValue(data.toolCallId) ?? stringValue(data.partID) ?? stringValue(data.partId)
    const name = stringValue(data.tool)
    if (!id || !name) return undefined
    return {
      id,
      name,
      status: 'failed',
      durationMs: numberValue(data.durationMs),
      error: sanitizeText(stringValue(data.errorMessage) ?? stringValue(data.errorType) ?? 'tool failed'),
    }
  }

  if (event.type !== 'runtime.message.part.updated' && event.type !== 'message.part.updated') return undefined
  const part = asRecord(data.part) ?? asRecord(asRecord(event.properties)?.part)
  if (part?.type !== 'tool') return undefined
  const state = asRecord(part.state)
  const id = stringValue(part.callID) ?? stringValue(part.callId) ?? stringValue(part.id)
  const name = stringValue(part.tool)
  if (!id || !name) return undefined
  const status = toolPartStatus(stringValue(state?.status))
  return {
    id,
    name,
    status,
    detail: summarizeValue(state?.input) ?? stringValue(state?.title),
    durationMs: durationFromState(state),
    error: status === 'failed' ? sanitizeText(stringValue(state?.error) ?? 'tool failed') : undefined,
  }
}

function toolPartStatus(input: string | undefined): FeishuStreamingToolStatus['status'] {
  if (input === 'pending') return 'pending'
  if (input === 'completed') return 'completed'
  if (input === 'error' || input === 'failed') return 'failed'
  return 'running'
}

function durationFromState(state: Record<string, unknown> | undefined): number | undefined {
  const time = asRecord(state?.time)
  const start = numberValue(time?.start)
  const end = numberValue(time?.end)
  return start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined
}

function renderRunningToolStatusLines(tools: FeishuStreamingToolStatus[]): string {
  return [
    '**工具状态**',
    ...tools.map((tool) => {
      const detail = tool.error ?? tool.detail
      return `- 运行中 ${tool.name}${detail ? `：${detail}` : ''}`
    }),
  ].join('\n')
}

function summarizeValue(input: unknown): string | undefined {
  const record = asRecord(input)
  if (record) {
    const preferred = ['description', 'command', 'query', 'q', 'path', 'filePath', 'file_path', 'url']
      .map((key) => stringValue(record[key]))
      .find(Boolean)
    if (preferred) return truncate(sanitizeText(preferred), 160)
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (isSensitiveKey(key)) {
        safe[key] = '[redacted]'
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        safe[key] = value
      }
    }
    const json = Object.keys(safe).length ? JSON.stringify(safe) : undefined
    return json ? truncate(json, 160) : undefined
  }
  return typeof input === 'string' ? truncate(sanitizeText(input), 160) : undefined
}

function eventData(event: FeishuRuntimeEventEnvelope): Record<string, unknown> {
  if (event.data && typeof event.data === 'object') return event.data as Record<string, unknown>
  if (event.properties) return event.properties
  return {}
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined
}

function sanitizeText(input: string): string {
  return input.replace(/\b(secret|token|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
}

function isSensitiveKey(input: string): boolean {
  return /(secret|token|password|credential|api[_-]?key|app[_-]?key|authorization)/i.test(input)
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max).trimEnd()}...`
}
