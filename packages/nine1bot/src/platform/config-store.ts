import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { PlatformManagerConfig } from './manager'

export class PlatformConfigPathMissingError extends Error {
  constructor() {
    super('NINE1BOT_CONFIG_PATH is not configured')
    this.name = 'PlatformConfigPathMissingError'
  }
}

export type PlatformConfigDocument = Record<string, unknown> & {
  platforms?: PlatformManagerConfig
}

export function getPlatformConfigPath(configPath = process.env.NINE1BOT_CONFIG_PATH): string {
  if (!configPath) throw new PlatformConfigPathMissingError()
  return configPath
}

export async function readPlatformConfigDocument(configPath = getPlatformConfigPath()): Promise<PlatformConfigDocument> {
  const text = await readFile(configPath, 'utf-8').catch((error: any) => {
    if (error?.code === 'ENOENT') return '{}'
    throw error
  })
  const parsed = JSON.parse(stripJsonComments(text) || '{}')
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as PlatformConfigDocument
    : {}
}

export async function readPlatformManagerConfig(configPath = getPlatformConfigPath()): Promise<PlatformManagerConfig> {
  const document = await readPlatformConfigDocument(configPath)
  return normalizePlatforms(document.platforms)
}

export async function writePlatformManagerConfig(
  platforms: PlatformManagerConfig,
  configPath = getPlatformConfigPath(),
): Promise<PlatformConfigDocument> {
  const document = await readPlatformConfigDocument(configPath)
  const nextDocument: PlatformConfigDocument = {
    ...document,
    platforms: normalizePlatforms(platforms),
  }
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(nextDocument, null, 2)}\n`, 'utf-8')
  return nextDocument
}

function normalizePlatforms(input: unknown): PlatformManagerConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const normalized: PlatformManagerConfig = {}
  for (const [platformId, entry] of Object.entries(input as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      normalized[platformId] = {}
      continue
    }
    const record = entry as Record<string, unknown>
    normalized[platformId] = {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      features: record.features && typeof record.features === 'object' && !Array.isArray(record.features)
        ? Object.fromEntries(
            Object.entries(record.features as Record<string, unknown>)
              .filter((item): item is [string, boolean] => typeof item[1] === 'boolean'),
          )
        : {},
      settings: record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)
        ? { ...(record.settings as Record<string, unknown>) }
        : {},
    }
  }
  return normalized
}

function stripJsonComments(jsonc: string): string {
  let result = ''
  let inString = false
  let inSingleLineComment = false
  let inMultiLineComment = false
  let index = 0

  while (index < jsonc.length) {
    const char = jsonc[index]
    const nextChar = jsonc[index + 1]

    if (!inSingleLineComment && !inMultiLineComment && char === '"' && jsonc[index - 1] !== '\\') {
      inString = !inString
      result += char
      index++
      continue
    }

    if (inString) {
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
