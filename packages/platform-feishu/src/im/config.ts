import type {
  PlatformSecretRef,
  PlatformValidationResult,
} from '@nine1bot/platform-protocol'
import { asRecord } from '../shared'
import type {
  FeishuIMAccount,
  FeishuIMConnectionMode,
  FeishuIMLegacyState,
  FeishuIMNormalizedConfig,
  FeishuIMPolicy,
} from './types'

export const FEISHU_IM_DEFAULT_BUFFER_MS = 3_000
export const FEISHU_IM_DEFAULT_MAX_BUFFER_MS = 8_000
export const FEISHU_IM_DEFAULT_REPLY_TIMEOUT_MS = 600_000
export const FEISHU_IM_DEFAULT_STREAMING_CARD_UPDATE_MS = 1_000
export const FEISHU_IM_DEFAULT_STREAMING_CARD_MAX_CHARS = 6_000
export const FEISHU_IM_DEFAULT_BUSY_TEXT = '当前会话正在处理中，请稍后再试。'

export function normalizeFeishuIMConfig(
  settings: unknown,
  options: {
    legacyConfig?: unknown
  } = {},
): FeishuIMNormalizedConfig {
  const record = asRecord(settings) ?? {}
  const legacy = readLegacyState(options.legacyConfig)
  const explicitEnabled = booleanValue(record.imEnabled)
  const enabled = explicitEnabled === true
  const connectionMode = connectionModeValue(record.imConnectionMode) ?? 'websocket'
  const warnings: string[] = []
  const accounts = [
    ...readDefaultAccount(record, connectionMode),
    ...readAccounts(record.imAccounts, connectionMode, warnings),
  ]

  return {
    enabled,
    connectionMode,
    accounts: dedupeAccounts(accounts).filter((account) => account.enabled),
    policy: readPolicy(record),
    legacy,
    warnings,
  }
}

export function validateFeishuIMConfig(settings: unknown): PlatformValidationResult {
  const record = asRecord(settings) ?? {}
  const fieldErrors: Record<string, string> = {}
  const connectionMode = connectionModeValue(record.imConnectionMode)

  if (record.imConnectionMode !== undefined && !connectionMode) {
    fieldErrors.imConnectionMode = 'Only websocket mode is supported in Phase 1'
  }

  const accountsResult = parseAccounts(record.imAccounts, 'websocket')
  if (!accountsResult.ok) {
    fieldErrors.imAccounts = accountsResult.message
  }

  if (record.imMessageBufferMs !== undefined && !validNumber(record.imMessageBufferMs, 0)) {
    fieldErrors.imMessageBufferMs = 'Must be a non-negative number'
  }
  if (record.imMaxBufferMs !== undefined && !validNumber(record.imMaxBufferMs, 0)) {
    fieldErrors.imMaxBufferMs = 'Must be a non-negative number'
  }
  if (record.imReplyTimeoutMs !== undefined && !validNumber(record.imReplyTimeoutMs, 1)) {
    fieldErrors.imReplyTimeoutMs = 'Must be a positive number'
  }
  if (record.imStreamingCardUpdateMs !== undefined && !validNumber(record.imStreamingCardUpdateMs, 1)) {
    fieldErrors.imStreamingCardUpdateMs = 'Must be a positive number'
  }
  if (record.imStreamingCardMaxChars !== undefined && !validNumber(record.imStreamingCardMaxChars, 1)) {
    fieldErrors.imStreamingCardMaxChars = 'Must be a positive number'
  }
  if (record.imReplyPresentation !== undefined && !replyPresentationValue(record.imReplyPresentation)) {
    fieldErrors.imReplyPresentation = 'Must be one of auto, text, card, or streaming-card'
  }

  const bufferMs = numberValue(record.imMessageBufferMs, FEISHU_IM_DEFAULT_BUFFER_MS)
  const maxBufferMs = numberValue(record.imMaxBufferMs, FEISHU_IM_DEFAULT_MAX_BUFFER_MS)
  if (bufferMs > maxBufferMs) {
    fieldErrors.imMaxBufferMs = 'Must be greater than or equal to message buffer'
  }

  const enabled = booleanValue(record.imEnabled) === true
  if (enabled) {
    const normalized = normalizeFeishuIMConfig(settings)
    if (normalized.accounts.length === 0) {
      fieldErrors.imAccounts = fieldErrors.imAccounts ?? 'At least one IM account or default app secret is required when IM is enabled'
    }
  }

  return Object.keys(fieldErrors).length
    ? {
        ok: false,
        message: 'Invalid Feishu IM config',
        fieldErrors,
      }
    : { ok: true }
}

export function isPlatformSecretRef(input: unknown): input is PlatformSecretRef {
  const record = asRecord(input)
  return Boolean(
    record &&
    (record.provider === 'nine1bot-local' || record.provider === 'env' || record.provider === 'external') &&
    typeof record.key === 'string' &&
    record.key.trim(),
  )
}

