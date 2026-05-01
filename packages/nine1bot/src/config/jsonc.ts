export function stripJsonComments(jsonc: string): string {
  let result = ''
  let inString = false
  let escaped = false
  let inSingleLineComment = false
  let inMultiLineComment = false
  let index = 0

  while (index < jsonc.length) {
    const char = jsonc[index]
    const nextChar = jsonc[index + 1]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      index++
      continue
    }

    if (!inSingleLineComment && !inMultiLineComment && char === '"') {
      inString = true
      escaped = false
      result += char
      index++
      continue
    }

    if (!inMultiLineComment && char === '/' && nextChar === '/') {
      inSingleLineComment = true
      index += 2
      continue
    }

    if (!inSingleLineComment && char === '/' && nextChar === '*') {
      inMultiLineComment = true
      index += 2
      continue
    }

    if (inSingleLineComment && char === '\n') {
      inSingleLineComment = false
      result += char
      index++
      continue
    }

    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false
      index += 2
      continue
    }

    if (!inSingleLineComment && !inMultiLineComment) result += char
    index++
  }

  return result
}

export function upsertTopLevelJsoncProperty(input: {
  jsonc: string
  key: string
  value: unknown
}): string {
  const original = input.jsonc
  if (!original.trim()) {
    return `${JSON.stringify({ [input.key]: input.value }, null, 2)}\n`
  }

  const root = findRootObject(original)
  if (!root) {
    return `${JSON.stringify({ [input.key]: input.value }, null, 2)}\n`
  }

  const existing = findTopLevelProperty(original, root.start, root.end, input.key)
  if (existing) {
    const indent = lineIndent(original, existing.start)
    const property = formatProperty(input.key, input.value, indent)
    return `${original.slice(0, existing.start)}${property}${original.slice(existing.end)}`
  }

  const inner = original.slice(root.start + 1, root.end)
  const hasProperties = stripJsonComments(inner).trim().length > 0
  const rootIndent = lineIndent(original, root.start)
  const propertyIndent = `${rootIndent}  `
  const property = formatProperty(input.key, input.value, propertyIndent)
  const insertion = `${hasProperties ? ',' : ''}\n${property}\n${rootIndent}`
  return `${original.slice(0, root.end)}${insertion}${original.slice(root.end)}`
}

function findRootObject(input: string): { start: number; end: number } | undefined {
  const state = createScannerState()
  let start = -1
  let depth = 0

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const nextChar = input[index + 1]
    const consumed = updateScannerState(state, char, nextChar)
    if (consumed) {
      index += consumed - 1
      continue
    }
    if (state.inString || state.inSingleLineComment || state.inMultiLineComment) continue

    if (char === '{') {
      if (depth === 0) start = index
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) return { start, end: index }
    }
  }

  return undefined
}

function findTopLevelProperty(
  input: string,
  rootStart: number,
  rootEnd: number,
  key: string,
): { start: number; end: number } | undefined {
  const state = createScannerState()
  let depth = 1
  let index = rootStart + 1

  while (index < rootEnd) {
    const char = input[index]
    const nextChar = input[index + 1]
    if (!state.inString && !state.inSingleLineComment && !state.inMultiLineComment && depth === 1 && char === '"') {
      const parsedKey = readJsonString(input, index)
      if (!parsedKey) {
        index++
        continue
      }
      let cursor = skipWhitespaceAndComments(input, parsedKey.end)
      if (input[cursor] !== ':') {
        index = parsedKey.end
        continue
      }
      cursor = skipWhitespaceAndComments(input, cursor + 1)
      const valueEnd = findPropertyValueEnd(input, cursor, rootEnd)
      if (parsedKey.value === key) {
        return {
          start: index,
          end: trimEndIndex(input, valueEnd),
        }
      }
      index = valueEnd
      continue
    }

    const consumed = updateScannerState(state, char, nextChar)
    if (consumed) {
      index += consumed
      continue
    }
    if (state.inString || state.inSingleLineComment || state.inMultiLineComment) {
      index++
      continue
    }

    if (char === '{' || char === '[') {
      depth++
      index++
      continue
    }
    if (char === '}' || char === ']') {
      depth--
      index++
      continue
    }

    index++
  }

  return undefined
}

function findPropertyValueEnd(input: string, valueStart: number, rootEnd: number): number {
  const state = createScannerState()
  let depth = 0
  let index = valueStart

  while (index < rootEnd) {
    const char = input[index]
    const nextChar = input[index + 1]
    const consumed = updateScannerState(state, char, nextChar)
    if (consumed) {
      index += consumed
      continue
    }
    if (state.inString || state.inSingleLineComment || state.inMultiLineComment) {
      index++
      continue
    }

    if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
    else if (depth === 0 && char === ',') return index

    index++
  }

  return rootEnd
}

function readJsonString(input: string, start: number): { value: string; end: number } | undefined {
  let index = start + 1
  let escaped = false
  while (index < input.length) {
    const char = input[index]
    if (escaped) {
      escaped = false
      index++
      continue
    }
    if (char === '\\') {
      escaped = true
      index++
      continue
    }
    if (char === '"') {
      const raw = input.slice(start, index + 1)
      try {
        return {
          value: JSON.parse(raw),
          end: index + 1,
        }
      } catch {
        return undefined
      }
    }
    index++
  }
  return undefined
}

function skipWhitespaceAndComments(input: string, start: number): number {
  let index = start
  while (index < input.length) {
    if (/\s/.test(input[index])) {
      index++
      continue
    }
    if (input[index] === '/' && input[index + 1] === '/') {
      index += 2
      while (index < input.length && input[index] !== '\n') index++
      continue
    }
    if (input[index] === '/' && input[index + 1] === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index++
      index += 2
      continue
    }
    return index
  }
  return index
}

function trimEndIndex(input: string, end: number) {
  let index = end
  while (index > 0 && /\s/.test(input[index - 1])) index--
  return index
}

function lineIndent(input: string, index: number) {
  const lineStart = input.lastIndexOf('\n', index - 1) + 1
  const match = input.slice(lineStart, index).match(/^[ \t]*/)
  return match?.[0] ?? ''
}

function formatProperty(key: string, value: unknown, indent: string) {
  const rendered = JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n')
  return `${indent}${JSON.stringify(key)}: ${rendered}`
}

function createScannerState() {
  return {
    inString: false,
    escaped: false,
    inSingleLineComment: false,
    inMultiLineComment: false,
  }
}

function updateScannerState(
  state: ReturnType<typeof createScannerState>,
  char: string,
  nextChar: string,
): number {
  if (state.inString) {
    if (state.escaped) {
      state.escaped = false
    } else if (char === '\\') {
      state.escaped = true
    } else if (char === '"') {
      state.inString = false
    }
    return 0
  }
  if (!state.inSingleLineComment && !state.inMultiLineComment && char === '"') {
    state.inString = true
    state.escaped = false
    return 0
  }
  if (!state.inMultiLineComment && char === '/' && nextChar === '/') {
    state.inSingleLineComment = true
    return 2
  }
  if (!state.inSingleLineComment && char === '/' && nextChar === '*') {
    state.inMultiLineComment = true
    return 2
  }
  if (state.inSingleLineComment && char === '\n') {
    state.inSingleLineComment = false
    return 0
  }
  if (state.inMultiLineComment && char === '*' && nextChar === '/') {
    state.inMultiLineComment = false
    return 2
  }
  return 0
}
