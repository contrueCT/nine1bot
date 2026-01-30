/**
 * 用户偏好类型定义
 */

export interface Preference {
  /** 唯一标识 */
  id: string
  /** 偏好内容（自然语言描述） */
  content: string
  /** 来源：用户手动添加 或 AI对话添加 */
  source: 'user' | 'ai'
  /** 创建时间戳 */
  createdAt: number
  /** 作用域：全局 或 项目级 */
  scope: 'global' | 'project'
}

export interface PreferencesFile {
  /** 文件格式版本 */
  version: 1
  /** 偏好列表 */
  preferences: Preference[]
}

export interface PreferencesState {
  /** 全局偏好 */
  global: Preference[]
  /** 项目偏好 */
  project: Preference[]
  /** 合并后的偏好（项目优先） */
  merged: Preference[]
}

export interface AddPreferenceInput {
  /** 偏好内容 */
  content: string
  /** 来源 */
  source?: 'user' | 'ai'
  /** 作用域 */
  scope?: 'global' | 'project'
}

export interface UpdatePreferenceInput {
  /** 新的偏好内容 */
  content?: string
}

/** 生成唯一 ID */
export function generateId(): string {
  return `pref_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/** 创建空的偏好文件结构 */
export function createEmptyPreferencesFile(): PreferencesFile {
  return {
    version: 1,
    preferences: []
  }
}
