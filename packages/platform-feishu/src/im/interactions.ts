import { parseFeishuRouteKey, serializeFeishuRouteKey, type FeishuIMRouteKey } from './route'
import type { FeishuControllerBridge, FeishuInteractionAnswerInput } from './controller-bridge'

export type FeishuCardActionType =
  | 'permission.allowOnce'
  | 'permission.allowSession'
  | 'permission.deny'
  | 'question.answer'
  | 'question.deny'
  | 'control.newSession'
  | 'control.projectList'
  | 'control.switchProject'
  | 'control.showCwd'
  | 'control.openWeb'
  | 'control.help'
  | 'turn.abort'

export type FeishuCardActionPayload = {
  v: 1
  accountId: string
  routeKey: string
  sessionId?: string
  turnSnapshotId?: string
  requestId?: string
  action: FeishuCardActionType
  nonce: string
  issuedAt: string
}

export type FeishuCardActionContext = {
  accountId: string
  routeKey: FeishuIMRouteKey
  sessionId?: string
  turnSnapshotId?: string
  requestId?: string
}

export type FeishuCardActionValue = {
  answer?: string | string[] | string[][]
  projectId?: string
  value?: string
}

export type FeishuCardActionParseResult =
  | {
      ok: true
      payload: FeishuCardActionPayload
      value: FeishuCardActionValue
    }
  | {
      ok: false
      reason: string
    }

export type FeishuCardInteractionResult =
  | {
      status: 'answered'
      requestId: string
      action: FeishuCardActionType
    }
  | {
      status: 'ignored'
      reason: string
    }
  | {
      status: 'failed'
      reason: string
    }

export function createFeishuCardActionPayload(
  action: FeishuCardActionType,
  context: FeishuCardActionContext,
): FeishuCardActionPayload {
  return {
    v: 1,
    accountId: context.accountId,
    routeKey: serializeFeishuRouteKey(context.routeKey),
    sessionId: context.sessionId,
    turnSnapshotId: context.turnSnapshotId,
    requestId: context.requestId,
    action,
    nonce: randomNonce(),
    issuedAt: new Date().toISOString(),
  }
}

export function parseFeishuCardAction(input: unknown): FeishuCardActionParseResult {
  const value = actionValueRecord(input)
  const rawPayload = value?.nine1bot ?? value?.payload ?? value
  const payload = payloadFrom(rawPayload)
  if (!payload) return { ok: false, reason: 'missing-action-payload' }
  if (!parseFeishuRouteKey(payload.routeKey)) return { ok: false, reason: 'invalid-route-key' }
  return {
    ok: true,
    payload,
    value: {
      answer: answerValue(value),
      projectId: stringValue(value?.projectId),
      value: stringValue(value?.value),
    },
  }
}

export function validateFeishuCardActionPayload(
  payload: FeishuCardActionPayload,
  expected: {
    accountId?: string
    routeKey?: string
    sessionId?: string
    turnSnapshotId?: string
    maxAgeMs?: number
    now?: number
  } = {},
): { ok: true } | { ok: false; reason: string } {
  if (expected.accountId && payload.accountId !== expected.accountId) {
    return { ok: false, reason: 'account-mismatch' }
  }
  if (expected.routeKey && payload.routeKey !== expected.routeKey) {
    return { ok: false, reason: 'route-mismatch' }
  }
  if (expected.sessionId && payload.sessionId && payload.sessionId !== expected.sessionId) {
    return { ok: false, reason: 'session-mismatch' }
  }
  if (expected.turnSnapshotId && payload.turnSnapshotId && payload.turnSnapshotId !== expected.turnSnapshotId) {
    return { ok: false, reason: 'turn-mismatch' }
  }
  if (expected.maxAgeMs !== undefined) {
    const issuedAt = Date.parse(payload.issuedAt)
    const now = expected.now ?? Date.now()
    if (!Number.isFinite(issuedAt) || now - issuedAt > expected.maxAgeMs) {
      return { ok: false, reason: 'expired' }
    }
  }
  return { ok: true }
}

