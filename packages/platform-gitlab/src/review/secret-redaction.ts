const ANSI_BOUNDARY = '\u0000'
const INTERNAL_STABLE_MARKER = '\u0001'
const INTERNAL_CONTINUED_MARKER = '\u0002'
const INTERNAL_YAML_MARKER = '\u0003'
const GITLAB_TOKEN_PREFIX = /(?:glpat|gloas|gldt|glrtr?|glcbt|glptt|glft|glimt|glagent|glwt|glsoat|glffct)-[A-Za-z0-9._-]+/gi

export function redactGitLabSecrets(input: string) {
  const normalized = input
    .replace(/[\u0001-\u0003]/g, ANSI_BOUNDARY)
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, ANSI_BOUNDARY)
  const boundaryRedacted = redactSensitiveAssignments(normalized, true)
    .replaceAll(ANSI_BOUNDARY, '')
  const structurallyRedacted = redactSensitiveAssignments(boundaryRedacted)
    .replace(/[\u0001-\u0003]/g, '***')

  return structurallyRedacted
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/gi,
      '[REDACTED_KEY_BLOCK]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1***:***@')
    .replace(GITLAB_TOKEN_PREFIX, '***')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '***')
}

type SensitiveKeyCandidate = {
  key: string
  separator: ':' | '='
  separatorIndex: number
  query: boolean
  keyStart: number
  enclosingQuoteEnd?: number
}

type SensitiveValueMode = 'stable' | 'continued' | 'yaml'

type SensitiveValueRange = {
  end: number
  mode: SensitiveValueMode
}

function redactSensitiveAssignments(input: string, useInternalMarkers = false) {
  const output: string[] = []
  let cursor = 0
  let index = 0

  while (index < input.length) {
    const candidate = readSensitiveKeyCandidate(input, index)
    if (!candidate || !isSensitiveKey(candidate.key)) {
      index += 1
      continue
    }

    const valueStart = skipHorizontalWhitespace(input, candidate.separatorIndex + 1)
    const value = sensitiveValueRange(input, valueStart, candidate)
    const markerFirst = candidate.enclosingQuoteEnd === valueStart ? undefined : input[valueStart]
    const marker = useInternalMarkers ? internalMarker(value.mode) : '***'
    output.push(input.slice(cursor, valueStart), redactionMarker(markerFirst, marker))
    cursor = Math.max(valueStart, value.end)
    index = cursor > index ? cursor : index + 1
  }

  output.push(input.slice(cursor))
  return output.join('')
}

function readSensitiveKeyCandidate(input: string, start: number): SensitiveKeyCandidate | undefined {
  const first = input[start]
  if (!first) return undefined

  let key: string
  let keyEnd: number
  if (first === '"' || first === "'") {
    if (!isQuotedKeyStart(input, start)) return undefined
    keyEnd = quotedValueEnd(input, start)
    if (keyEnd >= input.length && input[keyEnd - 1] !== first) return undefined
    key = decodeKey(input.slice(start + 1, keyEnd - 1), first)
  } else {
    if (!isKeyCharacter(first) || (start > 0 && isKeyCharacter(input[start - 1]!))) return undefined
    keyEnd = start + 1
    while (keyEnd < input.length && isKeyContinuationCharacter(input[keyEnd]!)) keyEnd += 1
    key = decodeKey(input.slice(start, keyEnd))
  }

  const separatorIndex = skipHorizontalWhitespace(input, keyEnd)
  const separator = input[separatorIndex]
  if (separator !== ':' && separator !== '=') return undefined
  const enclosingQuoteEnd = enclosingValueEnd(input, start, separatorIndex)
  return {
    key,
    separator,
    separatorIndex,
    query: separator === '=' && isQueryKey(input, start),
    keyStart: start,
    ...(enclosingQuoteEnd === undefined ? {} : { enclosingQuoteEnd }),
  }
}

function decodeKey(raw: string, quote?: string) {
  const cleanRaw = raw.replaceAll(ANSI_BOUNDARY, '')
  let decoded = cleanRaw
  if (quote === '"') {
    try {
      decoded = JSON.parse(`"${cleanRaw}"`) as string
    } catch {
      decoded = decodeBackslashEscapes(cleanRaw)
    }
  } else if (quote === "'") {
    decoded = decodeBackslashEscapes(cleanRaw.replace(/''/g, "'"))
  }

  for (let count = 0; count < 2; count += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded.replace(/\+/g, '%20'))
    } catch {
      next = decoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)))
    }
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

function decodeBackslashEscapes(value: string) {
  return value
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hex: string) => safeCodePoint(hex))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => safeCodePoint(hex))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => safeCodePoint(hex))
    .replace(/\\(.)/gs, '$1')
}

