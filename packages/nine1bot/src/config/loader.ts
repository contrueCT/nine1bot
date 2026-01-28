import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { dirname, resolve } from 'path'
import { Nine1BotConfigSchema, type Nine1BotConfig } from './schema'

const CONFIG_FILENAME = 'nine1bot.config.json'

/**
 * 查找配置文件路径
 * 从当前目录向上查找 nine1bot.config.json
 */
export async function findConfigPath(startDir: string = process.cwd()): Promise<string | null> {
  let dir = resolve(startDir)
  const root = dirname(dir)

  while (dir !== root) {
    const configPath = resolve(dir, CONFIG_FILENAME)
    try {
      await access(configPath)
      return configPath
    } catch {
      dir = dirname(dir)
    }
  }

  // 检查根目录
  const rootConfig = resolve(root, CONFIG_FILENAME)
  try {
    await access(rootConfig)
    return rootConfig
  } catch {
    return null
  }
}

/**
 * 检查配置文件是否存在
 */
export async function configExists(dir: string = process.cwd()): Promise<boolean> {
  const configPath = await findConfigPath(dir)
  return configPath !== null
}

/**
 * 获取默认配置文件路径（当前目录）
 */
export function getDefaultConfigPath(dir: string = process.cwd()): string {
  return resolve(dir, CONFIG_FILENAME)
}

/**
 * 加载配置文件
 */
export async function loadConfig(dir: string = process.cwd()): Promise<Nine1BotConfig> {
  const configPath = await findConfigPath(dir)

  if (!configPath) {
    // 返回默认配置
    return Nine1BotConfigSchema.parse({})
  }

  try {
    const content = await readFile(configPath, 'utf-8')
    const json = JSON.parse(content)

    // 处理环境变量替换 {env:VAR_NAME}
    const processed = processEnvVars(json)

    return Nine1BotConfigSchema.parse(processed)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`)
    }
    throw error
  }
}

/**
 * 保存配置文件
 */
export async function saveConfig(
  config: Partial<Nine1BotConfig>,
  configPath?: string
): Promise<void> {
  const targetPath = configPath || getDefaultConfigPath()

  // 确保目录存在
  await mkdir(dirname(targetPath), { recursive: true })

  // 读取现有配置（如果存在）
  let existing: Partial<Nine1BotConfig> = {}
  try {
    const content = await readFile(targetPath, 'utf-8')
    existing = JSON.parse(content)
  } catch {
    // 文件不存在，使用空对象
  }

  // 深度合并配置
  const merged = deepMerge(existing, config)

  // 添加 $schema（如果没有）
  if (!merged.$schema) {
    merged.$schema = 'https://nine1bot.com/config.schema.json'
  }

  // 写入文件
  const content = JSON.stringify(merged, null, 2)
  await writeFile(targetPath, content, 'utf-8')
}

/**
 * 处理环境变量替换
 * 支持格式: {env:VAR_NAME} 或 {env:VAR_NAME:default}
 */
function processEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\{env:([^}:]+)(?::([^}]*))?\}/g, (_, varName, defaultValue) => {
      return process.env[varName] || defaultValue || ''
    })
  }

  if (Array.isArray(obj)) {
    return obj.map(processEnvVars)
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = processEnvVars(value)
    }
    return result
  }

  return obj
}

/**
 * 深度合并对象
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target }

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key]
    const targetValue = result[key]

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue as any)
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T]
    }
  }

  return result
}

/**
 * 创建默认配置文件
 */
export async function createDefaultConfig(dir: string = process.cwd()): Promise<string> {
  const configPath = getDefaultConfigPath(dir)

  const defaultConfig: Partial<Nine1BotConfig> = {
    $schema: 'https://nine1bot.com/config.schema.json',
    server: {
      port: 4096,
      hostname: '127.0.0.1',
      openBrowser: true,
    },
    auth: {
      enabled: false,
    },
    tunnel: {
      enabled: false,
      provider: 'ngrok',
    },
  }

  await saveConfig(defaultConfig, configPath)
  return configPath
}

export { CONFIG_FILENAME }
