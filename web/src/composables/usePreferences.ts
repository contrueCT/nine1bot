import { ref, computed } from 'vue'
import { preferencesApi, type Preference } from '../api/client'

// 全局状态
const preferences = ref<Preference[]>([])
const globalPreferences = ref<Preference[]>([])
const projectPreferences = ref<Preference[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

// 编辑状态
const editingId = ref<string | null>(null)
const editingContent = ref('')

export function usePreferences() {
  // 加载偏好
  async function loadPreferences() {
    loading.value = true
    error.value = null
    try {
      const state = await preferencesApi.list()
      preferences.value = state.preferences
      globalPreferences.value = state.global
      projectPreferences.value = state.project
    } catch (e: any) {
      error.value = e.message || '加载偏好失败'
      console.error('Failed to load preferences:', e)
    } finally {
      loading.value = false
    }
  }

  // 添加偏好
  async function addPreference(content: string, scope: 'global' | 'project' = 'global') {
    if (!content.trim()) return null

    loading.value = true
    error.value = null
    try {
      const pref = await preferencesApi.add(content.trim(), scope, 'user')
      await loadPreferences() // 重新加载以确保同步
      return pref
    } catch (e: any) {
      error.value = e.message || '添加偏好失败'
      console.error('Failed to add preference:', e)
      return null
    } finally {
      loading.value = false
    }
  }

  // 更新偏好
  async function updatePreference(id: string, content: string) {
    if (!content.trim()) return false

    loading.value = true
    error.value = null
    try {
      await preferencesApi.update(id, content.trim())
      await loadPreferences()
      return true
    } catch (e: any) {
      error.value = e.message || '更新偏好失败'
      console.error('Failed to update preference:', e)
      return false
    } finally {
      loading.value = false
    }
  }

  // 删除偏好
  async function deletePreference(id: string) {
    loading.value = true
    error.value = null
    try {
      await preferencesApi.delete(id)
      await loadPreferences()
      return true
    } catch (e: any) {
      error.value = e.message || '删除偏好失败'
      console.error('Failed to delete preference:', e)
      return false
    } finally {
      loading.value = false
    }
  }

  // 开始编辑
  function startEdit(pref: Preference) {
    editingId.value = pref.id
    editingContent.value = pref.content
  }

  // 取消编辑
  function cancelEdit() {
    editingId.value = null
    editingContent.value = ''
  }

  // 保存编辑
  async function saveEdit() {
    if (!editingId.value) return false
    const success = await updatePreference(editingId.value, editingContent.value)
    if (success) {
      cancelEdit()
    }
    return success
  }

  // 格式化时间
  function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`

    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  // 计算属性
  const hasPreferences = computed(() => preferences.value.length > 0)
  const isEditing = computed(() => editingId.value !== null)

  return {
    // 状态
    preferences,
    globalPreferences,
    projectPreferences,
    loading,
    error,
    editingId,
    editingContent,

    // 计算属性
    hasPreferences,
    isEditing,

    // 方法
    loadPreferences,
    addPreference,
    updatePreference,
    deletePreference,
    startEdit,
    cancelEdit,
    saveEdit,
    formatTime
  }
}