function safeCodePoint(hex: string) {
  const value = Number.parseInt(hex, 16)
  return Number.isFinite(value) && value <= 0x10FFFF ? String.fromCodePoint(value) : ''
}

function isSensitiveKey(value: string) {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const parts = normalized.split('_').filter(Boolean)
  if (normalized === 'gitlab_session') return true
  if (parts.some((part) => [
    'auth',
    'auths',
    'authorization',
    'token',
    'tokens',
    'password',
    'passwords',
    'passwd',
    'pwd',
    'secret',
    'secrets',
  ].includes(part))) {
    return true
  }
  const pairs = [
    ['api', 'key'],
    ['access', 'key'],
    ['private', 'key'],
    ['database', 'url'],
    ['db', 'url'],
    ['redis', 'url'],
  ]
  if (pairs.some(([left, right]) => hasAdjacentParts(parts, left!, right!))) return true
  return ['apikey', 'accesskey', 'privatekey', 'clientsecret', 'databaseurl', 'dburl', 'redisurl']
    .includes(parts.join(''))
}

function hasAdjacentParts(parts: string[], left: string, right: string) {
  return parts.some((part, index) => part === left && parts[index + 1] === right)
}

function sensitiveValueRange(
  input: string,
  start: number,
  candidate: SensitiveKeyCandidate,
): SensitiveValueRange {
  if (start >= input.length) return stableValue(input.length)
  if (input.startsWith(INTERNAL_STABLE_MARKER, start)) {
    return stableValue(start + INTERNAL_STABLE_MARKER.length)
  }
  if (input.startsWith(INTERNAL_CONTINUED_MARKER, start)) {
    return { end: continuedLineValueEnd(input, start), mode: 'continued' }
  }
  if (input.startsWith(INTERNAL_YAML_MARKER, start)) {
    return { end: yamlBlockValueEnd(input, start, candidate.keyStart), mode: 'yaml' }
  }
  if (candidate.enclosingQuoteEnd !== undefined) return stableValue(candidate.enclosingQuoteEnd)
  if (candidate.query) return stableValue(queryValueEnd(input, start))

  const first = input[start]
  if (first === '"' || first === "'") {
    const end = quotedValueEnd(input, start)
    if (end >= input.length) return stableValue(input.length)
    const next = skipHorizontalWhitespace(input, end)
    return isStructuredValueDelimiter(input[next]) || input[next] === ';'
      ? stableValue(end)
      : { end: continuedLineValueEnd(input, end), mode: 'continued' }
  }
  if (candidate.separator === ':' && isYamlBlockMarker(input, start)) {
    return { end: yamlBlockValueEnd(input, start, candidate.keyStart), mode: 'yaml' }
  }
  if (first === '{' || first === '[') return stableValue(balancedValueEnd(input, start))
  if (first === '\r' || first === '\n') return stableValue(input.length)
  return { end: continuedLineValueEnd(input, start), mode: 'continued' }
}

function stableValue(end: number): SensitiveValueRange {
  return { end, mode: 'stable' }
}

function internalMarker(mode: SensitiveValueMode) {
  if (mode === 'continued') return INTERNAL_CONTINUED_MARKER
  if (mode === 'yaml') return INTERNAL_YAML_MARKER
  return INTERNAL_STABLE_MARKER
}

function queryValueEnd(input: string, start: number) {
  const first = input[start]
  if (first === '"' || first === "'") return quotedValueEnd(input, start)
  let end = start
  while (end < input.length && !['&', '#', ' ', '\t', '\r', '\n', '"', "'"].includes(input[end]!)) end += 1
  return end
}

