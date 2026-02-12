import { ref, watch } from 'vue'
import type { AppMode } from './useAppMode'

const STORAGE_KEY = 'nine1bot-session-modes'

// sessionId → mode mapping
const sessionModes = ref<Record<string, AppMode>>(
  JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
)

// Persist on change
watch(sessionModes, (val) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
}, { deep: true })

export function useSessionMode() {
  function getMode(sessionId: string): AppMode | undefined {
    return sessionModes.value[sessionId]
  }

  function setMode(sessionId: string, mode: AppMode) {
    sessionModes.value = { ...sessionModes.value, [sessionId]: mode }
  }

  function removeMode(sessionId: string) {
    const { [sessionId]: _, ...rest } = sessionModes.value
    sessionModes.value = rest
  }

  // Filter sessions by mode
  function filterByMode(sessionIds: string[], mode: AppMode): string[] {
    return sessionIds.filter(id => {
      const m = sessionModes.value[id]
      // Sessions without a mode tag show in both modes
      return !m || m === mode
    })
  }

  return {
    sessionModes,
    getMode,
    setMode,
    removeMode,
    filterByMode,
  }
}
