import fs from 'fs/promises'
import path from 'path'
import { getProjectEnvDir } from '../config/loader'

const KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/
const KEY_MAX_LENGTH = 128
const VALUE_MAX_LENGTH = 8192

interface ProjectEnvFile {
  version: number
  projectID: string
  variables: Record<string, string>
  updatedAt: number
}

const DEFAULT_FILE_VERSION = 1

function projectFilePath(projectID: string) {
  return path.join(getProjectEnvDir(), `${projectID}.json`)
}

async function ensureEnvDir() {
  const envDir = getProjectEnvDir()
  await fs.mkdir(envDir, { recursive: true })
  return envDir
}

function validateKey(key: string) {
  if (!key || typeof key !== 'string') throw new Error('Environment variable key is required')
  if (key.length > KEY_MAX_LENGTH) throw new Error(`Environment variable key too long: ${key}`)
  if (!KEY_REGEX.test(key)) throw new Error(`Invalid environment variable key: ${key}`)
}

function validateValue(key: string, value: string) {
  if (typeof value !== 'string') throw new Error(`Environment variable value must be string: ${key}`)
  if (value.length > VALUE_MAX_LENGTH) throw new Error(`Environment variable value too long: ${key}`)
}

async function read(projectID: string): Promise<ProjectEnvFile> {
  await ensureEnvDir()
  const file = projectFilePath(projectID)
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  if (!text) {
    return {
      version: DEFAULT_FILE_VERSION,
      projectID,
      variables: {},
      updatedAt: Date.now(),
    }
  }

  try {
    const parsed = JSON.parse(text) as ProjectEnvFile
    return {
      version: DEFAULT_FILE_VERSION,
      projectID,
      variables: parsed.variables ?? {},
      updatedAt: parsed.updatedAt ?? Date.now(),
    }
  } catch {
    return {
      version: DEFAULT_FILE_VERSION,
      projectID,
      variables: {},
      updatedAt: Date.now(),
    }
  }
}

async function write(projectID: string, variables: Record<string, string>) {
  await ensureEnvDir()
  const file = projectFilePath(projectID)
  const payload: ProjectEnvFile = {
    version: DEFAULT_FILE_VERSION,
    projectID,
    variables,
    updatedAt: Date.now(),
  }
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
}

export namespace ProjectEnvironment {
  export async function getAll(projectID: string) {
    const data = await read(projectID)
    return data.variables
  }

  export async function setAll(projectID: string, variables: Record<string, string>) {
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(variables)) {
      validateKey(key)
      validateValue(key, value)
      normalized[key] = value
    }
    await write(projectID, normalized)
    return normalized
  }

  export async function set(projectID: string, key: string, value: string) {
    validateKey(key)
    validateValue(key, value)
    const vars = await getAll(projectID)
    vars[key] = value
    await write(projectID, vars)
    return vars
  }

  export async function remove(projectID: string, key: string) {
    validateKey(key)
    const vars = await getAll(projectID)
    delete vars[key]
    await write(projectID, vars)
    return vars
  }
}
