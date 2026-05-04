import type {
  FeishuControllerBridge,
  FeishuRuntimeEventEnvelope,
  FeishuRuntimeEventSubscription,
} from './controller-bridge'
import {
  renderFeishuInteractionAnsweredCard,
  renderFeishuPermissionCard,
  renderFeishuQuestionCard,
  renderFeishuTurnCard,
} from './cards'
import type { FeishuIMRouteKey } from './route'
import {
  type FeishuIMReplyClient,
  type FeishuIMReplyDelivery,
  type FeishuIMResolvedPresentation,
  type FeishuIMSentMessage,
} from './reply-client'
import { FeishuStreamingCardController } from './streaming-card-controller'
import type { FeishuIMReplyPresentation } from './types'
import {
  decrementFeishuIMActiveReplySinks,
  decrementFeishuIMActiveStreamingCards,
  decrementFeishuIMPendingInteractions,
  incrementFeishuIMActiveReplySinks,
  incrementFeishuIMActiveStreamingCards,
  incrementFeishuIMPendingInteractions,
  recordFeishuIMReplyError,
} from './reply-telemetry'

export type FeishuReplySinkOptions = {
  accountId: string
  routeKey: FeishuIMRouteKey
  sessionId: string
  turnSnapshotId?: string
  controller: FeishuControllerBridge
  client: FeishuIMReplyClient
  replyMode: FeishuIMReplyDelivery['replyTarget']
  presentation: FeishuIMReplyPresentation
  timeoutMs: number
  streamingCardUpdateMs?: number
  streamingCardMaxChars?: number
  rootMessageId?: string
  continueUrl?: string
  onDone?: (result: FeishuReplySinkDoneResult) => void | Promise<void>
  onError?: (error: Error) => void | Promise<void>
}

export type FeishuReplySinkDoneResult = {
  status: 'final' | 'error' | 'timeout' | 'stopped'
  message?: string
}

export type FeishuReplySinkHandle = {
  done: Promise<FeishuReplySinkDoneResult>
  start(): Promise<void>
  bindTurnSnapshotId(turnSnapshotId?: string): Promise<void>
  handleEvent(event: FeishuRuntimeEventEnvelope): Promise<void>
  stop(): void
}

export class FeishuReplySink implements FeishuReplySinkHandle {
  readonly done: Promise<FeishuReplySinkDoneResult>

  private subscription?: FeishuRuntimeEventSubscription
  private timeout?: ReturnType<typeof setTimeout>
  private resolveDone!: (result: FeishuReplySinkDoneResult) => void
  private bound = false
  private stopped = false
  private completed = false
  private pendingEvents: FeishuRuntimeEventEnvelope[] = []
  private sentCard?: FeishuIMSentMessage
  private textBuffer = ''
  private streamingTelemetryActive = false
  private streamingController?: FeishuStreamingCardController
  private resourceFailure?: string
  private errorMessage?: string
  private readonly partTextLengths = new Map<string, number>()
  private readonly pendingInteractions = new Set<string>()

