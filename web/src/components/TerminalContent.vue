<script setup lang="ts">
import { ref } from 'vue'
import { Terminal, X } from 'lucide-vue-next'
import AgentTerminalViewer from './AgentTerminalViewer.vue'
import { useAgentTerminal } from '../composables/useAgentTerminal'

const {
  terminals,
  activeTerminalId,
  activeTerminal,
  activeScreen,
  selectTerminal,
  closeTerminal,
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

// 关闭终端
async function handleCloseTerminal(id: string, e: Event) {
  e.stopPropagation()
  await closeTerminal(id)
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
        :class="{ active: activeTerminalId === term.id, exited: term.status === 'exited' }"
        @click="selectTerminal(term.id)"
      >
        <span class="status-dot" :style="{ background: getStatusColor(term.status) }"></span>
        <span class="tab-name">{{ term.name }}</span>
        <span class="tab-time">{{ formatTime(term.lastActivity) }}</span>
        <button class="close-tab-btn" @click="handleCloseTerminal(term.id, $event)" title="关闭终端">
          <X :size="12" />
        </button>
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
          <button
            v-if="terminals.length === 1"
            class="close-single-btn"
            @click="closeTerminal(activeTerminal.id)"
            title="关闭终端"
          >
            <X :size="14" />
          </button>
        </div>
        <AgentTerminalViewer
          ref="terminalViewerRef"
          :terminal-id="activeTerminal.id"
          :screen="activeScreen.screen"
          :screen-ansi="activeScreen.screenAnsi"
          :cursor="activeScreen.cursor"
          :rows="activeTerminal.rows"
          :cols="activeTerminal.cols"
          :status="activeTerminal.status"
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

.terminal-tab.exited {
  opacity: 0.7;
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

.close-tab-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.5;
  cursor: pointer;
  border-radius: 2px;
  transition: all var(--transition-fast);
}

.close-tab-btn:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.2);
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

.close-single-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.close-single-btn:hover {
  background: var(--danger, #f7768e);
  color: white;
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
