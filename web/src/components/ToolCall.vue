<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessagePart } from '../api/client'

const props = defineProps<{
  tool: MessagePart
}>()

const isExpanded = ref(false)

const toolName = computed(() => props.tool.tool || 'unknown')

const status = computed(() => props.tool.state?.status || 'pending')

const statusInfo = computed(() => {
  switch (status.value) {
    case 'pending':
      return { text: '等待中', class: 'pending' }
    case 'running':
      return { text: '执行中...', class: 'running' }
    case 'completed':
      return { text: '完成', class: 'success' }
    case 'error':
      return { text: '失败', class: 'error' }
    default:
      return { text: '未知', class: '' }
  }
})

// 根据工具类型显示目标
const toolTarget = computed(() => {
  const input = props.tool.state?.input
  if (!input) return ''

  // 文件相关工具
  if (input.filePath || input.file_path) {
    return input.filePath || input.file_path
  }
  // 路径相关
  if (input.path) return input.path
  // 命令
  if (input.command) {
    const cmd = input.command as string
    return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd
  }
  // 搜索模式
  if (input.pattern) return `"${input.pattern}"`
  // URL
  if (input.url) return input.url
  // 查询
  if (input.query) return input.query

  return ''
})

// 工具图标映射
const toolIcon = computed(() => {
  const icons: Record<string, string> = {
    read: '📄',
    write: '📝',
    edit: '✏️',
    bash: '⌨️',
    grep: '🔍',
    glob: '📂',
    list: '📋',
    webfetch: '🌐',
    task: '🤖',
    todowrite: '✅',
    todoread: '📋'
  }
  return icons[toolName.value.toLowerCase()] || '🔧'
})

// 工具显示名称
const displayName = computed(() => {
  const names: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Bash',
    grep: 'Grep',
    glob: 'Glob',
    list: 'List',
    webfetch: 'Fetch',
    task: 'Task',
    todowrite: 'Todo',
    todoread: 'Todo'
  }
  return names[toolName.value.toLowerCase()] || toolName.value
})

// 输出预览
const outputPreview = computed(() => {
  const output = props.tool.state?.output
  if (!output) return null

  const str = typeof output === 'string' ? output : JSON.stringify(output)
  return str.length > 300 ? str.slice(0, 300) + '...' : str
})

// 完整输入
const fullInput = computed(() => {
  const input = props.tool.state?.input
  if (!input) return ''
  return JSON.stringify(input, null, 2)
})

// 执行时间
const executionTime = computed(() => {
  const time = props.tool.state?.time
  if (!time?.start || !time?.end) return null
  const duration = time.end - time.start
  if (duration < 1000) return `${duration}ms`
  return `${(duration / 1000).toFixed(1)}s`
})
</script>

<template>
  <div class="tool-call" :class="statusInfo.class">
    <div class="tool-header" @click="isExpanded = !isExpanded">
      <span class="tool-icon">{{ toolIcon }}</span>
      <span class="tool-name mono">{{ displayName }}</span>
      <span v-if="toolTarget" class="tool-target mono">{{ toolTarget }}</span>
      <span class="tool-status">
        <span v-if="status === 'running'" class="spinner"></span>
        <span class="status-text">{{ statusInfo.text }}</span>
        <span v-if="executionTime" class="exec-time">{{ executionTime }}</span>
      </span>
      <span class="expand-icon" :class="{ expanded: isExpanded }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      </span>
    </div>

    <div v-if="isExpanded" class="tool-details">
      <div v-if="tool.state?.input" class="detail-section">
        <div class="detail-label">输入参数</div>
        <pre class="detail-content mono">{{ fullInput }}</pre>
      </div>
      <div v-if="outputPreview" class="detail-section">
        <div class="detail-label">输出结果</div>
        <pre class="detail-content mono">{{ outputPreview }}</pre>
      </div>
      <div v-if="tool.state?.error" class="detail-section error">
        <div class="detail-label">错误</div>
        <pre class="detail-content mono error-text">{{ tool.state.error }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-call {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  border-left: 3px solid var(--border-color);
  transition: all var(--transition-fast);
  animation: slideIn 0.15s ease-out;
}

.tool-call:hover {
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-sm);
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.tool-call.pending {
  border-left-color: var(--text-muted);
}

.tool-call.running {
  border-left-color: var(--accent-blue);
}

.tool-call.success {
  border-left-color: var(--accent-green);
}

.tool-call.error {
  border-left-color: var(--accent-red);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}

.tool-header:hover {
  background: var(--bg-tertiary);
}

.tool-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-blue);
  flex-shrink: 0;
}

.tool-target {
  font-size: 12px;
  color: var(--text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  flex-shrink: 0;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status-text {
  color: var(--text-muted);
}

.running .status-text {
  color: var(--accent-blue);
}

.success .status-text {
  color: var(--accent-green);
}

.error .status-text {
  color: var(--accent-red);
}

.exec-time {
  color: var(--text-muted);
  font-size: 10px;
}

.expand-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  transition: transform 0.15s;
  flex-shrink: 0;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.tool-details {
  padding: 12px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.detail-section {
  margin-bottom: 12px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.detail-content {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.error-text {
  color: var(--accent-red);
}
</style>