  constructor(private readonly options: FeishuReplySinkOptions) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
  }

  async start(): Promise<void> {
    if (this.subscription || this.stopped) return
    this.subscription = this.options.controller.subscribeEvents({
      sessionId: this.options.sessionId,
      onEvent: (event) => this.handleEvent(event),
      onError: async (error) => {
        recordFeishuIMReplyError(error)
        await this.options.onError?.(error)
      },
    })
    incrementFeishuIMActiveReplySinks()
    if (this.presentation() === 'streaming-card') {
      this.activateStreamingTelemetry()
    }
    if (this.options.turnSnapshotId !== undefined) {
      await this.bindTurnSnapshotId(this.options.turnSnapshotId)
    }
  }

  async bindTurnSnapshotId(turnSnapshotId?: string): Promise<void> {
    if (this.stopped) return
    this.options.turnSnapshotId = turnSnapshotId
    this.bound = true
    this.startTimeout()
    if (this.presentation() === 'card') {
      await this.upsertTurnCard('running')
    } else if (this.presentation() === 'streaming-card') {
      await this.streaming().start(turnSnapshotId)
    }
    const pending = this.pendingEvents
    this.pendingEvents = []
    for (const event of pending) {
      await this.handleEvent(event)
    }
  }

  async handleEvent(event: FeishuRuntimeEventEnvelope): Promise<void> {
    if (this.stopped || this.completed) return
    if (!this.isRelevantEvent(event)) return
    if (!this.bound && shouldBufferUntilTurn(event)) {
      this.pendingEvents.push(event)
      return
    }
    if (!this.eventMatchesTurn(event)) return

    try {
      const type = normalizedEventType(event)
      if (type === 'runtime.message.part.updated') {
        await this.handlePartUpdated(event)
        return
      }
      if (
        this.presentation() === 'streaming-card' &&
        (type === 'runtime.tool.started' || type === 'runtime.tool.completed' || type === 'runtime.tool.failed')
      ) {
        await this.streaming().handleRuntimeEvent(event)
        return
      }
      if (type === 'runtime.interaction.requested') {
        await this.handleInteractionRequested(event)
        return
      }
      if (type === 'runtime.interaction.answered') {
        await this.handleInteractionAnswered(event)
        return
      }
      if (type === 'runtime.resource.failed') {
        await this.handleResourceFailed(event)
        return
      }
      if (type === 'runtime.turn.completed') {
        await this.finish('final')
        return
      }
      if (type === 'runtime.turn.failed') {
        await this.finish('error', messageFromEvent(event) ?? 'Agent turn failed.')
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      recordFeishuIMReplyError(normalized)
      await this.options.onError?.(normalized)
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.subscription?.stop()
    this.subscription = undefined
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    this.streamingController?.stop()
    for (const _id of this.pendingInteractions) {
      decrementFeishuIMPendingInteractions()
    }
    this.pendingInteractions.clear()
    decrementFeishuIMActiveReplySinks()
    this.deactivateStreamingTelemetry()
    this.resolveDoneOnce({ status: this.completed ? 'final' : 'stopped' })
  }

  private async handlePartUpdated(event: FeishuRuntimeEventEnvelope): Promise<void> {
    if (this.presentation() === 'streaming-card') {
      await this.streaming().handleRuntimeEvent(event)
    }
    const text = textDeltaFromEvent(event, this.partTextLengths)
    if (!text) return
    this.textBuffer += text
    if (this.presentation() === 'text') {
      await this.options.client.sendText({
        ...this.delivery(),
        text,
      })
      return
    }
    if (this.presentation() === 'streaming-card') {
      await this.streaming().appendText(text)
      return
    }
    await this.upsertTurnCard('running')
  }

  private async handleInteractionRequested(event: FeishuRuntimeEventEnvelope): Promise<void> {
    const data = eventData(event)
    const kind = stringValue(data.kind)
    const requestId = stringValue(data.requestId) ?? stringValue(data.id)
    if (!requestId) return
    if (!this.pendingInteractions.has(requestId)) {
      this.pendingInteractions.add(requestId)
      incrementFeishuIMPendingInteractions()
    }
    if (kind === 'permission') {
      await this.options.client.sendCard({
        ...this.delivery(),
        card: renderFeishuPermissionCard({
          accountId: this.options.accountId,
          routeKey: this.options.routeKey,
          sessionId: this.options.sessionId,
          turnSnapshotId: this.options.turnSnapshotId,
          requestId,
          continueUrl: this.options.continueUrl,
          data,
        }),
      })
      return
    }
    if (kind === 'question') {
      await this.options.client.sendCard({
        ...this.delivery(),
        card: renderFeishuQuestionCard({
          accountId: this.options.accountId,
          routeKey: this.options.routeKey,
          sessionId: this.options.sessionId,
          turnSnapshotId: this.options.turnSnapshotId,
          requestId,
          continueUrl: this.options.continueUrl,
          data,
        }),
      })
    }
  }

  private async handleInteractionAnswered(event: FeishuRuntimeEventEnvelope): Promise<void> {
    const data = eventData(event)
    const requestId = stringValue(data.requestId) ?? stringValue(data.requestID)
    if (requestId && this.pendingInteractions.delete(requestId)) {
      decrementFeishuIMPendingInteractions()
    }
    await this.options.client.sendCard({
      ...this.delivery(),
      card: renderFeishuInteractionAnsweredCard({
        message: '飞书卡片操作已提交。',
      }),
    })
  }

  private async handleResourceFailed(event: FeishuRuntimeEventEnvelope): Promise<void> {
    const message = messageFromEvent(event) ?? '部分资源加载失败，可以在 Web 端继续查看。'
    if (this.presentation() === 'text') {
      await this.options.client.sendText({
        ...this.delivery(),
        text: message,
      })
      return
    }
    this.resourceFailure = message
    if (this.presentation() === 'streaming-card') {
      await this.streaming().setResourceFailure(message)
      return
    }
    await this.upsertTurnCard('running', { resourceFailure: message })
  }

  private async finish(status: FeishuReplySinkDoneResult['status'], message?: string): Promise<void> {
    if (this.completed) return
    this.completed = true
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    if (status === 'final') {
      if (this.presentation() === 'card') {
        await this.upsertTurnCard('final')
      } else if (this.presentation() === 'streaming-card') {
        await this.streaming().finish('final')
      } else if (!this.textBuffer.trim()) {
        await this.options.client.sendText({
          ...this.delivery(),
          text: '已完成。',
        })
      }
    } else if (status === 'error' || status === 'timeout') {
      const text = message ?? (status === 'timeout' ? '飞书回复等待超时，请在 Web 端继续。' : '处理失败。')
      this.errorMessage = text
      if (this.presentation() === 'card') {
        await this.upsertTurnCard(status, { error: text })
      } else if (this.presentation() === 'streaming-card') {
        await this.streaming().finish(status, text)
      } else {
        await this.options.client.sendText({
          ...this.delivery(),
          text,
        })
      }
    }

    for (const _id of this.pendingInteractions) {
      decrementFeishuIMPendingInteractions()
    }
    this.pendingInteractions.clear()
    this.subscription?.stop()
    this.subscription = undefined
    decrementFeishuIMActiveReplySinks()
    this.deactivateStreamingTelemetry()
    const result = { status, message } satisfies FeishuReplySinkDoneResult
    await this.options.onDone?.(result)
    this.resolveDoneOnce(result)
    this.stopped = true
  }

  private async upsertTurnCard(
    status: FeishuTurnCardStatus,
    extra: { error?: string; resourceFailure?: string } = {},
  ) {
    const card = renderFeishuTurnCard({
      status,
      routeKey: this.options.routeKey,
      sessionId: this.options.sessionId,
      turnSnapshotId: this.options.turnSnapshotId,
      continueUrl: this.options.continueUrl,
      content: this.textBuffer.trim() || undefined,
      error: extra.error,
      resourceFailure: extra.resourceFailure,
    })
    if (!this.sentCard?.messageId && !this.sentCard?.cardId) {
      this.sentCard = await this.options.client.sendCard({
        ...this.delivery(),
        card,
      })
      return
    }
    this.sentCard = await this.options.client.updateCard({
      messageId: this.sentCard.messageId,
      cardId: this.sentCard.cardId,
      card,
    })
  }

  private startTimeout() {
    if (this.timeout || this.options.timeoutMs <= 0) return
    this.timeout = setTimeout(() => {
      this.finish('timeout', '飞书回复等待超时，请在 Web 端继续。').catch((error) =>
        recordFeishuIMReplyError(error),
      )
    }, this.options.timeoutMs)
  }

  private presentation(): FeishuIMResolvedPresentation {
    if (this.options.presentation === 'text' || this.options.presentation === 'card' || this.options.presentation === 'streaming-card') return this.options.presentation
    return this.options.routeKey.kind === 'dm' ? 'text' : 'streaming-card'
  }

  private streamingUpdateMs(): number {
    return Math.max(1, this.options.streamingCardUpdateMs ?? 1_000)
  }

  private streaming(): FeishuStreamingCardController {
    if (!this.streamingController) {
      this.streamingController = new FeishuStreamingCardController({
        accountId: this.options.accountId,
        routeKey: this.options.routeKey,
        sessionId: this.options.sessionId,
        turnSnapshotId: this.options.turnSnapshotId,
        client: this.options.client,
        delivery: this.delivery(),
        updateMs: this.streamingUpdateMs(),
        maxChars: this.options.streamingCardMaxChars,
        continueUrl: this.options.continueUrl,
        onError: this.options.onError,
      })
    }
    return this.streamingController
  }

  private delivery(): FeishuIMReplyDelivery {
    return {
      chatId: this.options.routeKey.chatId,
      rootMessageId: this.options.rootMessageId,
      replyTarget: this.options.replyMode,
    }
  }

  private isRelevantEvent(event: FeishuRuntimeEventEnvelope): boolean {
    const type = normalizedEventType(event)
    return type === 'runtime.message.part.updated'
      || type === 'runtime.tool.started'
      || type === 'runtime.tool.completed'
      || type === 'runtime.tool.failed'
      || type === 'runtime.interaction.requested'
      || type === 'runtime.interaction.answered'
      || type === 'runtime.resource.failed'
      || type === 'runtime.turn.completed'
      || type === 'runtime.turn.failed'
  }

  private eventMatchesTurn(event: FeishuRuntimeEventEnvelope): boolean {
    if (!this.options.turnSnapshotId) return true
    const turnSnapshotId = event.turnSnapshotId
      ?? stringValue(eventData(event).turnSnapshotId)
      ?? stringValue(eventData(event).turnSnapshotID)
    return !turnSnapshotId || turnSnapshotId === this.options.turnSnapshotId
  }

  private resolveDoneOnce(result: FeishuReplySinkDoneResult) {
    const resolve = this.resolveDone
    this.resolveDone = () => undefined
    resolve(result)
  }

  private activateStreamingTelemetry() {
    if (this.streamingTelemetryActive) return
    this.streamingTelemetryActive = true
    incrementFeishuIMActiveStreamingCards()
  }

  private deactivateStreamingTelemetry() {
    if (!this.streamingTelemetryActive) return
    this.streamingTelemetryActive = false
    decrementFeishuIMActiveStreamingCards()
  }
}

type FeishuTurnCardStatus = Parameters<typeof renderFeishuTurnCard>[0]['status']

export function normalizedEventType(event: FeishuRuntimeEventEnvelope): string {
  if (event.type === 'message.part.updated') return 'runtime.message.part.updated'
  if (event.type === 'permission.asked' || event.type === 'question.asked') return 'runtime.interaction.requested'
  if (event.type === 'permission.replied' || event.type === 'question.replied' || event.type === 'question.rejected') {
    return 'runtime.interaction.answered'
  }
  if (event.type === 'session.idle') return 'runtime.turn.completed'
  if (event.type === 'session.error') return 'runtime.turn.failed'
  return event.type
}

function shouldBufferUntilTurn(event: FeishuRuntimeEventEnvelope): boolean {
  const type = normalizedEventType(event)
  return type === 'runtime.message.part.updated'
    || type === 'runtime.tool.started'
    || type === 'runtime.tool.completed'
    || type === 'runtime.tool.failed'
    || type === 'runtime.interaction.requested'
    || type === 'runtime.interaction.answered'
    || type === 'runtime.resource.failed'
    || type === 'runtime.turn.completed'
    || type === 'runtime.turn.failed'
}

function eventData(event: FeishuRuntimeEventEnvelope): Record<string, unknown> {
  if (event.data && typeof event.data === 'object') return event.data as Record<string, unknown>
  if (event.properties) return event.properties
  return {}
}

function textDeltaFromEvent(event: FeishuRuntimeEventEnvelope, lengths: Map<string, number>): string | undefined {
  const data = eventData(event)
  const delta = data.delta
  const deltaRecord = asRecord(delta)
  const deltaText = typeof delta === 'string'
    ? delta
    : stringValue(deltaRecord?.text)
  if (deltaText) return deltaText

  const part = asRecord(data.part)
  if (!part || part.type !== 'text') return undefined
  const partText = stringValue(part.text)
  if (!partText) return undefined
  const partId = stringValue(part.id) ?? stringValue(data.partId) ?? 'default'
  const previousLength = lengths.get(partId) ?? 0
  lengths.set(partId, partText.length)
  return partText.length > previousLength ? partText.slice(previousLength) : undefined
}

function messageFromEvent(event: FeishuRuntimeEventEnvelope): string | undefined {
  const data = eventData(event)
  const direct = stringValue(data.message) ?? stringValue(data.error)
  if (direct) return direct
  const error = asRecord(data.error)
  return stringValue(error?.message) ?? stringValue(error?.name)
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
