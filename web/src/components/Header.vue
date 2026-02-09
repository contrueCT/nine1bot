<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Sun, Moon, Settings, Square, Cpu, ChevronDown, PanelLeftOpen, Check, Minimize2, ListTodo, Server, RefreshCcw, Activity } from 'lucide-vue-next'
import type { Session } from '../api/client'
import { useSettings } from '../composables/useSettings'
import { useTheme } from '../composables/useTheme'

defineProps<{
  session: Session | null
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
  selectModel: settingsSelectModel,
  mcpServers,
  loadingMcp,
  loadMcpServers,
  connectMcp,
  disconnectMcp,
  healthMcp
} = useSettings()

const { theme, toggleTheme } = useTheme()

const showModelDropdown = ref(false)
const dropdownRef = ref<HTMLElement>()
const showMcpDropdown = ref(false)
const mcpDropdownRef = ref<HTMLElement>()
const mcpActionLoading = ref<string | null>(null)
const mcpHealthLoading = ref<string | null>(null)

const mcpSummary = computed(() => {
  const total = mcpServers.value.length
  const connected = mcpServers.value.filter(s => s.status === 'connected').length
  const failed = mcpServers.value.filter(s => s.status === 'failed').length
  const needsAuth = mcpServers.value.filter(s => s.status === 'needs_auth' || s.status === 'needs_client_registration').length
  const level = total === 0
    ? 'empty'
    : failed > 0
      ? 'error'
      : needsAuth > 0
        ? 'warn'
        : connected === total
          ? 'ok'
          : 'warn'
  return { total, connected, failed, needsAuth, level }
})

onMounted(async () => {
  // 并行加载基础配置，MCP 在展开下拉时再加载
  await Promise.all([loadProviders(), loadConfig()])
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

function handleClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    showModelDropdown.value = false
  }
  if (mcpDropdownRef.value && !mcpDropdownRef.value.contains(e.target as Node)) {
    showMcpDropdown.value = false
  }
}

async function selectModel(providerId: string, modelId: string) {
  await settingsSelectModel(providerId, modelId)
  showModelDropdown.value = false
}

async function toggleMcpDropdown() {
  showMcpDropdown.value = !showMcpDropdown.value
  if (showMcpDropdown.value) {
    await loadMcpServers()
  }
}

function statusBadge(status: string) {
  switch (status) {
    case 'connected': return 'badge-success'
    case 'failed': return 'badge-error'
    case 'needs_auth': return 'badge-warning'
    case 'needs_client_registration': return 'badge-warning'
    case 'disabled': return 'badge-default'
    default: return 'badge-default'
  }
}

function statusText(status: string) {
  switch (status) {
    case 'connected': return '已连接'
    case 'failed': return '连接失败'
    case 'needs_auth': return '需要认证'
    case 'needs_client_registration': return '需要注册'
    case 'disabled': return '已禁用'
    default: return status
  }
}

function healthText(server: any) {
  if (!server.health) return '未检测'
  if (server.health.ok) {
    const latency = server.health.latencyMs !== undefined ? `${server.health.latencyMs}ms` : 'ok'
    return `健康 ${latency}`
  }
  return '异常'
}

async function refreshMcp() {
  await loadMcpServers()
}

async function connectServer(name: string) {
  if (mcpActionLoading.value) return
  mcpActionLoading.value = name
  try {
    await connectMcp(name)
  } finally {
    mcpActionLoading.value = null
  }
}

async function disconnectServer(name: string) {
  if (mcpActionLoading.value) return
  mcpActionLoading.value = name
  try {
    await disconnectMcp(name)
  } finally {
    mcpActionLoading.value = null
  }
}

