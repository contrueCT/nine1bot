import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'

function stripJsonComments(jsonc: string): string {
  let result = ''
  let inString = false
  let inSingleLineComment = false
  let inMultiLineComment = false
  let i = 0

  while (i < jsonc.length) {
    const char = jsonc[i]
    const nextChar = jsonc[i + 1]

    if (!inSingleLineComment && !inMultiLineComment && char === '"' && jsonc[i - 1] !== '\\') {
      inString = !inString
      result += char
      i++
      continue
    }

    if (inString) {
      result += char
      i++
      continue
    }

    if (!inMultiLineComment && char === '/' && nextChar === '/') {
      inSingleLineComment = true
      i += 2
      continue
    }

    if (!inSingleLineComment && char === '/' && nextChar === '*') {
      inMultiLineComment = true
      i += 2
      continue
    }

    if (inSingleLineComment && char === '\n') {
      inSingleLineComment = false
      result += char
      i++
      continue
    }

    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false
      i += 2
      continue
    }

    if (!inSingleLineComment && !inMultiLineComment) {
      result += char
    }

    i++
  }

  return result
}

export async function readRawConfig(configPath: string): Promise<Record<string, any>> {
  try {
    const content = await readFile(configPath, 'utf-8')
    const sanitized = stripJsonComments(content)
    const parsed = JSON.parse(sanitized)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

export async function writeRawConfig(configPath: string, config: Record<string, any>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}
