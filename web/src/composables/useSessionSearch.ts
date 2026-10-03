import { ref, watch, onScopeDispose, type Ref } from 'vue'
import { api, type SessionSearchResult } from '../api/client'

/** Latest query owns the result; stale requests can never overwrite new input. */
export function useSessionSearch(query: Ref<string>, directory: Ref<string>) {
  const results = ref<SessionSearchResult[]>([])
  const loading = ref(false)
  const error = ref('')
  const hasMore = ref(false)
  let version = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  function search() {
    const request = ++version
    clearTimeout(timer)
    results.value = []
    error.value = ''
    hasMore.value = false
    const term = query.value.trim()
    loading.value = Boolean(term)
    if (!term) return
    const owner = directory.value
    timer = setTimeout(async () => {
      try {
        const response = await api.searchSessions(term, owner)
        if (request !== version) return
        results.value = response.results
        hasMore.value = response.hasMore
      } catch (reason) {
        if (request !== version) return
        error.value = reason instanceof Error ? reason.message : '搜索失败，请重试'
      } finally {
        if (request === version) loading.value = false
      }
    }, 200)
  }
  watch([query, directory], search, { immediate: true, flush: 'sync' })
  onScopeDispose(() => { version++; clearTimeout(timer) })
  return { results, loading, error, hasMore, retry: search }
}
