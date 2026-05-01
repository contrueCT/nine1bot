import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { PlatformManagerConfig } from './manager'
import { stripJsonComments, upsertTopLevelJsoncProperty } from '../config/jsonc'

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
  const originalText = await readFile(configPath, 'utf-8').catch((error: any) => {
    if (error?.code === 'ENOENT') return ''
    throw error
  })
  const document = await readPlatformConfigDocument(configPath)
  const normalizedPlatforms = normalizePlatforms(platforms)
  const nextDocument: PlatformConfigDocument = {
    ...document,
    platforms: normalizedPlatforms,
  }
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    upsertTopLevelJsoncProperty({
      jsonc: originalText,
      key: 'platforms',
      value: normalizedPlatforms,
    }),
    'utf-8',
  )
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
