import { computed, ref, watchEffect } from 'vue'

type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

// 只在用户明确选择时写入，默认值不落盘，以后改默认才对没选过的人生效
const CHOICE_KEY = 'nine1bot-theme-choice'
// 旧版本每次启动都会把「解析后的主题」写进这个键，所以它存在不代表用户选过
const LEGACY_KEY = 'nine1bot-theme'
// 默认白底；深色和跟随系统在设置里手动选
const DEFAULT_PREFERENCE: ThemePreference = 'light'

const media = window.matchMedia('(prefers-color-scheme: dark)')
const systemTheme = ref<Theme>(media.matches ? 'dark' : 'light')
media.addEventListener('change', (event) => {
  systemTheme.value = event.matches ? 'dark' : 'light'
})

function loadPreference(): ThemePreference {
  const stored = localStorage.getItem(CHOICE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  // 迁移：旧值和当前系统设置不一致，说明用户手动切换过，保留那次选择
  const legacy = localStorage.getItem(LEGACY_KEY)
  if ((legacy === 'light' || legacy === 'dark') && legacy !== systemTheme.value) return legacy
  return DEFAULT_PREFERENCE
}

const preference = ref<ThemePreference>(loadPreference())
const theme = computed<Theme>(() => (preference.value === 'system' ? systemTheme.value : preference.value))

// 模块级单例：模块加载（App 启动）即应用主题，
// 不依赖任何组件挂载，也不随组件卸载而停止
watchEffect(() => {
  document.documentElement.setAttribute('data-theme', theme.value)
  // 继续写旧键，回退到旧版本时主题不跳变
  localStorage.setItem(LEGACY_KEY, theme.value)
})

export function useTheme() {
  const setTheme = (next: ThemePreference) => {
    preference.value = next
    localStorage.setItem(CHOICE_KEY, next)
  }

  const toggleTheme = () => {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  return {
    theme,
    preference,
    toggleTheme,
    setTheme,
  }
}