export async function answerFeishuCardInteraction(input: {
  controller: FeishuControllerBridge
  payload: FeishuCardActionPayload
  value?: FeishuCardActionValue
  expected?: Parameters<typeof validateFeishuCardActionPayload>[1]
}): Promise<FeishuCardInteractionResult> {
  const validation = validateFeishuCardActionPayload(input.payload, input.expected)
  if (!validation.ok) return { status: 'ignored', reason: validation.reason }

  const answer = interactionAnswerFor(input.payload, input.value)
  if (!answer) return { status: 'ignored', reason: 'not-an-interaction-action' }

  try {
    const accepted = await input.controller.answerInteraction(answer)
    return accepted
      ? { status: 'answered', requestId: answer.requestId, action: input.payload.action }
      : { status: 'failed', reason: 'controller-rejected' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

export function routeFromFeishuCardAction(payload: FeishuCardActionPayload): FeishuIMRouteKey | undefined {
  return parseFeishuRouteKey(payload.routeKey)
}

function interactionAnswerFor(
  payload: FeishuCardActionPayload,
  value?: FeishuCardActionValue,
): FeishuInteractionAnswerInput | undefined {
  if (!payload.requestId) return undefined
  if (payload.action === 'permission.allowOnce') {
    return {
      requestId: payload.requestId,
      kind: 'permission',
      answer: 'allow-once',
    }
  }
  if (payload.action === 'permission.allowSession') {
    return {
      requestId: payload.requestId,
      kind: 'permission',
      answer: 'allow-session',
    }
  }
  if (payload.action === 'permission.deny') {
    return {
      requestId: payload.requestId,
      kind: 'permission',
      answer: 'deny',
    }
  }
  if (payload.action === 'question.deny') {
    return {
      requestId: payload.requestId,
      kind: 'question',
      answer: 'deny',
    }
  }
  if (payload.action === 'question.answer') {
    return {
      requestId: payload.requestId,
      kind: 'question',
      answer: {
        answers: normalizeQuestionAnswers(value?.answer ?? value?.value),
      },
    }
  }
  return undefined
}

function payloadFrom(input: unknown): FeishuCardActionPayload | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  if (record.v !== 1) return undefined
  const accountId = stringValue(record.accountId)
  const routeKey = stringValue(record.routeKey)
  const action = actionType(record.action)
  const nonce = stringValue(record.nonce)
  const issuedAt = stringValue(record.issuedAt)
  if (!accountId || !routeKey || !action || !nonce || !issuedAt) return undefined
  return {
    v: 1,
    accountId,
    routeKey,
    sessionId: stringValue(record.sessionId),
    turnSnapshotId: stringValue(record.turnSnapshotId),
    requestId: stringValue(record.requestId),
    action,
    nonce,
    issuedAt,
  }
}

function actionValueRecord(input: unknown): Record<string, unknown> | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  const action = asRecord(record.action)
  const value = asRecord(action?.value) ?? asRecord(record.value)
  return value ?? record
}

function actionType(input: unknown): FeishuCardActionType | undefined {
  return typeof input === 'string' && [
    'permission.allowOnce',
    'permission.allowSession',
    'permission.deny',
    'question.answer',
    'question.deny',
    'control.newSession',
    'control.projectList',
    'control.switchProject',
    'control.showCwd',
    'control.openWeb',
    'control.help',
    'turn.abort',
  ].includes(input)
    ? input as FeishuCardActionType
    : undefined
}

function normalizeQuestionAnswers(input: unknown): string[][] {
  if (Array.isArray(input)) {
    if (input.every((item) => Array.isArray(item))) {
      return input.map((item) => item.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    }
    return [input.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())]
  }
  const value = typeof input === 'string' && input.trim() ? input.trim() : 'deny'
  return [[value]]
}

function answerValue(record: Record<string, unknown> | undefined): FeishuCardActionValue['answer'] {
  if (!record) return undefined
  if (record.answer !== undefined) return record.answer as FeishuCardActionValue['answer']
  if (record.answers !== undefined) return record.answers as FeishuCardActionValue['answer']
  return undefined
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10)
}