async function checkHealth(name: string) {
  if (mcpHealthLoading.value) return
  mcpHealthLoading.value = name
  try {
    await healthMcp(name)
  } finally {
    mcpHealthLoading.value = null
  }
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

      <!-- MCP Status -->
      <div class="dropdown" ref="mcpDropdownRef">
        <button
          class="dropdown-trigger mcp-trigger"
          @click="toggleMcpDropdown"
          :title="`MCP ${mcpSummary.connected}/${mcpSummary.total}`"
        >
          <Server :size="16" class="mcp-icon" />
          <span class="mcp-text">MCP {{ mcpSummary.connected }}/{{ mcpSummary.total }}</span>
          <span class="mcp-dot" :class="`mcp-dot-${mcpSummary.level}`"></span>
        </button>
        <div class="dropdown-menu mcp-menu glass-dropdown" v-if="showMcpDropdown">
          <div class="mcp-menu-header">
            <div class="mcp-menu-title">MCP 状态</div>
            <button class="btn btn-ghost btn-icon sm" @click="refreshMcp" title="刷新">
              <RefreshCcw :size="14" />
            </button>
          </div>
          <div v-if="loadingMcp" class="mcp-empty text-muted">加载中...</div>
          <div v-else-if="mcpServers.length === 0" class="mcp-empty text-muted">暂无 MCP 服务器</div>
          <div v-else class="mcp-list">
            <div v-for="server in mcpServers" :key="server.name" class="mcp-item">
              <div class="mcp-item-main">
                <div class="mcp-name">{{ server.name }}</div>
                <div class="mcp-meta">
                  <span class="badge" :class="statusBadge(server.status)">
                    {{ statusText(server.status) }}
                  </span>
                  <span class="mcp-health text-xs text-muted">
                    {{ healthText(server) }}
                  </span>
                </div>
                <div v-if="server.error" class="text-xs error-text">{{ server.error }}</div>
                <div v-else-if="server.health?.error" class="text-xs error-text">{{ server.health.error }}</div>
              </div>
              <div class="mcp-actions">
                <button
                  v-if="server.status === 'connected'"
                  class="btn btn-ghost btn-sm"
                  :disabled="mcpActionLoading === server.name"
                  @click="disconnectServer(server.name)"
                >
                  断开
                </button>
                <button
                  v-else-if="server.status === 'needs_auth'"
                  class="btn btn-secondary btn-sm"
                  :disabled="mcpActionLoading === server.name"
                  @click="connectServer(server.name)"
                >
                  认证
                </button>
                <button
                  v-else
                  class="btn btn-secondary btn-sm"
                  :disabled="mcpActionLoading === server.name"
                  @click="connectServer(server.name)"
                >
                  连接
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="mcpHealthLoading === server.name"
                  @click="checkHealth(server.name)"
                  title="健康检查"
                >
                  <Activity :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

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
  background: var(--bg-secondary);
  border-bottom: 0.5px solid var(--border-subtle);
  z-index: 10;
}

.model-trigger {
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border-default);
  padding: 6px 16px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  gap: 8px;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.model-trigger:hover {
  background: var(--bg-elevated);
  border-color: var(--border-hover);
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

.mcp-trigger {
  padding: 6px 12px;
  border-radius: var(--radius-md);
  gap: 8px;
}

.mcp-text {
  font-size: 12px;
  font-weight: 500;
}

.mcp-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  display: inline-block;
}

.mcp-dot-ok {
  background: var(--success);
}

.mcp-dot-warn {
  background: var(--warning);
}

.mcp-dot-error {
  background: var(--error);
}

.mcp-dot-empty {
  background: var(--text-muted);
}

.mcp-menu {
  min-width: 320px;
  padding: var(--space-sm);
}

.mcp-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: var(--space-sm);
  border-bottom: 0.5px solid var(--border-subtle);
  margin-bottom: var(--space-sm);
}

.mcp-menu-title {
  font-weight: 600;
  font-size: 13px;
}

.mcp-empty {
  padding: var(--space-sm);
}

.mcp-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  max-height: 360px;
  overflow: auto;
}

.mcp-item {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-subtle);
}

.mcp-item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mcp-name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-meta {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
}

.mcp-actions {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.glass-dropdown {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  border-radius: var(--radius-md);
  padding: 6px;
  margin-top: 8px;
  min-width: 240px;
}

.dropdown-item {
  border-radius: var(--radius-sm);
  padding: 6px 12px;
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
  align-items: center;
}

.session-title {
  font-weight: 600;
  font-size: 14px;
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
  border-top: 0.5px solid var(--border-subtle);
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
  font-weight: 500;
  color: var(--accent);
}

.streaming-dot {
  width: 8px;
  height: 8px;
  background: var(--accent);
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { transform: scale(0.95); opacity: 0.8; }
  50% { transform: scale(1.05); opacity: 1; }
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
