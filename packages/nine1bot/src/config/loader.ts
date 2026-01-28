import { readFile, writeFile, mkdir, access, appendFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Nine1BotConfigSchema, type Nine1BotConfig } from './schema'
import { execSync } from 'child_process'

const CONFIG_FILENAME = 'nine1bot.config.json'

/**
 * 获取程序安装目录
 * 这是 nine1bot 的根目录（包含 packages/, opencode/, web/ 等）
 */
export function getInstallDir(): string {
  // 从当前文件路径向上查找到安装根目录
  // 当前文件: packages/nine1bot/src/config/loader.ts
  // 安装根目录: 向上 4 级
  const currentFile = fileURLToPath(import.meta.url)
  return resolve(dirname(currentFile), '..', '..', '..', '..')
}

/**
 * 查找配置文件路径
 * 优先级：
 * 1. 程序安装目录
 * 2. 从当前目录向上查找
 */
export async function findConfigPath(startDir?: string): Promise<string | null> {
  // 首先检查安装目录
  const installDir = getInstallDir()
  const installConfigPath = resolve(installDir, CONFIG_FILENAME)
  try {
    await access(installConfigPath)
    return installConfigPath
  } catch {
    // 继续查找
  }

  // 如果指定了起始目录，从那里向上查找
  if (startDir) {
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
      // 未找到
    }
  }

  return null
}

/**
 * 检查配置文件是否存在
 */
export async function configExists(): Promise<boolean> {
  const configPath = await findConfigPath()
  return configPath !== null
}

/**
 * 获取默认配置文件路径（安装目录）
 */
export function getDefaultConfigPath(): string {
  return resolve(getInstallDir(), CONFIG_FILENAME)
}

/**
 * 加载配置文件
 */
export async function loadConfig(): Promise<Nine1BotConfig> {
  const configPath = await findConfigPath()

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
export async function createDefaultConfig(): Promise<string> {
  const configPath = getDefaultConfigPath()

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

/**
 * 获取 shell 配置文件路径
 */
export function getShellRcPath(): string {
  const shell = process.env.SHELL || ''
  const home = process.env.HOME || process.env.USERPROFILE || ''

  if (shell.includes('zsh')) {
    return resolve(home, '.zshrc')
  } else if (shell.includes('bash')) {
    return resolve(home, '.bashrc')
  } else if (process.platform === 'win32') {
    // Windows 不使用 shell rc 文件
    return ''
  }
  return resolve(home, '.profile')
}

/**
 * 检查 PATH 中是否已包含安装目录
 */
export function isInPath(): boolean {
  const installDir = getInstallDir()
  const pathEnv = process.env.PATH || ''
  const separator = process.platform === 'win32' ? ';' : ':'
  return pathEnv.split(separator).some(p => resolve(p) === installDir)
}

/**
 * 将安装目录添加到 PATH (Linux/macOS)
 */
export async function addToPathUnix(): Promise<{ success: boolean; shellRc: string; message: string }> {
  const installDir = getInstallDir()
  const shellRc = getShellRcPath()

  if (!shellRc) {
    return { success: false, shellRc: '', message: 'Could not determine shell configuration file' }
  }

  const exportLine = `\n# Nine1Bot\nexport PATH="$PATH:${installDir}"\n`

  try {
    // 检查是否已添加
    try {
      const content = await readFile(shellRc, 'utf-8')
      if (content.includes(installDir)) {
        return { success: true, shellRc, message: 'Already in PATH' }
      }
    } catch {
      // 文件不存在，继续创建
    }

    await appendFile(shellRc, exportLine)
    return { success: true, shellRc, message: `Added to ${shellRc}` }
  } catch (error: any) {
    return { success: false, shellRc, message: error.message }
  }
}

/**
 * 将安装目录添加到 PATH (Windows)
 */
export async function addToPathWindows(): Promise<{ success: boolean; message: string }> {
  const installDir = getInstallDir()

  try {
    // 获取当前用户 PATH
    const currentPath = execSync('echo %PATH%', { encoding: 'utf-8' }).trim()

    if (currentPath.includes(installDir)) {
      return { success: true, message: 'Already in PATH' }
    }

    // 使用 setx 设置用户环境变量
    // 注意: setx 有 1024 字符限制，这里只添加我们的路径
    execSync(`setx PATH "%PATH%;${installDir}"`, { encoding: 'utf-8' })

    return { success: true, message: 'Added to user PATH. Please restart your terminal.' }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

/**
 * 添加到 PATH（跨平台）
 */
export async function addToPath(): Promise<{ success: boolean; message: string; shellRc?: string }> {
  if (process.platform === 'win32') {
    return addToPathWindows()
  } else {
    return addToPathUnix()
  }
}

export { CONFIG_FILENAME }