function quotedValueEnd(input: string, start: number) {
  const quote = input[start]
  let index = start + 1
  while (index < input.length) {
    const current = input[index]
    if (current === '\\') {
      index = Math.min(input.length, index + 2)
      continue
    }
    if (current === quote) {
      if (quote === "'" && input[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index += 1
  }
  return input.length
}

function balancedValueEnd(input: string, start: number) {
  const stack = [input[start]!]
  let quote: string | undefined
  let index = start + 1
  while (index < input.length) {
    const current = input[index]!
    if (quote) {
      if (current === '\\') {
        index = Math.min(input.length, index + 2)
        continue
      }
      if (current === quote) {
        if (quote === "'" && input[index + 1] === quote) {
          index += 2
          continue
        }
        quote = undefined
      }
      index += 1
      continue
    }
    if (current === '"' || current === "'") {
      quote = current
    } else if (current === '{' || current === '[') {
      stack.push(current)
    } else if ((current === '}' && stack.at(-1) === '{') || (current === ']' && stack.at(-1) === '[')) {
      stack.pop()
      if (stack.length === 0) return index + 1
    }
    index += 1
  }
  return input.length
}

function redactionMarker(first: string | undefined, marker: string) {
  return first === '"' || first === "'" ? `${first}${marker}${first}` : marker
}

function enclosingValueEnd(input: string, keyStart: number, separatorIndex: number) {
  const quoteStart = keyStart - 1
  const quote = input[quoteStart]
  if ((quote !== '"' && quote !== "'") || !isQuotedKeyStart(input, quoteStart)) return undefined
  const quoteEnd = quotedValueEnd(input, quoteStart)
  return quoteEnd > separatorIndex + 1 ? quoteEnd - 1 : undefined
}

function isQuotedKeyStart(input: string, index: number) {
  if (isEscaped(input, index)) return false
  if (index === 0) return true
  const previous = input[index - 1]!
  return previous === ANSI_BOUNDARY
    || previous === ' '
    || previous === '\t'
    || previous === '\r'
    || previous === '\n'
    || ['{', '[', '(', ',', ';', ':', '='].includes(previous)
}

function isEscaped(input: string, index: number) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function isStructuredValueDelimiter(value: string | undefined) {
  return value === undefined || value === ',' || value === '}' || value === ']' || value === '\r' || value === '\n'
}

function isQueryKey(input: string, start: number) {
  return start > 0 && ['?', '&', '#'].includes(input[start - 1]!)
}

function lineEnd(input: string, start: number) {
  let end = start
  while (end < input.length && input[end] !== '\r' && input[end] !== '\n') end += 1
  return end
}

function continuedLineValueEnd(input: string, start: number) {
  let segmentStart = start
  let end = lineEnd(input, segmentStart)
  while (end < input.length) {
    const nextStart = nextLineStart(input, end)
    if (nextStart >= input.length) break
    const contentStart = skipAnsiBoundaries(input, nextStart)
    const continued = hasTrailingContinuation(input, segmentStart, end)
      || input[contentStart] === ' '
      || input[contentStart] === '\t'
    if (!continued) break
    segmentStart = nextStart
    end = lineEnd(input, segmentStart)
  }
  return end
}

function hasTrailingContinuation(input: string, start: number, end: number) {
  let cursor = end - 1
  while (cursor >= start && (input[cursor] === ' ' || input[cursor] === '\t')) cursor -= 1
  let slashes = 0
  while (cursor >= start && input[cursor] === '\\') {
    slashes += 1
    cursor -= 1
  }
  return slashes % 2 === 1
}

function isYamlBlockMarker(input: string, start: number) {
  const marker = input.slice(start, lineEnd(input, start)).replaceAll(ANSI_BOUNDARY, '').trim()
  return /^[|>](?:[+-][1-9]?|[1-9][+-]?)?(?:[ \t]+#.*)?$/.test(marker)
}

function yamlBlockValueEnd(input: string, start: number, keyStart: number) {
  const keyLineStart = previousLineStart(input, keyStart)
  const baseIndent = horizontalIndent(input, keyLineStart)
  let end = lineEnd(input, start)
  let nextStart = nextLineStart(input, end)
  while (nextStart < input.length) {
    const nextEnd = lineEnd(input, nextStart)
    const line = input.slice(nextStart, nextEnd).replaceAll(ANSI_BOUNDARY, '')
    if (line.trim().length > 0 && horizontalIndent(input, nextStart) <= baseIndent) break
    end = nextEnd
    nextStart = nextLineStart(input, nextEnd)
  }
  return end
}

function previousLineStart(input: string, index: number) {
  const newline = Math.max(input.lastIndexOf('\n', index - 1), input.lastIndexOf('\r', index - 1))
  return newline < 0 ? 0 : newline + 1
}

function nextLineStart(input: string, end: number) {
  let start = end
  if (input[start] === '\r') start += 1
  if (input[start] === '\n') start += 1
  return start
}

function horizontalIndent(input: string, start: number) {
  let index = start
  let indent = 0
  while (input[index] === ANSI_BOUNDARY || input[index] === ' ' || input[index] === '\t') {
    if (input[index] !== ANSI_BOUNDARY) indent += 1
    index += 1
  }
  return indent
}

function skipAnsiBoundaries(input: string, start: number) {
  let index = start
  while (input[index] === ANSI_BOUNDARY) index += 1
  return index
}

function skipHorizontalWhitespace(input: string, start: number) {
  let index = start
  while (input[index] === ANSI_BOUNDARY || input[index] === ' ' || input[index] === '\t') index += 1
  return index
}

function isKeyCharacter(value: string) {
  const code = value.charCodeAt(0)
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || ['_', '-', '.', '%', '+'].includes(value)
}

function isKeyContinuationCharacter(value: string) {
  return value === ANSI_BOUNDARY || isKeyCharacter(value)
}
