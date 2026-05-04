export type FeishuIMReplyRuntimeSummary = {
  activeSinks: number
  pendingInteractions: number
  lastReplyError?: string
  lastCardAction?: string
}

const summary: FeishuIMReplyRuntimeSummary = {
  activeSinks: 0,
  pendingInteractions: 0,
}

export function getFeishuIMReplyRuntimeSummary(): FeishuIMReplyRuntimeSummary {
  return { ...summary }
}

export function clearFeishuIMReplyRuntimeSummaryForTesting() {
  summary.activeSinks = 0
  summary.pendingInteractions = 0
  summary.lastReplyError = undefined
  summary.lastCardAction = undefined
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

export function recordFeishuIMReplyError(error: unknown) {
  summary.lastReplyError = error instanceof Error ? error.message : String(error)
}

export function recordFeishuIMCardAction(action: string) {
  summary.lastCardAction = action
}
