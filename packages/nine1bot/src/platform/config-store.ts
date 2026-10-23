import { readFile } from 'fs/promises'
import { JsonFile } from '../../../../opencode/packages/opencode/src/util/json-file'
import type { PlatformManagerConfig } from './manager'
import { stripJsonComments } from '../config/jsonc'
import { loadConfigDocument } from '../config/loader'
import { isDeepStrictEqual } from 'node:util'

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

export async function readPlatformManagerConfig(
  configPath = getPlatformConfigPath(),
  options: { globalConfigPath?: string } = {},
): Promise<PlatformManagerConfig> {
  const document = await loadConfigDocument(configPath, undefined, { ...options, strictGlobalConfig: true })
  return normalizePlatforms(document.platforms)
}

export async function writePlatformManagerConfig(
  platforms: PlatformManagerConfig,
  configPath = getPlatformConfigPath(),
  previousEffective?: PlatformManagerConfig,
): Promise<PlatformConfigDocument> {
  return await JsonFile.update(configPath, (document) => {
    if (previousEffective === undefined) {
      document.platforms = normalizePlatforms(platforms)
      return
    }
    // Apply only edits to this source. Inherited values and {env:...}
    // expressions must not be copied from the resolved runtime snapshot.
    document.platforms = applyChanges(
      objectRecord(document.platforms),
      previousEffective,
      platforms,
    )
  }) as PlatformConfigDocument
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function applyChanges(source: Record<string, any>, before: Record<string, any>, after: Record<string, any>): Record<string, any> {
  const result = { ...source }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue
    if (!(key in after)) {
      // null masks inherited settings during the source merge.
      result[key] = null
    } else if (after[key] && typeof after[key] === 'object' && !Array.isArray(after[key]) && before[key] && typeof before[key] === 'object' && !Array.isArray(before[key])) {
      result[key] = applyChanges(objectRecord(source[key]), before[key], after[key])
    } else {
      result[key] = after[key]
    }
  }
  return result
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
        ? Object.fromEntries(Object.entries(record.settings as Record<string, unknown>).filter(([, value]) => value !== null))
        : {},
    }
  }
  return normalized
}
