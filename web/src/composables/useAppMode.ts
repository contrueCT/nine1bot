import { ref, watch } from 'vue'

export type AppMode = 'chat' | 'agent'

const STORAGE_KEY = 'nine1bot-app-mode'

// Migrate old 'code' value to 'agent'
const stored = localStorage.getItem(STORAGE_KEY)
const initialMode: AppMode = stored === 'code' ? 'agent' : (stored as AppMode) || 'chat'

// Singleton mode state shared across all composable users
const mode = ref<AppMode>(initialMode)

// Persist to localStorage
watch(mode, (newMode) => {
  localStorage.setItem(STORAGE_KEY, newMode)
})

export function useAppMode() {
  function setMode(m: AppMode) {
    mode.value = m
  }

  function toggleMode() {
    mode.value = mode.value === 'chat' ? 'agent' : 'chat'
  }

  return {
    mode,
    setMode,
    toggleMode
  }
}
