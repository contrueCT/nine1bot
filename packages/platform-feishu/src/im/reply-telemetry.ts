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

export function getFeishuIMReplyRuntimeSummary(): FeishuIMReplyRuntimeSummary {
  return { ...summary }
}

export function clearFeishuIMReplyRuntimeSummaryForTesting() {
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
}

export function incrementFeishuIMActiveReplySinks() {
  summary.activeSinks += 1
}

export function decrementFeishuIMActiveReplySinks() {
  summary.activeSinks = Math.max(0, summary.activeSinks - 1)
}

export function incrementFeishuIMPendingInteractions() {
  summary.pendingInteractions += 1
}

export function decrementFeishuIMPendingInteractions() {
  summary.pendingInteractions = Math.max(0, summary.pendingInteractions - 1)
}

export function incrementFeishuIMActiveStreamingCards() {
  summary.activeStreamingCards += 1
}

export function decrementFeishuIMActiveStreamingCards() {
  summary.activeStreamingCards = Math.max(0, summary.activeStreamingCards - 1)
}

export function recordFeishuIMReplyError(error: unknown) {
  summary.lastReplyError = error instanceof Error ? error.message : String(error)
}

export function recordFeishuIMCardUpdateFailure(error: unknown) {
  summary.cardUpdateFailures += 1
  summary.lastCardUpdateError = error instanceof Error ? error.message : String(error)
  recordFeishuIMReplyError(error)
}

export function recordFeishuIMStreamingTransport(transport: 'cardkit' | 'patch' | 'text') {
  summary.lastStreamingTransport = transport
}

export function recordFeishuIMStreamingFallback(
  reason: string,
  transport: 'patch' | 'text',
) {
  summary.streamingFallbacks += 1
  summary.lastStreamingFallbackReason = reason
  summary.lastStreamingTransport = transport
}

export function recordFeishuIMCardAction(action: string) {
  summary.lastCardAction = action
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
