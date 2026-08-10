const MAX_TEXT_BYTES = 64 * 1024
const MAX_DIAGNOSTIC_BYTES = 4 * 1024
const REDACTED = "[REDACTED]"

const AUTHORIZATION_HEADER = /\bauthorization\s*:\s*[^\r\n]+/gi
const COOKIE_HEADER = /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi
const BEARER_VALUE = /\bbearer\s+[a-z0-9._~+/=-]+/gi
const CREDENTIAL_VALUE =
  /((?:["']?)(?:authorization|cookie|access[_-]?token|refresh[_-]?token|token|secret|password|credential|api[-_]?key)(?:["']?)\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi

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
