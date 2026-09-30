<script setup lang="ts">
import { computed } from 'vue'
import { Square, PanelLeftOpen, Folder, BarChart3, MessageSquare, Menu } from 'lucide-vue-next'
import type { Session } from '../api/client'
import { tildify, useHomeDirectory } from '../composables/useWorkspacePath'

const props = defineProps<{
  session: Session | null
  directory?: string
  projectName?: string
  pendingCount?: number
  connectionState?: 'connecting' | 'connected' | 'reconnecting' | 'offline'
  isStreaming: boolean
  sidebarCollapsed: boolean
  isSummarizing?: boolean
  retryInfo?: { attempt: number; message: string; next: number } | null
  showMetrics?: boolean
}>()

const emit = defineEmits<{
  'toggle-sidebar': []
  'toggle-mobile-sidebar': []
  'abort': []
  'toggle-metrics': []
}>()

const home = useHomeDirectory()
const displayDirectory = computed(() => {
  const directory = props.directory || props.session?.directory || ''
  return directory && directory !== '.' ? directory : ''
})
const shortDirectory = computed(() => tildify(displayDirectory.value, home.value))
</script>

<template>
  <header class="header glass-header">
    <div class="header-left">
      <!-- 移动端菜单按钮（仅 ≤768px 显示） -->
      <button
        class="btn btn-ghost btn-icon mobile-menu-btn"
        @click="emit('toggle-mobile-sidebar')"
        title="打开侧边栏"
        aria-label="打开侧边栏"
      >
        <Menu :size="20" />
      </button>

      <button
        v-if="sidebarCollapsed"
        class="btn btn-ghost btn-icon"
        @click="emit('toggle-sidebar')"
        title="展开侧边栏"
        aria-label="展开侧边栏"
      >
        <PanelLeftOpen :size="20" />
      </button>

      <div class="session-info">
        <span class="session-title">{{ session?.title || '新会话' }}</span>
        <span v-if="displayDirectory" class="session-dir" :title="displayDirectory">
          <Folder :size="12" />
          <span v-if="projectName" class="session-project">{{ projectName }}</span>
          <span class="session-path">{{ shortDirectory }}</span>
        </span>
      </div>
    </div>

    <div class="header-center">
      <div
        v-if="session && connectionState && connectionState !== 'connected'"
        class="streaming-badge"
        :class="connectionState === 'offline' ? 'tone-error' : 'tone-warning'"
        role="status"
      >
        <span class="status-dot"></span>
        <span>{{ connectionState === 'offline' ? '连接已断开' : connectionState === 'reconnecting' ? '正在重新连接…' : '连接中…' }}</span>
      </div>
      <div v-else-if="pendingCount" class="streaming-badge tone-warning" role="status">
        <span class="status-dot"></span>
        <span>{{ pendingCount }} 项等待你确认</span>
      </div>
      <!-- Retry Indicator -->
      <div v-else-if="retryInfo" class="streaming-badge tone-warning" role="status" :title="retryInfo.message">
        <span class="status-dot pulsing"></span>
        <span class="streaming-text">第 {{ retryInfo.attempt }} 次重试：{{ retryInfo.message }}</span>
      </div>
      <!-- Streaming Indicator (centered when streaming) -->
      <div v-else-if="isStreaming" class="streaming-badge" role="status">
        <span class="status-dot pulsing"></span>
        <span class="streaming-text">正在处理</span>
      </div>
    </div>

    <div class="header-right">
      <button
        class="btn btn-ghost metrics-btn"
        @click="emit('toggle-metrics')"
      >
        <BarChart3 v-if="!showMetrics" :size="14" />
        <MessageSquare v-else :size="14" />
        <span>{{ showMetrics ? '对话' : '统计' }}</span>
      </button>

      <!-- Abort Button -->
      <button
        v-if="isStreaming"
        class="btn btn-ghost abort-btn"
        @click="emit('abort')"
      >
        <Square :size="14" fill="currentColor" />
        <span>停止</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.header-left, .session-info { min-width: 0; }
.session-title, .session-dir > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-dir > svg { flex-shrink: 0; }
.session-dir > span { min-width: 0; }
.session-project { flex-shrink: 0; max-width: 40%; color: var(--text-secondary); }
.session-path { font-family: var(--font-mono); }
.glass-header {
  background: transparent;
  border-bottom: none;
}

/* 移动端菜单按钮默认隐藏，仅 ≤768px 显示 */
.mobile-menu-btn {
  display: none;
}

@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
}

.session-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-title {
  font-weight: 600;
  font-size: var(--text-base);
}

.session-dir {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.streaming-badge {
  --tone: var(--accent);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  padding: 4px 12px 4px 10px;
  border: 1px solid color-mix(in srgb, var(--tone) 25%, transparent);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--tone) 8%, transparent);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--tone);
}

.streaming-badge.tone-warning { --tone: var(--warning); }
.streaming-badge.tone-error { --tone: var(--error); }

.streaming-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.status-dot.pulsing {
  animation: status-pulse 1.4s var(--ease-smooth) infinite;
}

@keyframes status-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.abort-btn {
  color: var(--error);
  font-size: var(--text-13);
  gap: 6px;
}

.metrics-btn {
  font-size: var(--text-13);
  gap: 6px;
  color: var(--text-muted);
}

@media (max-width: 640px) {
  .metrics-btn span { display: none; }
  .session-dir { max-width: 200px; }
}

.abort-btn:hover {
  background: var(--error-subtle);
}
</style>
