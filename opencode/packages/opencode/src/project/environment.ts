import fs from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "project.environment" })

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
let initialized: Promise<string> | undefined

function resolveEnvDir() {
  if (process.env.NINE1BOT_PROJECT_ENV_DIR) {
    return process.env.NINE1BOT_PROJECT_ENV_DIR
  }
  if (process.env.NINE1BOT_AUTH_PATH) {
    return path.join(path.dirname(process.env.NINE1BOT_AUTH_PATH), "project-env")
  }
  return path.join(Global.Path.data, "project-env")
}

function projectFilePath(envDir: string, projectID: string) {
  return path.join(envDir, `${projectID}.json`)
}

function validateKey(key: string) {
  if (!key || typeof key !== "string") throw new Error("Environment variable key is required")
  if (key.length > KEY_MAX_LENGTH) throw new Error(`Environment variable key too long: ${key}`)
  if (!KEY_REGEX.test(key)) throw new Error(`Invalid environment variable key: ${key}`)
}

function validateValue(key: string, value: string) {
  if (typeof value !== "string") throw new Error(`Environment variable value must be string: ${key}`)
  if (value.length > VALUE_MAX_LENGTH) throw new Error(`Environment variable value too long: ${key}`)
}

async function migrateLegacyIfNeeded(envDir: string) {
  const legacyDir = path.join(Global.Path.data, "storage", "project_env")
  const stat = await fs.stat(legacyDir).catch(() => undefined)
  if (!stat?.isDirectory()) return

  const entries = await fs.readdir(legacyDir, { withFileTypes: true }).catch(() => [])
  if (entries.length === 0) return

  await fs.mkdir(envDir, { recursive: true })

  let copied = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const src = path.join(legacyDir, entry.name)
    const dest = path.join(envDir, entry.name)
    if (existsSync(dest)) continue
    await fs.copyFile(src, dest).catch(() => undefined)
    copied++
  }

  if (copied > 0) {
    const backup = `${legacyDir}.backup-${Date.now()}`
    await fs.rename(legacyDir, backup).catch((error) => {
      log.warn("failed to backup legacy project env dir", { error })
    })
    log.info("migrated legacy project env files", { copied, backup })
  }
}

async function ensureEnvDir() {
  if (!initialized) {
    initialized = (async () => {
      const envDir = resolveEnvDir()
      await fs.mkdir(envDir, { recursive: true })
      await migrateLegacyIfNeeded(envDir).catch((error) => {
        log.warn("legacy project env migration skipped", { error })
      })
      return envDir
    })()
  }
  return initialized
}

async function read(projectID: string): Promise<ProjectEnvFile> {
  const envDir = await ensureEnvDir()
  const file = projectFilePath(envDir, projectID)
  const text = await fs.readFile(file, "utf8").catch(() => "")
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
  } catch (error) {
    log.warn("project env file is invalid JSON", { projectID, error })
    return {
      version: DEFAULT_FILE_VERSION,
      projectID,
      variables: {},
      updatedAt: Date.now(),
    }
  }
}

async function write(projectID: string, variables: Record<string, string>) {
  const envDir = await ensureEnvDir()
  const file = projectFilePath(envDir, projectID)
  const payload: ProjectEnvFile = {
    version: DEFAULT_FILE_VERSION,
    projectID,
    variables,
    updatedAt: Date.now(),
  }
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8")
}

export namespace ProjectEnvironment {
  export async function getPath() {
    return ensureEnvDir()
  }

  export async function getAll(projectID: string) {
    const data = await read(projectID)
    return data.variables
  }

  export async function listKeys(projectID: string) {
    const vars = await getAll(projectID)
    return Object.keys(vars).sort()
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

