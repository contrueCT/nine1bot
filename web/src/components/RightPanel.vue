<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { Terminal, Eye, X, ChevronLeft } from 'lucide-vue-next'
import TerminalContent from './TerminalContent.vue'
import PreviewContent from './PreviewContent.vue'
import { useRightPanel } from '../composables/useRightPanel'
import { useAgentTerminal } from '../composables/useAgentTerminal'
import { useFilePreview } from '../composables/useFilePreview'

const {
  activeTab,
  panelWidth,
  isPanelOpen,
  hasTerminals,
  hasPreviews,
  setActiveTab,
  closePanel,
} = useRightPanel()

const { terminals } = useAgentTerminal()
const { previews } = useFilePreview()

const terminalContentRef = ref<InstanceType<typeof TerminalContent> | null>(null)
const isResizing = ref(false)

// 保存当前的事件处理器引用以便清理
let currentMouseMoveHandler: ((e: MouseEvent) => void) | null = null
let currentMouseUpHandler: (() => void) | null = null

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
  cleanupResizeListeners()

  isResizing.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value

  currentMouseMoveHandler = (e: MouseEvent) => {
    const diff = startX - e.clientX
    panelWidth.value = Math.max(300, Math.min(900, startWidth + diff))
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

// 监听面板打开和宽度变化，调整终端大小
watch([isPanelOpen, panelWidth, activeTab], () => {
  if (isPanelOpen.value && activeTab.value === 'terminal') {
    nextTick(() => {
      terminalContentRef.value?.fit()
    })
  }
})
</script>

<template>
  <div
    v-if="isPanelOpen"
    class="right-panel"
    :style="{ width: `${panelWidth}px` }"
  >
    <!-- 调整大小手柄 -->
    <div class="resize-handle" @mousedown="startResize"></div>

    <!-- 面板头部 - 标签切换 -->
    <div class="panel-header">
      <div class="panel-tabs">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'terminal', disabled: !hasTerminals }"
          @click="hasTerminals && setActiveTab('terminal')"
          :disabled="!hasTerminals"
        >
          <Terminal :size="14" />
          <span>终端</span>
          <span v-if="terminals.length > 0" class="badge">{{ terminals.length }}</span>
        </button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'preview', disabled: !hasPreviews }"
          @click="hasPreviews && setActiveTab('preview')"
          :disabled="!hasPreviews"
        >
          <Eye :size="14" />
          <span>预览</span>
          <span v-if="previews.length > 0" class="badge">{{ previews.length }}</span>
        </button>
      </div>
      <button class="close-btn" @click="closePanel" title="关闭面板">
        <X :size="16" />
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="panel-content">
      <TerminalContent
        v-show="activeTab === 'terminal'"
        ref="terminalContentRef"
      />
      <PreviewContent
        v-show="activeTab === 'preview'"
      />
    </div>
  </div>

  <!-- 折叠时的展开按钮 -->
  <button
    v-else-if="hasTerminals || hasPreviews"
    class="expand-btn"
    @click="isPanelOpen = true"
    title="打开面板"
  >
    <ChevronLeft :size="16" />
    <Terminal v-if="hasTerminals" :size="16" />
    <Eye v-else :size="16" />
    <span class="expand-count">{{ terminals.length + previews.length }}</span>
  </button>
</template>

<style scoped>
.right-panel {
  position: relative;
  height: 100%;
  background: var(--bg-primary);
  border-left: 1px solid var(--border);
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
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.panel-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.tab-btn:hover:not(.disabled) {
  background: var(--bg-tertiary);
}

.tab-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.tab-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.badge {
  background: rgba(255, 255, 255, 0.2);
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 8px;
}

.tab-btn:not(.active) .badge {
  background: var(--bg-tertiary);
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

.panel-content {
  flex: 1;
  overflow: hidden;
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
  border: 1px solid var(--border);
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
