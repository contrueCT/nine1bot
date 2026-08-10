const MAX_TEXT_BYTES = 64 * 1024
const MAX_DIAGNOSTIC_BYTES = 4 * 1024
const MAX_METADATA_BYTES = 32 * 1024
const MAX_METADATA_DEPTH = 8
const MAX_METADATA_ARRAY = 100
const MAX_METADATA_KEYS = 200
const REDACTED = "[REDACTED]"

const AUTHORIZATION_HEADER = /\bauthorization\s*:\s*[^\r\n]+/gi
const COOKIE_HEADER = /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi
const BEARER_VALUE = /\bbearer\s+[a-z0-9._~+/=-]+/gi
const CREDENTIAL_VALUE =
  /((?:["']?)(?:authorization|cookie|access[_-]?token|refresh[_-]?token|token|secret|password|credential|api[-_]?key)(?:["']?)\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|credential|api[-_]?key/i
const UNSAFE_RESULT_KEY = /^(?:attachments?|files?|binary|blob|bytes|base64)$/i

export function sanitizePlatformToolText(value: unknown, maxBytes = MAX_TEXT_BYTES) {
  const input = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)
  const redacted = input
    .replace(AUTHORIZATION_HEADER, `Authorization: ${REDACTED}`)
    .replace(COOKIE_HEADER, `Cookie: ${REDACTED}`)
    .replace(BEARER_VALUE, `Bearer ${REDACTED}`)
    .replace(CREDENTIAL_VALUE, `$1${REDACTED}`)
  return truncateUtf8(redacted, maxBytes)
}

export function sanitizePlatformToolDiagnostic(value: unknown) {
  return sanitizePlatformToolText(value, MAX_DIAGNOSTIC_BYTES)
}

export function sanitizePlatformToolRecord(value: unknown): Record<string, unknown> {
  let normalized: unknown
  try {
    normalized = visit(value, new WeakSet<object>(), 0)
  } catch {
    return {}
  }
  if (!isRecord(normalized)) return {}
  try {
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_METADATA_BYTES) {
      return { truncated: true, reason: "metadata-size-limit" }
    }
  } catch {
    return {}
  }
  return normalized
}

function visit(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_METADATA_DEPTH) return undefined
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") return sanitizePlatformToolText(value)
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "object") return undefined
  if (seen.has(value)) return undefined
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const item of value.slice(0, MAX_METADATA_ARRAY)) {
        const normalized = visit(item, seen, depth + 1)
        if (normalized !== undefined) result.push(normalized)
      }
      return result
    }

    const result: Record<string, unknown> = {}
    let count = 0
    for (const key of Object.keys(value)) {
      if (count >= MAX_METADATA_KEYS) break
      if (SENSITIVE_KEY.test(key) || UNSAFE_RESULT_KEY.test(key)) continue
      let item: unknown
      try {
        item = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const normalized = visit(item, seen, depth + 1)
      if (normalized === undefined) continue
      result[key] = normalized
      count += 1
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncateUtf8(value: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return ""
  const encoded = Buffer.from(value, "utf8")
  if (encoded.byteLength <= maxBytes) return value

  const suffix = "…[truncated]"
  const suffixBytes = Buffer.byteLength(suffix, "utf8")
  if (suffixBytes >= maxBytes) {
    return Buffer.from(encoded.subarray(0, maxBytes)).toString("utf8").replace(/\uFFFD+$/g, "")
  }
  return `${Buffer.from(encoded.subarray(0, maxBytes - suffixBytes))
    .toString("utf8")
    .replace(/\uFFFD+$/g, "")}${suffix}`
}
