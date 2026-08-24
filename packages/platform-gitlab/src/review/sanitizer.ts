import { redactGitLabSecrets } from './secret-redaction'

const DEFAULT_INPUT_CODE_UNITS = 16_000
const DEFAULT_INPUT_UTF8_BYTES = 16_000
const DEFAULT_OUTPUT_CODE_UNITS = 4_096
const DEFAULT_OUTPUT_UTF8_BYTES = 4_096
const API_ERROR_DETAIL_CODE_UNITS = 240
const API_ERROR_DETAIL_UTF8_BYTES = 240

export type GitLabSanitizerLimits = {
  maxInputCodeUnits?: number
  maxInputUtf8Bytes?: number
  maxOutputCodeUnits?: number
  maxOutputUtf8Bytes?: number
}

export function sanitizeGitLabSecrets(input: string, limits: GitLabSanitizerLimits = {}) {
  const boundedInput = boundText(
    input,
    limits.maxInputCodeUnits ?? DEFAULT_INPUT_CODE_UNITS,
    limits.maxInputUtf8Bytes ?? DEFAULT_INPUT_UTF8_BYTES,
  )
  const sanitized = redactGitLabSecrets(boundedInput)
    .replace(
      /(["']?(?:authorization|private[-_ ]?token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|db[_-]?url|redis[_-]?url)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^,}\r\n\s]+)/gi,
      '$1***',
    )
    .replace(/\bglpat-[A-Za-z0-9._-]*/gi, '***')
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)$/gi,
      '$1***:***',
    )
  return boundText(
    sanitized,
    limits.maxOutputCodeUnits ?? DEFAULT_OUTPUT_CODE_UNITS,
    limits.maxOutputUtf8Bytes ?? DEFAULT_OUTPUT_UTF8_BYTES,
  )
}

export function sanitizeGitLabApiErrorDetail(responseBody: string | undefined) {
  if (!responseBody) return undefined
  const boundedBody = boundText(responseBody, DEFAULT_INPUT_CODE_UNITS, DEFAULT_INPUT_UTF8_BYTES).trim()
  if (!boundedBody) return undefined
  const candidate = extractApiErrorCandidate(boundedBody)
  if (!candidate) return undefined
  const sanitized = sanitizeGitLabSecrets(candidate, {
    maxInputCodeUnits: API_ERROR_DETAIL_CODE_UNITS,
    maxInputUtf8Bytes: API_ERROR_DETAIL_UTF8_BYTES,
    maxOutputCodeUnits: API_ERROR_DETAIL_CODE_UNITS,
    maxOutputUtf8Bytes: API_ERROR_DETAIL_UTF8_BYTES,
  }).replace(/\s+/g, ' ').trim()
  if (!isHarmlessPositionDetail(sanitized)) return undefined
  return sanitized.replace(/[.!]+$/, '') || undefined
}

function extractApiErrorCandidate(body: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (typeof parsed === 'string') return parsed
  if (!isRecord(parsed)) return undefined
  for (const key of ['error', 'message']) {
    const value = parsed[key]
    if (typeof value === 'string') return value
    if (!isRecord(value)) continue
    const position = value.position
    if (typeof position === 'string') return 'position ' + position
    if (Array.isArray(position)) {
      const details = position.filter((item): item is string => typeof item === 'string')
      if (details.length > 0) return 'position ' + details.join(' ')
    }
  }
  return undefined
}

function isHarmlessPositionDetail(value: string) {
  return /^(?:(?:the\s+)?position\s+(?:(?:is|was)\s+)?(?:invalid|missing|required|unsupported|out of range|not found)|invalid(?:\s+diff)?\s+position)[.!]?$/i.test(value)
}

function boundText(value: string, maxCodeUnits: number, maxUtf8Bytes: number) {
  const codeUnitLimit = normalizedLimit(maxCodeUnits)
  const byteLimit = normalizedLimit(maxUtf8Bytes)
  if (codeUnitLimit === 0 || byteLimit === 0) return ''
  let bounded = value.slice(0, codeUnitLimit)
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1)
  const bytes = new TextEncoder().encode(bounded)
  if (bytes.byteLength <= byteLimit) return bounded
  return new TextDecoder().decode(bytes.slice(0, byteLimit)).replace(/\uFFFD$/, '')
}

function normalizedLimit(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
