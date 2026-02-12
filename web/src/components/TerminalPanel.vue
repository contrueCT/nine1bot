<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { Terminal, X, ChevronLeft } from 'lucide-vue-next'
import AgentTerminalViewer from './AgentTerminalViewer.vue'
import { useAgentTerminal } from '../composables/useAgentTerminal'

const {
  terminals,
  activeTerminalId,
  activeTerminal,
  activeScreen,
  isPanelOpen,
  selectTerminal,
  closePanel,
  closeTerminal,
} = useAgentTerminal()

const terminalViewerRef = ref<InstanceType<typeof AgentTerminalViewer> | null>(null)

// 面板宽度
const panelWidth = ref(400)
const isResizing = ref(false)

// 保存当前的事件处理器引用以便清理
let currentMouseMoveHandler: ((e: MouseEvent) => void) | null = null
let currentMouseUpHandler: (() => void) | null = null

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

// 清理 resize 事件监听器
function cleanupResizeListeners() {
  if (currentMouseMoveHandler) {
    document.removeEventListener('mousemove', currentMouseMoveHandler)
    currentMouseMoveHandler = null
  }
  if (currentMouseUpHandler) {
    document.removeEventListener('mouseup', currentMouseUpHandler)
    currentMouseUpHandler = null
  }
  isResizing.value = false
}

// 开始调整大小
function startResize(e: MouseEvent) {
  // 先清理可能存在的旧监听器
  cleanupResizeListeners()

  isResizing.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value

  currentMouseMoveHandler = (e: MouseEvent) => {
    const diff = startX - e.clientX
    panelWidth.value = Math.max(300, Math.min(800, startWidth + diff))
  }

  currentMouseUpHandler = () => {
    cleanupResizeListeners()
  }

  document.addEventListener('mousemove', currentMouseMoveHandler)
  document.addEventListener('mouseup', currentMouseUpHandler)
}

// 组件销毁时清理事件监听器
onUnmounted(() => {
  cleanupResizeListeners()
})

// 监听面板打开，调整终端大小
watch(isPanelOpen, (open) => {
  if (open) {
    nextTick(() => {
      terminalViewerRef.value?.fit()
    })
  }
})

// 监听面板宽度变化，调整终端大小
watch(panelWidth, () => {
  nextTick(() => {
    terminalViewerRef.value?.fit()
  })
})
</script>

<template>
  <div
    v-if="isPanelOpen"
    class="terminal-panel"
    :style="{ width: `${panelWidth}px` }"
  >
    <!-- 调整大小手柄 -->
    <div class="resize-handle" @mousedown="startResize"></div>

    <!-- 面板头部 -->
    <div class="panel-header">
      <div class="panel-title">
        <Terminal :size="16" />
        <span>Agent Terminals</span>
        <span class="terminal-count">{{ terminals.length }}</span>
      </div>
      <button class="close-btn" @click="closePanel" title="关闭面板">
        <X :size="16" />
      </button>
    </div>

    <!-- 终端标签 -->
    <div v-if="terminals.length > 0" class="terminal-tabs">
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
    <div class="terminal-content">
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

  <!-- 折叠时的展开按钮 -->
  <button
    v-else-if="terminals.length > 0"
    class="expand-btn"
    @click="isPanelOpen = true"
    title="打开终端面板"
  >
    <ChevronLeft :size="16" />
    <Terminal :size="16" />
    <span class="expand-count">{{ terminals.length }}</span>
  </button>
</template>

<style scoped>
.terminal-panel {
  position: relative;
  height: 100%;
  background: var(--bg-primary);
  border-left: 0.5px solid var(--border-default);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: ew-resize;
  background: transparent;
  transition: background 0.2s;
  z-index: 10;
}

.resize-handle:hover {
  background: var(--accent);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 0.5px solid var(--border-default);
  flex-shrink: 0;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.terminal-count {
  background: var(--accent);
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
}

.close-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.close-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.terminal-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  padding: var(--space-sm);
  border-bottom: 0.5px solid var(--border-default);
  flex-shrink: 0;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-subtle);
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
  border: 0.5px solid white;
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

.terminal-content {
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
  color: var(--border-default);
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

/* 展开按钮 */
.expand-btn {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-right: none;
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  z-index: 100;
}

.expand-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.expand-count {
  background: var(--accent);
  color: white;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 8px;
}
</style>
