/**
 * 用户偏好存储模块
 *
 * 存储位置：
 * - 全局偏好：~/.config/nine1bot/preferences.json (或 %APPDATA%\nine1bot\preferences.json)
 * - 项目偏好：{project}/.nine1bot/preferences.json 或 {project}/nine1bot.preferences.json
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { dirname, resolve, join } from 'path'
import { getGlobalConfigDir, getInstallDir } from '../config/loader'
import {
  type Preference,
  type PreferencesFile,
  type PreferencesState,
  type AddPreferenceInput,
  type UpdatePreferenceInput,
  generateId,
  createEmptyPreferencesFile
} from './types'

// 偏好文件名
const PREFERENCES_FILENAME = 'preferences.json'
const PROJECT_PREFERENCES_FILENAMES = ['.nine1bot/preferences.json', 'nine1bot.preferences.json']

// 内存缓存
let cachedState: PreferencesState | null = null
let lastLoadTime = 0
const CACHE_TTL = 5000 // 5秒缓存

/**
 * 获取全局偏好文件路径
 */
export function getGlobalPreferencesPath(): string {
  return join(getGlobalConfigDir(), PREFERENCES_FILENAME)
}

/**
 * 获取项目偏好文件路径
 */
export function getProjectPreferencesPath(projectDir?: string): string {
  const dir = projectDir || getInstallDir()
  return join(dir, PROJECT_PREFERENCES_FILENAMES[0])
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
 * 查找项目偏好文件
 */
async function findProjectPreferencesPath(projectDir?: string): Promise<string | null> {
  const dir = projectDir || getInstallDir()

  for (const filename of PROJECT_PREFERENCES_FILENAMES) {
    const filePath = resolve(dir, filename)
    if (await fileExists(filePath)) {
      return filePath
    }
  }

  return null
}

/**
 * 加载偏好文件
 */
async function loadPreferencesFile(filePath: string): Promise<PreferencesFile> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const data = JSON.parse(content)

    // 验证版本
    if (data.version !== 1) {
      console.warn(`Unknown preferences file version: ${data.version}`)
    }

    return {
      version: 1,
      preferences: Array.isArray(data.preferences) ? data.preferences : []
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyPreferencesFile()
    }
    console.error(`Failed to load preferences from ${filePath}:`, error)
    return createEmptyPreferencesFile()
  }
}

/**
 * 保存偏好文件
 */
async function savePreferencesFile(filePath: string, data: PreferencesFile): Promise<void> {
  // 确保目录存在
  await mkdir(dirname(filePath), { recursive: true })

  // 写入文件
  const content = JSON.stringify(data, null, 2)
  await writeFile(filePath, content, 'utf-8')
}

/**
 * 加载所有偏好（全局 + 项目）
 */
export async function loadPreferences(projectDir?: string, forceReload = false): Promise<PreferencesState> {
  // 检查缓存
  if (!forceReload && cachedState && Date.now() - lastLoadTime < CACHE_TTL) {
    return cachedState
  }

  // 加载全局偏好
  const globalPath = getGlobalPreferencesPath()
  const globalFile = await loadPreferencesFile(globalPath)
  const globalPrefs = globalFile.preferences.map(p => ({ ...p, scope: 'global' as const }))

  // 加载项目偏好
  const projectPath = await findProjectPreferencesPath(projectDir)
  let projectPrefs: Preference[] = []

  if (projectPath) {
    const projectFile = await loadPreferencesFile(projectPath)
    projectPrefs = projectFile.preferences.map(p => ({ ...p, scope: 'project' as const }))
  }

  // 合并偏好（项目优先）
  // 项目偏好在前，全局偏好在后
  const merged = [...projectPrefs, ...globalPrefs]

  // 更新缓存
  cachedState = {
    global: globalPrefs,
    project: projectPrefs,
    merged
  }
  lastLoadTime = Date.now()

  return cachedState
}

/**
 * 获取所有偏好
 */
export async function getPreferences(projectDir?: string): Promise<Preference[]> {
  const state = await loadPreferences(projectDir)
  return state.merged
}

/**
 * 获取单个偏好
 */
export async function getPreference(id: string, projectDir?: string): Promise<Preference | null> {
  const state = await loadPreferences(projectDir)
  return state.merged.find(p => p.id === id) || null
}

/**
 * 添加偏好
 */
export async function addPreference(input: AddPreferenceInput, projectDir?: string): Promise<Preference> {
  const scope = input.scope || 'global'
  const filePath = scope === 'global'
    ? getGlobalPreferencesPath()
    : getProjectPreferencesPath(projectDir)

  // 加载现有偏好
  const file = await loadPreferencesFile(filePath)

  // 创建新偏好
  const preference: Preference = {
    id: generateId(),
    content: input.content,
    source: input.source || 'user',
    createdAt: Date.now(),
    scope
  }

  // 添加到列表
  file.preferences.push(preference)

  // 保存文件
  await savePreferencesFile(filePath, file)

  // 清除缓存
  cachedState = null

  return preference
}

/**
 * 更新偏好
 */
export async function updatePreference(
  id: string,
  input: UpdatePreferenceInput,
  projectDir?: string
): Promise<Preference | null> {
  // 先找到偏好
  const state = await loadPreferences(projectDir, true)
  const preference = state.merged.find(p => p.id === id)

  if (!preference) {
    return null
  }

  // 确定文件路径
  const filePath = preference.scope === 'global'
    ? getGlobalPreferencesPath()
    : getProjectPreferencesPath(projectDir)

  // 加载文件
  const file = await loadPreferencesFile(filePath)

  // 查找并更新
  const index = file.preferences.findIndex(p => p.id === id)
  if (index === -1) {
    return null
  }

  // 更新内容
  if (input.content !== undefined) {
    file.preferences[index].content = input.content
  }

  // 保存文件
  await savePreferencesFile(filePath, file)

  // 清除缓存
  cachedState = null

  return file.preferences[index]
}

/**
 * 删除偏好
 */
export async function deletePreference(id: string, projectDir?: string): Promise<boolean> {
  // 先找到偏好
  const state = await loadPreferences(projectDir, true)
  const preference = state.merged.find(p => p.id === id)

  if (!preference) {
    return false
  }

  // 确定文件路径
  const filePath = preference.scope === 'global'
    ? getGlobalPreferencesPath()
    : getProjectPreferencesPath(projectDir)

  // 加载文件
  const file = await loadPreferencesFile(filePath)

  // 查找并删除
  const index = file.preferences.findIndex(p => p.id === id)
  if (index === -1) {
    return false
  }

  file.preferences.splice(index, 1)

  // 保存文件
  await savePreferencesFile(filePath, file)

  // 清除缓存
  cachedState = null

  return true
}

/**
 * 清空缓存
 */
export function clearCache(): void {
  cachedState = null
  lastLoadTime = 0
}

/**
 * 格式化偏好为提示词
 */
export function formatPreferencesAsPrompt(preferences: Preference[]): string {
  if (preferences.length === 0) {
    return ''
  }

  const items = preferences.map((p, i) => `${i + 1}. ${p.content}`).join('\n')

  return `<user-preferences>
以下是用户设置的偏好，请在回复中遵循这些偏好：

${items}

这些偏好由用户明确设置，优先级高于默认行为。
</user-preferences>`
}
