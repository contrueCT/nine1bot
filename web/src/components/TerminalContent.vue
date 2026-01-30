<script setup lang="ts">
import { ref } from 'vue'
import { Terminal } from 'lucide-vue-next'
import AgentTerminalViewer from './AgentTerminalViewer.vue'
import { useAgentTerminal } from '../composables/useAgentTerminal'

const {
  terminals,
  activeTerminalId,
  activeTerminal,
  activeScreen,
  selectTerminal,
} = useAgentTerminal()

const terminalViewerRef = ref<InstanceType<typeof AgentTerminalViewer> | null>(null)

// 获取终端状态颜色
function getStatusColor(status: string): string {
  return status === 'running' ? 'var(--success, #10b981)' : 'var(--text-muted)'
}

// 格式化时间
function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
  return `${Math.floor(diff / 3600000)}h`
}

// 公开 fit 方法供父组件调用
function fit() {
  terminalViewerRef.value?.fit()
}

defineExpose({ fit })
</script>

<template>
  <div class="terminal-content">
    <!-- 终端标签 -->
    <div v-if="terminals.length > 1" class="terminal-tabs">
      <button
        v-for="term in terminals"
        :key="term.id"
        class="terminal-tab"
        :class="{ active: activeTerminalId === term.id }"
        @click="selectTerminal(term.id)"
      >
        <span class="status-dot" :style="{ background: getStatusColor(term.status) }"></span>
        <span class="tab-name">{{ term.name }}</span>
        <span class="tab-time">{{ formatTime(term.lastActivity) }}</span>
      </button>
    </div>

    <!-- 终端内容 -->
    <div class="terminal-body">
      <template v-if="activeTerminal && activeScreen">
        <div class="terminal-info">
          <span>{{ activeTerminal.name }}</span>
          <span class="separator">|</span>
          <span>{{ activeTerminal.cols }}x{{ activeTerminal.rows }}</span>
          <span class="separator">|</span>
          <span :style="{ color: getStatusColor(activeTerminal.status) }">
            {{ activeTerminal.status }}
          </span>
        </div>
        <AgentTerminalViewer
          ref="terminalViewerRef"
          :screen="activeScreen.screen"
          :cursor="activeScreen.cursor"
          :rows="activeTerminal.rows"
          :cols="activeTerminal.cols"
        />
      </template>
      <template v-else-if="terminals.length === 0">
        <div class="empty-state">
          <Terminal :size="48" class="empty-icon" />
          <p>没有活跃的终端</p>
          <p class="empty-hint">Agent 创建终端后会在这里显示</p>
        </div>
      </template>
      <template v-else>
        <div class="empty-state">
          <p>选择一个终端查看内容</p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.terminal-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.terminal-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  padding: var(--space-sm);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.terminal-tab:hover {
  background: var(--bg-tertiary);
}

.terminal-tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.terminal-tab.active .status-dot {
  border: 1px solid white;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tab-name {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-time {
  font-size: 10px;
  opacity: 0.7;
}

.terminal-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: var(--space-sm);
}

.terminal-info {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: var(--space-sm);
  flex-shrink: 0;
}

.separator {
  color: var(--border);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  text-align: center;
  padding: var(--space-lg);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: var(--space-md);
}

.empty-hint {
  font-size: 12px;
  opacity: 0.7;
  margin-top: var(--space-xs);
}
</style>
