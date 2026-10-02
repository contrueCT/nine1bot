import { ref } from 'vue'
import { api, type SessionFileChange } from '../api/client'

export function useSessionChanges(fetchChanges = api.getSessionChanges) {
  const files = ref<SessionFileChange[]>([])
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref<number | null>(null)
  let generation = 0
  let owner = ''

  async function load(sessionId: string, directory: string) {
    const key = `${sessionId}\0${directory}`
    const request = ++generation
    if (key !== owner) {
      files.value = []
      loadedAt.value = null
    }
    owner = key
    error.value = ''
    loading.value = true
    try {
      const changes = await fetchChanges(sessionId, directory)
      if (request !== generation) return
      files.value = changes
      loadedAt.value = Date.now()
    } catch (cause) {
      if (request !== generation) return
      error.value = cause instanceof Error ? cause.message : '文件变更加载失败，请重试'
    } finally {
      if (request === generation) loading.value = false
    }
  }

  function reset() {
    generation += 1
    owner = ''
    files.value = []
    error.value = ''
    loadedAt.value = null
    loading.value = false
  }

  return { files, loading, error, loadedAt, load, reset }
}
