import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asRecord } from './shared'
import type { PlatformAdapterContext, PlatformRuntimeSourcesDescriptor } from '@nine1bot/platform-protocol'

export const FEISHU_CURRENT_PAGE_SKILL = 'feishu-current-page'

const companionSkillsDirectory = fileURLToPath(new URL('../skills', import.meta.url))

export type FeishuSkillDirectoryInspection = {
  directory: string
  exists: boolean
  readable: boolean
  skillCount: number
  skills: string[]
  error?: string
}

export type FeishuSkillSources = {
  companionDirectory: string
  officialDirectory: string
}

export function feishuRuntimeSources(ctx: PlatformAdapterContext): PlatformRuntimeSourcesDescriptor {
  const sources = feishuSkillSources(ctx.settings)
  return {
    skills: [
      {
        id: 'feishu-companion-skills',
        directory: sources.companionDirectory,
        visibility: 'declared-only',
        lifecycle: 'platform-enabled',
      },
      {
        id: 'feishu-official-skills',
        directory: sources.officialDirectory,
        includeNamePrefix: 'lark-',
        visibility: 'default',
        lifecycle: 'platform-enabled',
      },
    ],
  }
}

export function feishuSkillSources(settings: unknown): FeishuSkillSources {
  return {
    companionDirectory: companionSkillsDirectory,
    officialDirectory: resolveOfficialSkillsDirectory(settings),
  }
}

export function inspectFeishuSkillSources(settings: unknown) {
  const sources = feishuSkillSources(settings)
  return {
    companion: inspectSkillDirectory(sources.companionDirectory, {
      names: [FEISHU_CURRENT_PAGE_SKILL],
    }),
    official: inspectSkillDirectory(sources.officialDirectory, {
      prefix: 'lark-',
    }),
  }
}

export function resolveOfficialSkillsDirectory(settings: unknown): string {
  const record = asRecord(settings)
  return normalizeDirectory(stringValue(record?.officialSkillsDirectory) ?? defaultOfficialSkillsDirectory())
}

export function defaultOfficialSkillsDirectory(): string {
  return join(homedir(), '.agents', 'skills')
}

export function normalizeDirectory(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return normalize(join(homedir(), trimmed.slice(2)))
  }
  return normalize(resolve(trimmed))
}

export function inspectSkillDirectory(
  directory: string,
  filter: { prefix?: string; names?: string[] } = {},
): FeishuSkillDirectoryInspection {
  const normalized = normalizeDirectory(directory)
  if (!existsSync(normalized)) {
    return {
      directory: normalized,
      exists: false,
      readable: false,
      skillCount: 0,
      skills: [],
      error: 'Directory does not exist',
    }
  }

  try {
    if (!statSync(normalized).isDirectory()) {
      return {
        directory: normalized,
        exists: true,
        readable: false,
        skillCount: 0,
        skills: [],
        error: 'Path is not a directory',
      }
    }

    const allowedNames = new Set(filter.names ?? [])
    const skills = readdirSync(normalized, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        if (filter.prefix && !name.startsWith(filter.prefix)) return false
        if (allowedNames.size > 0 && !allowedNames.has(name)) return false
        return existsSync(join(normalized, name, 'SKILL.md'))
      })
      .sort((left, right) => left.localeCompare(right))

    return {
      directory: normalized,
      exists: true,
      readable: true,
      skillCount: skills.length,
      skills,
    }
  } catch (error) {
    return {
      directory: normalized,
      exists: true,
      readable: false,
      skillCount: 0,
      skills: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function directoryFromActionInput(input: unknown): string | null | undefined {
  const record = asRecord(input)
  const value = record ? record.directory : input
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? normalizeDirectory(trimmed) : null
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
