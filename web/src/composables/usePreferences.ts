import { ref, computed } from 'vue'
import { preferencesApi, getApiDirectory, type Preference, type PreferencesState } from '../api/client'

export function usePreferences() {
  // Each panel owns its project context; do not share an unkeyed cache across projects.
  const state = ref<PreferencesState | null>(null)
  const fetching = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const editingId = ref<string | null>(null)
  const editingContent = ref('')
  let generation = 0

  const preferences = computed(() => state.value?.preferences ?? [])
  const globalPreferences = computed(() => state.value?.global ?? [])
  const projectPreferences = computed(() => state.value?.project ?? [])
  const unresolvedPreferences = computed(() => state.value?.unresolved ?? [])
  const directory = computed(() => state.value?.directory ?? '')
  const loading = computed(() => fetching.value || saving.value)

  function cancelEdit() {
    editingId.value = null
    editingContent.value = ''
  }

  async function loadPreferences(projectDirectory = getApiDirectory()) {
    const request = ++generation
    state.value = null
    cancelEdit()
    fetching.value = true
    error.value = null
    try {
      const result = await preferencesApi.list(projectDirectory)
      if (request === generation) state.value = result
    } catch (cause) {
      if (request === generation) error.value = cause instanceof Error ? cause.message : '加载偏好失败'
    } finally {
      if (request === generation) fetching.value = false
    }
  }

  function replace(preference: Preference) {
    if (!state.value) return
    const current = state.value
    for (const key of ['global', 'project', 'unresolved'] as const) {
      current[key] = current[key].filter((item) => item.id !== preference.id)
    }
    const key = preference.scope === 'global' ? 'global' : preference.projectID ? 'project' : 'unresolved'
    current[key].push(preference)
    current.preferences = [...current.project, ...current.global]
  }

  async function mutate<T>(action: (directory: string) => Promise<T>, apply: (value: T) => void): Promise<T | null> {
    if (loading.value || !state.value) return null
    const request = generation
    const targetDirectory = state.value.directory
    saving.value = true
    error.value = null
    try {
      const result = await action(targetDirectory)
      if (request === generation) apply(result)
      return result
    } catch (cause) {
      if (request === generation) error.value = cause instanceof Error ? cause.message : '保存偏好失败'
      return null
    } finally {
      saving.value = false
    }
  }

  async function addPreference(content: string, scope: 'global' | 'project' = 'global') {
    if (!content.trim()) return null
    return mutate((dir) => preferencesApi.add(content.trim(), scope, 'user', dir), replace)
  }

  async function updatePreference(id: string, content: string) {
    if (!content.trim()) return false
    return !!await mutate((dir) => preferencesApi.update(id, content.trim(), dir), replace)
  }

  async function assignPreference(id: string) {
    return !!await mutate((dir) => preferencesApi.assign(id, dir), replace)
  }

  async function deletePreference(id: string) {
    return !!await mutate((dir) => preferencesApi.delete(id, dir), (deleted) => {
      if (!deleted || !state.value) return
      for (const key of ['preferences', 'global', 'project', 'unresolved'] as const) {
        state.value[key] = state.value[key].filter((item) => item.id !== id)
      }
    })
  }

  function startEdit(preference: Preference) {
    if (loading.value) return
    editingId.value = preference.id
    editingContent.value = preference.content
  }

  async function saveEdit() {
    if (!editingId.value) return false
    const id = editingId.value
    const content = editingContent.value
    const success = await updatePreference(id, content)
    if (success && editingId.value === id && editingContent.value === content) cancelEdit()
    return success
  }

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

  return {
    preferences, globalPreferences, projectPreferences, unresolvedPreferences, directory,
    loading, error, editingId, editingContent,
    hasPreferences: computed(() => preferences.value.length > 0),
    isEditing: computed(() => editingId.value !== null),
    loadPreferences, addPreference, updatePreference, assignPreference, deletePreference,
    startEdit, cancelEdit, saveEdit, formatTime,
  }
}
