import { readFile, writeFile, mkdir, access, appendFile } from 'fs/promises'
import { dirname, resolve, join, basename } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { Nine1BotConfigSchema, type Nine1BotConfig } from './schema'
import { execSync } from 'child_process'

// 支持的配置文件名（按优先级排序）
const CONFIG_FILENAMES = ['nine1bot.config.jsonc', 'nine1bot.config.json']

// 全局配置文件名
const GLOBAL_CONFIG_FILENAME = 'config.jsonc'

/**
 * 获取程序安装目录
 * 这是 nine1bot 的根目录
 * - 开发模式：包含 packages/, opencode/, web/ 等
 * - 发行版模式：包含 nine1bot 二进制, skills/, web/ 等
 */
export function getInstallDir(): string {
  const execDir = dirname(process.execPath)

  // 判断是否是编译后的发行版
  // 编译后目录名格式：nine1bot-linux-x64, nine1bot-windows-x64 等
  const dirName = basename(execDir)
  if (dirName.startsWith('nine1bot-')) {
    return execDir
  }

  // 开发模式：从源码路径计算
  // 当前文件: packages/nine1bot/src/config/loader.ts
  // 安装根目录: 向上 4 级
  const currentFile = fileURLToPath(import.meta.url)
  return resolve(dirname(currentFile), '..', '..', '..', '..')
}

/**
 * 在指定目录中查找配置文件
 */
async function findConfigInDir(dir: string): Promise<string | null> {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(dir, filename)
    try {
      await access(configPath)
      return configPath
    } catch {
      // 继续尝试下一个文件名
    }
  }
  return null
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
  const installConfigPath = await findConfigInDir(installDir)
  if (installConfigPath) {
    return installConfigPath
  }

  // 如果指定了起始目录，从那里向上查找
  if (startDir) {
    let dir = resolve(startDir)
    const root = dirname(dir)

    while (dir !== root) {
      const configPath = await findConfigInDir(dir)
      if (configPath) {
        return configPath
      }
      dir = dirname(dir)
    }

    // 检查根目录
    const rootConfig = await findConfigInDir(root)
    if (rootConfig) {
      return rootConfig
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
  return resolve(getInstallDir(), CONFIG_FILENAMES[0])
}

/**
 * 获取全局配置目录
 * 统一使用 ~/.config/nine1bot 路径（跨平台一致性）
 * - Windows: C:\Users\<user>\.config\nine1bot
 * - Unix: ~/.config/nine1bot
 */
export function getGlobalConfigDir(): string {
  const home = homedir()
  return join(home, '.config', 'nine1bot')
}

/**
 * 获取全局配置文件路径
 */
export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), GLOBAL_CONFIG_FILENAME)
}

/**
 * 获取全局 skills 目录
 * - Windows: %APPDATA%\nine1bot\skills
 * - Unix: ~/.config/nine1bot/skills
 */
export function getGlobalSkillsDir(): string {
  return join(getGlobalConfigDir(), 'skills')
}

/**
 * 获取认证文件路径
 * - Windows: %APPDATA%\nine1bot\auth.json
 * - Unix: ~/.config/nine1bot/auth.json
 */
export function getAuthPath(): string {
  return join(getGlobalConfigDir(), 'auth.json')
}

/**
 * 检查文件是否存在
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 去除 JSONC 中的注释
 */
function stripJsonComments(jsonc: string): string {
  let result = ''
  let inString = false
  let inSingleLineComment = false
  let inMultiLineComment = false
  let i = 0

  while (i < jsonc.length) {
    const char = jsonc[i]
    const nextChar = jsonc[i + 1]

    // 处理字符串
    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === '"' && jsonc[i - 1] !== '\\') {
        inString = !inString
        result += char
        i++
        continue
      }
    }

    // 在字符串中，直接添加字符
    if (inString) {
      result += char
      i++
      continue
    }

    // 检测单行注释开始
    if (!inMultiLineComment && char === '/' && nextChar === '/') {
      inSingleLineComment = true
      i += 2
      continue
    }

    // 检测多行注释开始
    if (!inSingleLineComment && char === '/' && nextChar === '*') {
      inMultiLineComment = true
      i += 2
      continue
    }

    // 检测单行注释结束
    if (inSingleLineComment && char === '\n') {
      inSingleLineComment = false
      result += char
      i++
      continue
    }

    // 检测多行注释结束
    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false
      i += 2
      continue
    }

    // 不在注释中，添加字符
    if (!inSingleLineComment && !inMultiLineComment) {
      result += char
    }

    i++
  }

  return result
}

/**
 * 加载单个配置文件
 */
async function loadConfigFile(configPath: string): Promise<Partial<Nine1BotConfig>> {
  try {
    const content = await readFile(configPath, 'utf-8')
    const jsonContent = stripJsonComments(content)
    const json = JSON.parse(jsonContent)
    const processed = processEnvVars(json)
    return processed
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`)
    }
    throw error
  }
}

/**
 * 加载配置文件
 * 配置优先级（从低到高）：
 * 1. Nine1Bot 全局配置（~/.config/nine1bot/config.jsonc）
 * 2. Nine1Bot 项目配置（nine1bot.config.jsonc）
 *
 * @param customConfigPath 可选的自定义配置文件路径
 */
export async function loadConfig(customConfigPath?: string): Promise<Nine1BotConfig> {
  let result: Partial<Nine1BotConfig> = {}

  // 1. 加载全局配置
  const globalConfigPath = getGlobalConfigPath()
  if (await fileExists(globalConfigPath)) {
    try {
      const globalConfig = await loadConfigFile(globalConfigPath)
      result = deepMerge(result, globalConfig)
    } catch (error) {
      console.warn(`Warning: Failed to load global config from ${globalConfigPath}:`, error)
    }
  }

  // 2. 加载项目配置
  const projectConfigPath = customConfigPath || await findConfigPath()
  if (projectConfigPath && await fileExists(projectConfigPath)) {
    try {
      const projectConfig = await loadConfigFile(projectConfigPath)
      result = deepMerge(result, projectConfig)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file: ${projectConfigPath}`)
      }
      if (error && typeof error === 'object' && 'issues' in error) {
        const zodError = error as { issues: Array<{ path: (string | number)[]; message: string }> }
        const messages = zodError.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
        throw new Error(`Invalid config in ${projectConfigPath}:\n${messages}`)
      }
      throw error
    }
  }

  // 验证并返回最终配置
  try {
    return Nine1BotConfigSchema.parse(result)
  } catch (error) {
    if (error && typeof error === 'object' && 'issues' in error) {
      const zodError = error as { issues: Array<{ path: (string | number)[]; message: string }> }
      const messages = zodError.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`Invalid config:\n${messages}`)
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

export { CONFIG_FILENAMES }
