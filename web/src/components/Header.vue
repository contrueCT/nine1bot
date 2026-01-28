<script setup lang="ts">
import type { Session } from '../api/client'

defineProps<{
  session: Session | null
  directory: string
  isStreaming: boolean
}>()

const emit = defineEmits<{
  'toggle-sidebar': []
  'new-session': []
  'abort': []
}>()
</script>

<template>
  <header class="header">
    <div class="header-left">
      <button class="icon-btn" @click="emit('toggle-sidebar')" title="切换侧边栏">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </button>
      <div class="logo">
        <span class="logo-text">Nine1Bot</span>
      </div>
    </div>

    <div class="header-center">
      <span class="directory mono" v-if="directory">{{ directory }}</span>
      <span class="session-title" v-if="session?.title">/ {{ session.title }}</span>
    </div>

    <div class="header-right">
      <span v-if="isStreaming" class="streaming-indicator">
        <span class="dot"></span>
        运行中
      </span>
      <button
        v-if="isStreaming"
        class="abort-btn"
        @click="emit('abort')"
        title="停止"
      >
        停止
      </button>
      <button class="new-session-btn" @click="emit('new-session')" title="新建会话">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        新建
      </button>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  height: 48px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.icon-btn {
  padding: 6px;
  border-radius: 6px;
  color: var(--text-secondary);
  transition: all 0.15s;
}

.icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo-text {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.header-center {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.directory {
  font-size: 12px;
}

.session-title {
  color: var(--text-muted);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.streaming-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--accent-blue);
}

.dot {
  width: 6px;
  height: 6px;
  background: var(--accent-blue);
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.abort-btn {
  padding: 4px 10px;
  font-size: 12px;
  background: var(--accent-red);
  color: white;
  border-radius: 4px;
  transition: opacity 0.15s;
}

.abort-btn:hover {
  opacity: 0.9;
}

.new-session-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: 13px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  transition: background 0.15s;
}

.new-session-btn:hover {
  background: var(--border-color);
}
</style>
