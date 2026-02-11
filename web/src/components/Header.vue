<script setup lang="ts">
import { Square, PanelLeftOpen, Folder } from 'lucide-vue-next'
import type { Session } from '../api/client'

defineProps<{
  session: Session | null
  isStreaming: boolean
  sidebarCollapsed: boolean
  retryInfo?: { attempt: number; message: string; next: number } | null
}>()

const emit = defineEmits<{
  'toggle-sidebar': []
  'abort': []
}>()
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
        <span v-if="session.directory && session.directory !== '.'" class="session-dir" :title="session.directory">
          <Folder :size="12" /> {{ session.directory }}
        </span>
      </div>
    </div>

    <div class="header-center">
      <!-- Retry Indicator -->
      <div v-if="retryInfo" class="streaming-badge retry-badge">
        <span class="retry-dot"></span>
        <span class="streaming-text">重试中 (第{{ retryInfo.attempt }}次) - {{ retryInfo.message }}</span>
      </div>
      <!-- Streaming Indicator (centered when streaming) -->
      <div v-else-if="isStreaming" class="streaming-badge">
        <span class="streaming-dot"></span>
        <span class="streaming-text">生成中</span>
      </div>
    </div>

    <div class="header-right">
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
.glass-header {
  background: transparent;
  border-bottom: none;
  z-index: 10;
  font-family: var(--font-sans);
}

.session-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-title {
  font-weight: 600;
  font-size: 14px;
}

.session-dir {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.retry-badge .streaming-text {
  color: var(--warning, #f59e0b);
}

.retry-dot {
  width: 8px;
  height: 8px;
  background: var(--warning, #f59e0b);
  border-radius: 50%;
  animation: pulse 1.5s infinite;
  box-shadow: 0 0 8px var(--warning, #f59e0b);
}

.abort-btn {
  color: var(--error);
  font-size: 13px;
  gap: 6px;
}

.abort-btn:hover {
  background: var(--error-subtle);
}
</style>
