<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Sun, Moon, Settings, Square, Cpu, ChevronDown, PanelLeftOpen, Check, Minimize2, ListTodo } from 'lucide-vue-next'
import type { Session } from '../api/client'
import { useSettings } from '../composables/useSettings'
import { useTheme } from '../composables/useTheme'

defineProps<{
  session: Session | null
  directory: string
  isStreaming: boolean
  sidebarCollapsed: boolean
  isSummarizing?: boolean
}>()

const emit = defineEmits<{
  'toggle-sidebar': []
  'abort': []
  'open-settings': []
  'summarize': []
  'toggle-todo': []
}>()

const {
  providers,
  currentProvider,
  currentModel,
  loadProviders,
  loadConfig,
  selectModel: settingsSelectModel
} = useSettings()

const { theme, toggleTheme } = useTheme()

const showModelDropdown = ref(false)
const dropdownRef = ref<HTMLElement>()

onMounted(async () => {
  // 先加载 providers（包含 connected 和 defaults），再加载配置
  await loadProviders()
  await loadConfig()
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

function handleClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    showModelDropdown.value = false
  }
}

async function selectModel(providerId: string, modelId: string) {
  await settingsSelectModel(providerId, modelId)
  showModelDropdown.value = false
}

function getCurrentModelName(): string {
  // 先根据 currentProvider 找到对应的 provider
  if (currentProvider.value) {
    const provider = providers.value.find(p => p.id === currentProvider.value)
    if (provider) {
      const model = provider.models.find(m => m.id === currentModel.value)
      if (model) return model.name || model.id
    }
  }
  // 如果没有匹配的，尝试在所有 provider 中查找
  for (const provider of providers.value) {
    const model = provider.models.find(m => m.id === currentModel.value)
    if (model) return model.name || model.id
  }
  return currentModel.value || '选择模型'
}
</script>

<template>
  <header class="header glass-header">
    <div class="header-left">
      <button
        v-if="sidebarCollapsed"
        class="btn btn-ghost btn-icon"
        @click="emit('toggle-sidebar')"
        title="展开侧边栏"
      >
        <PanelLeftOpen :size="20" />
      </button>

      <div class="session-info" v-if="session">
        <span class="session-title">{{ session.title || '新会话' }}</span>
        <span class="session-dir text-muted text-xs">{{ directory }}</span>
      </div>
    </div>

    <div class="header-center">
      <!-- Model Selector -->
      <div class="dropdown" ref="dropdownRef">
        <button class="dropdown-trigger model-trigger" @click="showModelDropdown = !showModelDropdown">
          <Cpu :size="16" class="model-icon" />
          <span class="model-name">{{ getCurrentModelName() }}</span>
          <ChevronDown :size="14" class="chevron" :class="{ open: showModelDropdown }" />
        </button>
        <div class="dropdown-menu dropdown-menu-scrollable glass-dropdown" v-if="showModelDropdown">
          <template v-for="provider in providers.filter(p => p.authenticated)" :key="provider.id">
            <div class="dropdown-label">{{ provider.name }}</div>
            <div
              v-for="model in provider.models"
              :key="model.id"
              class="dropdown-item"
              :class="{ active: currentProvider === provider.id && currentModel === model.id }"
              @click="selectModel(provider.id, model.id)"
            >
              <div class="dropdown-item-text">
                <span class="model-id">{{ model.name || model.id }}</span>
              </div>
              <Check v-if="currentProvider === provider.id && currentModel === model.id" :size="14" class="check-icon" />
            </div>
          </template>
          <div v-if="providers.filter(p => p.authenticated).length === 0" class="dropdown-item text-muted">
            暂无已认证的模型
          </div>
        </div>
      </div>
    </div>

    <div class="header-right">
      <!-- Streaming Indicator -->
      <div v-if="isStreaming" class="streaming-badge">
        <span class="streaming-dot"></span>
        <span class="streaming-text">生成中</span>
      </div>

      <!-- Abort Button -->
      <button
        v-if="isStreaming"
        class="btn btn-ghost abort-btn"
        @click="emit('abort')"
      >
        <Square :size="14" fill="currentColor" />
        <span>停止</span>
      </button>

      <!-- Summarize Button -->
      <button
        v-if="session && !isStreaming"
        class="btn btn-ghost btn-icon"
        @click="emit('summarize')"
        :disabled="isSummarizing"
        title="压缩会话"
      >
        <Minimize2 :size="20" :class="{ 'animate-pulse': isSummarizing }" />
      </button>

      <!-- Todo List Button -->
      <button
        v-if="session"
        class="btn btn-ghost btn-icon"
        @click="emit('toggle-todo')"
        title="待办事项"
      >
        <ListTodo :size="20" />
      </button>

       <!-- Theme Toggle -->
       <button class="btn btn-ghost btn-icon" @click="toggleTheme" :title="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'">
        <Sun v-if="theme === 'dark'" :size="20" />
        <Moon v-else :size="20" />
      </button>

      <!-- Settings Button -->
      <button class="btn btn-ghost btn-icon" @click="emit('open-settings')" title="设置">
        <Settings :size="20" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.glass-header {
  background: var(--bg-glass);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-glass);
  z-index: 10;
}

.model-trigger {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-default);
  padding: 6px 16px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all var(--transition-fast);
}

.model-trigger:hover {
  background: var(--bg-elevated);
  border-color: var(--border-hover);
  box-shadow: var(--shadow-sm);
}

.model-name {
  font-weight: 500;
  font-size: 13px;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chevron {
  opacity: 0.5;
  transition: transform var(--transition-fast);
}

.chevron.open {
  transform: rotate(180deg);
}

.glass-dropdown {
  background: var(--bg-elevated); /* Solid fallback for complex dropdowns or high opacity */
  background: var(--bg-glass-strong);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  border-radius: var(--radius-lg);
  padding: 6px;
  margin-top: 8px;
  min-width: 240px;
}

.dropdown-item {
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  margin-bottom: 2px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dropdown-item:hover {
  background: var(--bg-tertiary);
}

.dropdown-item.active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.session-info {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.session-title {
  font-weight: 600;
  font-size: 14px;
}

.session-dir {
  font-family: var(--font-mono);
  opacity: 0.7;
}

.dropdown-label {
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
}

.dropdown-label:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
}

.streaming-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--accent-subtle);
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  box-shadow: 0 0 10px var(--accent-subtle);
}

.streaming-dot {
  width: 8px;
  height: 8px;
  background: var(--accent);
  border-radius: 50%;
  animation: pulse 1.5s infinite;
  box-shadow: 0 0 8px var(--accent);
}

@keyframes pulse {
  0% { transform: scale(0.95); opacity: 0.8; }
  50% { transform: scale(1.1); opacity: 1; }
  100% { transform: scale(0.95); opacity: 0.8; }
}

.abort-btn {
  color: var(--error);
  font-size: 13px;
  gap: 6px;
}

.abort-btn:hover {
  background: var(--error-subtle);
}

.dropdown-menu-scrollable {
  max-height: 400px;
  overflow-y: auto;
}

.animate-pulse {
  animation: pulse-opacity 1.5s infinite;
}

@keyframes pulse-opacity {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
</style>

