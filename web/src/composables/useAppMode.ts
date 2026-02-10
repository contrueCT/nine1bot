import { ref, watch } from 'vue'

export type AppMode = 'chat' | 'code'

const STORAGE_KEY = 'nine1bot-app-mode'

// Singleton mode state shared across all composable users
const mode = ref<AppMode>((localStorage.getItem(STORAGE_KEY) as AppMode) || 'chat')

// Persist to localStorage
watch(mode, (newMode) => {
  localStorage.setItem(STORAGE_KEY, newMode)
})

export function useAppMode() {
  function setMode(m: AppMode) {
    mode.value = m
  }

  function toggleMode() {
    mode.value = mode.value === 'chat' ? 'code' : 'chat'
  }

  return {
    mode,
    setMode,
    toggleMode
  }
}
