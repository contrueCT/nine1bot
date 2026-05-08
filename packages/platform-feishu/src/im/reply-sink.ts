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

const POST_TOOL_COMPLETION_GRACE_MS = 1_500
const TURN_RESULT_POLL_INITIAL_DELAY_MS = 1_500
const TURN_RESULT_POLL_INTERVAL_MS = 1_500
const SUBSCRIPTION_READY_TIMEOUT_MS = 1_000
const TERMINAL_DELIVERY_TIMEOUT_MS = 5_000

export type FeishuReplySinkOptions = {
  accountId: string
  routeKey: FeishuIMRouteKey
  sessionId: string
  directory?: string
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
  private toolActivitySeen = false
  private postToolTextSeen = false
  private completionPending = false
  private deferredCompletionTimer?: ReturnType<typeof setTimeout>
  private turnResultPollTimer?: ReturnType<typeof setTimeout>
  private turnResultPollInProgress = false
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
    await this.waitForSubscriptionReady()
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
    this.startTurnResultPoll()
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
      if (isToolEvent(type)) {
        this.noteToolActivity()
        if (this.presentation() === 'streaming-card') {
          await this.streaming().handleRuntimeEvent(event)
        }
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
        if (this.shouldDeferTurnCompletion()) {
          await this.deferTurnCompletion()
          return
        }
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
    this.clearDeferredFinal()
    this.clearTurnResultPoll()
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
    const toolPartUpdate = isToolPartUpdate(event)
    if (toolPartUpdate) {
      this.noteToolActivity()
    }
    if (this.presentation() === 'streaming-card') {
      await this.streaming().handleRuntimeEvent(event)
    }
    if (toolPartUpdate) return
    const text = textDeltaFromEvent(event, this.partTextLengths)
    if (!text) return
    if (this.toolActivitySeen) {
      this.postToolTextSeen = true
    }
    this.textBuffer += text
    if (this.presentation() === 'text') {
      await this.options.client.sendText({
        ...this.delivery(),
        text,
      })
    } else if (this.presentation() === 'streaming-card') {
      await this.streaming().appendText(text)
    } else {
      await this.upsertTurnCard('running')
    }
    if (this.completionPending && this.postToolTextSeen) {
      await this.finish('final')
    }
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
    this.completionPending = false
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    this.clearDeferredFinal()
    this.clearTurnResultPoll()

    let resultMessage = message
    try {
      await this.deliverTerminalState(status, message)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      recordFeishuIMReplyError(normalized)
      try {
        await this.options.onError?.(normalized)
      } catch (onErrorFailure) {
        recordFeishuIMReplyError(onErrorFailure instanceof Error ? onErrorFailure : new Error(String(onErrorFailure)))
      }
      resultMessage ??= normalized.message
      await this.sendTerminalFallback(status, resultMessage)
    }

    for (const _id of this.pendingInteractions) {
      decrementFeishuIMPendingInteractions()
    }
    this.pendingInteractions.clear()
    this.subscription?.stop()
    this.subscription = undefined
    decrementFeishuIMActiveReplySinks()
    this.deactivateStreamingTelemetry()
    const result = { status, message: resultMessage } satisfies FeishuReplySinkDoneResult
    try {
      await this.options.onDone?.(result)
    } catch (error) {
      recordFeishuIMReplyError(error instanceof Error ? error : new Error(String(error)))
    }
    this.resolveDoneOnce(result)
    this.stopped = true
  }

  private async deliverTerminalState(status: FeishuReplySinkDoneResult['status'], message?: string): Promise<void> {
    const delivery = (async () => {
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
        return
      }

      if (status === 'error' || status === 'timeout') {
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
    })()
    delivery.catch((error) => {
      recordFeishuIMReplyError(error instanceof Error ? error : new Error(String(error)))
    })
    await withTimeout(delivery, TERMINAL_DELIVERY_TIMEOUT_MS, 'Feishu terminal reply delivery timed out')
  }

  private async sendTerminalFallback(status: FeishuReplySinkDoneResult['status'], message?: string): Promise<void> {
    const text = status === 'final'
      ? this.textBuffer.trim() || '已完成，可在 Web 端继续查看。'
      : message ?? (status === 'timeout' ? '飞书回复等待超时，请在 Web 端继续。' : '处理失败。')
    await this.options.client.sendText({
      ...this.delivery(),
      text,
    }).catch((error) => {
      recordFeishuIMReplyError(error instanceof Error ? error : new Error(String(error)))
    })
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

  private startTurnResultPoll(): void {
    if (!this.options.controller.getLatestTurnResult || this.turnResultPollTimer || this.completed || this.stopped) return
    this.turnResultPollTimer = setTimeout(() => {
      this.turnResultPollTimer = undefined
      this.pollTurnResult().catch((error) => {
        recordFeishuIMReplyError(error instanceof Error ? error : new Error(String(error)))
        this.scheduleNextTurnResultPoll()
      })
    }, TURN_RESULT_POLL_INITIAL_DELAY_MS)
    this.turnResultPollTimer.unref?.()
  }

  private scheduleNextTurnResultPoll(): void {
    if (!this.options.controller.getLatestTurnResult || this.turnResultPollTimer || this.completed || this.stopped) return
    this.turnResultPollTimer = setTimeout(() => {
      this.turnResultPollTimer = undefined
      this.pollTurnResult().catch((error) => {
        recordFeishuIMReplyError(error instanceof Error ? error : new Error(String(error)))
        this.scheduleNextTurnResultPoll()
      })
    }, TURN_RESULT_POLL_INTERVAL_MS)
    this.turnResultPollTimer.unref?.()
  }

  private clearTurnResultPoll(): void {
    if (this.turnResultPollTimer) clearTimeout(this.turnResultPollTimer)
    this.turnResultPollTimer = undefined
  }

  private async pollTurnResult(): Promise<void> {
    if (this.completed || this.stopped || this.turnResultPollInProgress || !this.options.controller.getLatestTurnResult) return
    this.turnResultPollInProgress = true
    try {
      if (!await this.tryFinishFromLatestTurnResult()) {
        this.scheduleNextTurnResultPoll()
      }
    } finally {
      this.turnResultPollInProgress = false
    }
  }

  private async finishDeferredTurnCompletion(): Promise<void> {
    if (this.completed || this.stopped) return
    if (await this.tryFinishFromLatestTurnResult()) return
    await this.finish('final')
  }

  private async tryFinishFromLatestTurnResult(): Promise<boolean> {
    if (!this.options.controller.getLatestTurnResult) return false
    const result = await this.options.controller.getLatestTurnResult({
      sessionId: this.options.sessionId,
      directory: this.options.directory,
    })
    if (!result?.completed) return false
    if (result.failed) {
      await this.finish('error', result.error ?? 'Agent turn failed.')
      return true
    }
    if (result.text) {
      await this.replaceVisibleText(result.text)
    }
    await this.finish('final')
    return true
  }

  private async replaceVisibleText(text: string): Promise<void> {
    const normalized = text.trim()
    if (!normalized) return
    if (this.textBuffer.trim() === normalized) return
    this.textBuffer = normalized
    if (this.presentation() === 'streaming-card') {
      this.streaming().replaceText(normalized)
    }
  }

  private async waitForSubscriptionReady(): Promise<void> {
    const ready = this.subscription?.ready
    if (!ready) return
    await withTimeout(ready, SUBSCRIPTION_READY_TIMEOUT_MS, 'Feishu event subscription ready timed out').catch((error) => {
      recordFeishuIMReplyError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private noteToolActivity(): void {
    if (this.toolActivitySeen) return
    this.toolActivitySeen = true
    this.textBuffer = ''
    this.streamingController?.clearText()
  }

  private shouldDeferTurnCompletion(): boolean {
    return this.toolActivitySeen && !this.postToolTextSeen
  }

  private async deferTurnCompletion(): Promise<void> {
    this.completionPending = true
    if (await this.tryFinishFromLatestTurnResult()) return
    this.scheduleDeferredFinal()
  }

  private scheduleDeferredFinal(): void {
    if (this.deferredCompletionTimer) return
    this.deferredCompletionTimer = setTimeout(() => {
      this.deferredCompletionTimer = undefined
      this.finishDeferredTurnCompletion().catch((error) => recordFeishuIMReplyError(error))
    }, POST_TOOL_COMPLETION_GRACE_MS)
  }

  private clearDeferredFinal(): void {
    if (this.deferredCompletionTimer) clearTimeout(this.deferredCompletionTimer)
    this.deferredCompletionTimer = undefined
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

function isToolEvent(type: string): boolean {
  return type === 'runtime.tool.started'
    || type === 'runtime.tool.completed'
    || type === 'runtime.tool.failed'
}

function isToolPartUpdate(event: FeishuRuntimeEventEnvelope): boolean {
  const type = normalizedEventType(event)
  if (type !== 'runtime.message.part.updated') return false
  const part = asRecord(eventData(event).part) ?? asRecord(asRecord(event.properties)?.part)
  return part?.type === 'tool'
}

function eventData(event: FeishuRuntimeEventEnvelope): Record<string, unknown> {
  if (event.data && typeof event.data === 'object') return event.data as Record<string, unknown>
  if (event.properties) return event.properties
  return {}
}

function textDeltaFromEvent(event: FeishuRuntimeEventEnvelope, lengths: Map<string, number>): string | undefined {
  const data = eventData(event)
  const part = asRecord(data.part)
  if (part && !isVisibleTextPart(part)) return undefined
  const delta = data.delta
  const deltaRecord = asRecord(delta)
  const deltaText = typeof delta === 'string'
    ? delta
    : stringValue(deltaRecord?.text)
  if (deltaText) return deltaText

  if (!part || part.type !== 'text') return undefined
  const partText = stringValue(part.text)
  if (!partText) return undefined
  const partId = stringValue(part.id) ?? stringValue(data.partId) ?? 'default'
  const previousLength = lengths.get(partId) ?? 0
  lengths.set(partId, partText.length)
  return partText.length > previousLength ? partText.slice(previousLength) : undefined
}

function isVisibleTextPart(part: Record<string, unknown>): boolean {
  if (part.type !== 'text') return false
  if (part.ignored === true || part.synthetic === true) return false
  const metadata = asRecord(part.metadata)
  const kind = stringValue(metadata?.kind) ?? stringValue(metadata?.type)
  return kind !== 'reasoning' && kind !== 'thinking'
}

function messageFromEvent(event: FeishuRuntimeEventEnvelope): string | undefined {
  const data = eventData(event)
  const direct = stringValue(data.message) ?? stringValue(data.error)
  if (direct) return direct
  const error = asRecord(data.error)
  return stringValue(error?.message) ?? stringValue(error?.name)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return promise
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    timeout.unref?.()
  })
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