function readDefaultAccount(
  settings: Record<string, unknown>,
  connectionMode: FeishuIMConnectionMode,
): FeishuIMAccount[] {
  const appId = stringValue(settings.imDefaultAppId)
  const appSecretRef = isPlatformSecretRef(settings.imDefaultAppSecret)
    ? settings.imDefaultAppSecret
    : undefined
  if (!appId || !appSecretRef) return []
  return [{
    id: 'default',
    name: 'Default app',
    enabled: true,
    appId,
    appSecretRef,
    defaultDirectory: stringValue(settings.imDefaultDirectory),
    connectionMode,
  }]
}

function readAccounts(
  input: unknown,
  fallbackMode: FeishuIMConnectionMode,
  warnings: string[],
): FeishuIMAccount[] {
  const result = parseAccounts(input, fallbackMode)
  if (!result.ok) {
    warnings.push(result.message)
    return []
  }
  return result.accounts
}

function parseAccounts(
  input: unknown,
  fallbackMode: FeishuIMConnectionMode,
): { ok: true; accounts: FeishuIMAccount[] } | { ok: false; message: string } {
  if (input === undefined || input === null || input === '') return { ok: true, accounts: [] }
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      return { ok: false, message: 'Must be valid JSON' }
    }
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'Must be an array of account objects' }
  }

  const accounts: FeishuIMAccount[] = []
  for (let index = 0; index < value.length; index++) {
    const account = asRecord(value[index])
    if (!account) return { ok: false, message: `Account ${index + 1} must be an object` }
    if (typeof account.appSecret === 'string' && account.appSecret.trim()) {
      return { ok: false, message: 'Accounts must use appSecretRef; plaintext appSecret is not allowed' }
    }
    const appId = stringValue(account.appId)
    if (!appId) return { ok: false, message: `Account ${index + 1} is missing appId` }
    if (!isPlatformSecretRef(account.appSecretRef)) {
      return { ok: false, message: `Account ${index + 1} is missing appSecretRef` }
    }
    const connectionMode = connectionModeValue(account.connectionMode)
    if (account.connectionMode !== undefined && !connectionMode) {
      return { ok: false, message: `Account ${index + 1} has unsupported connectionMode` }
    }
    accounts.push({
      id: stringValue(account.id) ?? `account-${index + 1}`,
      name: stringValue(account.name),
      enabled: account.enabled === undefined ? true : account.enabled === true,
      appId,
      appSecretRef: account.appSecretRef,
      defaultDirectory: stringValue(account.defaultDirectory),
      connectionMode: connectionMode ?? fallbackMode,
    })
  }

  return { ok: true, accounts }
}

function dedupeAccounts(accounts: FeishuIMAccount[]): FeishuIMAccount[] {
  const seen = new Set<string>()
  const output: FeishuIMAccount[] = []
  for (const account of accounts) {
    if (seen.has(account.id)) continue
    seen.add(account.id)
    output.push(account)
  }
  return output
}

function readPolicy(settings: Record<string, unknown>): FeishuIMPolicy {
  return {
    dmPolicy: settings.imDmPolicy === 'deny' ? 'deny' : 'allow',
    groupPolicy: settings.imGroupPolicy === 'allow' || settings.imGroupPolicy === 'deny'
      ? settings.imGroupPolicy
      : 'mention-only',
    allowFrom: stringListValue(settings.imAllowFrom),
    replyMode: settings.imReplyMode === 'thread' ? 'thread' : 'message',
    replyPresentation: replyPresentationValue(settings.imReplyPresentation) ?? 'auto',
    replyTimeoutMs: numberValue(settings.imReplyTimeoutMs, FEISHU_IM_DEFAULT_REPLY_TIMEOUT_MS),
    streamingCardUpdateMs: numberValue(settings.imStreamingCardUpdateMs, FEISHU_IM_DEFAULT_STREAMING_CARD_UPDATE_MS),
    streamingCardMaxChars: numberValue(settings.imStreamingCardMaxChars, FEISHU_IM_DEFAULT_STREAMING_CARD_MAX_CHARS),
    messageBufferMs: numberValue(settings.imMessageBufferMs, FEISHU_IM_DEFAULT_BUFFER_MS),
    maxBufferMs: numberValue(settings.imMaxBufferMs, FEISHU_IM_DEFAULT_MAX_BUFFER_MS),
    busyRejectText: stringValue(settings.imBusyRejectText) ?? FEISHU_IM_DEFAULT_BUSY_TEXT,
  }
}

function readLegacyState(input: unknown): FeishuIMLegacyState {
  const record = asRecord(input)
  return {
    enabled: record?.enabled === true,
    mode: stringValue(record?.mode),
    appId: stringValue(record?.appId),
    hasAppSecret: Boolean(stringValue(record?.appSecret)),
    defaultDirectory: stringValue(record?.defaultDirectory),
  }
}

function connectionModeValue(input: unknown): FeishuIMConnectionMode | undefined {
  return input === undefined || input === null || input === '' || input === 'websocket' ? 'websocket' : undefined
}

function replyPresentationValue(input: unknown): FeishuIMPolicy['replyPresentation'] | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (input === 'auto' || input === 'text' || input === 'card' || input === 'streaming-card') return input
  return undefined
}

function booleanValue(input: unknown): boolean | undefined {
  return typeof input === 'boolean' ? input : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function stringListValue(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function numberValue(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : fallback
}

function validNumber(input: unknown, min: number): boolean {
  return typeof input === 'number' && Number.isFinite(input) && input >= min
}
