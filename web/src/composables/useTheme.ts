import { ref, watchEffect } from 'vue'

type Theme = 'light' | 'dark'

const storedTheme = localStorage.getItem('nine1bot-theme') as Theme | null
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches

const theme = ref<Theme>(storedTheme || (systemPrefersDark ? 'dark' : 'light'))

export function useTheme() {
  const toggleTheme = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  const setTheme = (newTheme: Theme) => {
    theme.value = newTheme
  }

  watchEffect(() => {
    document.documentElement.setAttribute('data-theme', theme.value)
    localStorage.setItem('nine1bot-theme', theme.value)
  })

  return {
    theme,
    toggleTheme,
    setTheme
  }
}
