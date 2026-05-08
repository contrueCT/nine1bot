import type { PlatformRecentEvent } from '@nine1bot/platform-protocol'

export type FeishuIMReplyRuntimeSummary = {
  activeSinks: number
  pendingInteractions: number
  activeTurns: number
  pendingBuffers: number
  bufferedMessages: number
  activeStreamingCards: number
  cardUpdateFailures: number
  streamingFallbacks: number
  lastReplyError?: string
  lastCardAction?: string
  lastCardUpdateError?: string
  lastStreamingTransport?: 'cardkit' | 'patch' | 'text'
  lastStreamingFallbackReason?: string
}

type FeishuIMReplyTelemetryListener = () => void

const FEISHU_IM_REPLY_RECENT_EVENT_LIMIT = 20

const summary: FeishuIMReplyRuntimeSummary = {
  activeSinks: 0,
  pendingInteractions: 0,
  activeTurns: 0,
  pendingBuffers: 0,
  bufferedMessages: 0,
  activeStreamingCards: 0,
  cardUpdateFailures: 0,
  streamingFallbacks: 0,
}

const recentEvents: PlatformRecentEvent[] = []
const listeners = new Set<FeishuIMReplyTelemetryListener>()
let recentEventCounter = 0

export function getFeishuIMReplyRuntimeSummary(): FeishuIMReplyRuntimeSummary {
  return { ...summary }
}

export function getFeishuIMReplyRuntimeRecentEvents(): PlatformRecentEvent[] {
  return [...recentEvents]
}

export function subscribeFeishuIMReplyRuntimeSummary(listener: FeishuIMReplyTelemetryListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetFeishuIMReplyRuntimeSummary() {
  summary.activeSinks = 0
  summary.pendingInteractions = 0
  summary.activeTurns = 0
  summary.pendingBuffers = 0
  summary.bufferedMessages = 0
  summary.activeStreamingCards = 0
  summary.cardUpdateFailures = 0
  summary.streamingFallbacks = 0
  summary.lastReplyError = undefined
  summary.lastCardAction = undefined
  summary.lastCardUpdateError = undefined
  summary.lastStreamingTransport = undefined
  summary.lastStreamingFallbackReason = undefined
  recentEvents.length = 0
  recentEventCounter = 0
  notifyListeners()
}

export function clearFeishuIMReplyRuntimeSummaryForTesting() {
  resetFeishuIMReplyRuntimeSummary()
}

export function incrementFeishuIMActiveReplySinks() {
  summary.activeSinks += 1
  notifyListeners()
}

export function decrementFeishuIMActiveReplySinks() {
  summary.activeSinks = Math.max(0, summary.activeSinks - 1)
  notifyListeners()
}

export function incrementFeishuIMPendingInteractions() {
  summary.pendingInteractions += 1
  notifyListeners()
}

export function decrementFeishuIMPendingInteractions() {
  summary.pendingInteractions = Math.max(0, summary.pendingInteractions - 1)
  notifyListeners()
}

export function incrementFeishuIMActiveStreamingCards() {
  summary.activeStreamingCards += 1
  notifyListeners()
}

export function decrementFeishuIMActiveStreamingCards() {
  summary.activeStreamingCards = Math.max(0, summary.activeStreamingCards - 1)
  notifyListeners()
}

export function recordFeishuIMReplyError(error: unknown) {
  const message = errorMessage(error)
  summary.lastReplyError = message
  appendRecentEvent('error', 'im-reply', `Feishu IM reply delivery failed: ${message}`, {
    event: 'reply-error',
    error: message,
  })
  notifyListeners()
}

export function recordFeishuIMCardUpdateFailure(error: unknown) {
  const message = errorMessage(error)
  summary.cardUpdateFailures += 1
  summary.lastCardUpdateError = message
  appendRecentEvent('warn', 'im-reply', `Feishu IM card update failed: ${message}`, {
    event: 'card-update-failed',
    error: message,
  })
  notifyListeners()
}

export function recordFeishuIMStreamingTransport(transport: 'cardkit' | 'patch' | 'text') {
  summary.lastStreamingTransport = transport
  notifyListeners()
}

export function recordFeishuIMStreamingFallback(
  reason: string,
  transport: 'patch' | 'text',
) {
  summary.streamingFallbacks += 1
  summary.lastStreamingFallbackReason = reason
  summary.lastStreamingTransport = transport
  appendRecentEvent('warn', 'im-reply', `Feishu IM streaming reply fell back to ${transport}: ${reason}`, {
    event: 'streaming-fallback',
    reason,
    transport,
  })
  notifyListeners()
}

export function recordFeishuIMCardAction(action: string) {
  summary.lastCardAction = action
  notifyListeners()
}

export function recordFeishuIMSessionManagerSnapshot(input: {
  activeTurns: number
  pendingBuffers: number
  bufferedMessages: number
}) {
  summary.activeTurns = input.activeTurns
  summary.pendingBuffers = input.pendingBuffers
  summary.bufferedMessages = input.bufferedMessages
}

function appendRecentEvent(
  level: PlatformRecentEvent['level'],
  stage: string,
  message: string,
  data?: Record<string, unknown>,
) {
  recentEventCounter += 1
  recentEvents.unshift({
    id: `feishu-im-reply-${Date.now()}-${recentEventCounter}`,
    at: new Date().toISOString(),
    level,
    stage,
    message,
    data,
  })
  recentEvents.splice(FEISHU_IM_REPLY_RECENT_EVENT_LIMIT)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notifyListeners() {
  for (const listener of listeners) {
    listener()
  }
}
