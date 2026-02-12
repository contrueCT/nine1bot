<script setup lang="ts">
import { X, FileText, Copy, Check } from 'lucide-vue-next'
import { ref, onUnmounted } from 'vue'
import type { FileContent } from '../api/client'

const props = defineProps<{
  file: FileContent | null
  isLoading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function copyContent() {
  if (!props.file?.content) return
  try {
    await navigator.clipboard.writeText(props.file.content)
    copied.value = true
    // 清理之前的定时器
    if (copyTimer) {
      clearTimeout(copyTimer)
    }
    copyTimer = setTimeout(() => copied.value = false, 2000)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

// 组件销毁时清理定时器
onUnmounted(() => {
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
})

function getFileName(path: string): string {
  return path.split('/').pop() || path.split('\\').pop() || path
}
</script>

<template>
  <div class="file-viewer-overlay" @click="emit('close')">
    <div class="file-viewer" @click.stop>
      <div class="viewer-header">
        <div class="viewer-title">
          <FileText :size="18" />
          <span>{{ file?.path ? getFileName(file.path) : '文件预览' }}</span>
        </div>
        <div class="viewer-actions">
          <button class="action-btn" @click="copyContent" :title="copied ? '已复制' : '复制内容'" :disabled="!file?.content">
            <Check v-if="copied" :size="16" />
            <Copy v-else :size="16" />
          </button>
          <button class="action-btn" @click="emit('close')" title="关闭">
            <X :size="16" />
          </button>
        </div>
      </div>

      <div class="viewer-body custom-scrollbar">
        <div v-if="isLoading" class="viewer-loading">
          <div class="loading-spinner"></div>
          <span>加载中...</span>
        </div>
        <div v-else-if="error" class="viewer-error">
          <p>{{ error }}</p>
        </div>
        <pre v-else-if="file?.content" class="viewer-content custom-scrollbar"><code>{{ file.content }}</code></pre>
        <div v-else class="viewer-empty">
          <p>文件内容为空</p>
        </div>
      </div>

      <div class="viewer-footer" v-if="file?.path">
        <span class="file-path">{{ file.path }}</span>
        <span v-if="file.encoding" class="file-encoding">{{ file.encoding }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-viewer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
  padding: var(--space-lg);
}

.file-viewer {
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  width: 100%;
  max-width: 900px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
}

.viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  border-bottom: 0.5px solid var(--border-default);
}

.viewer-title {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.viewer-actions {
  display: flex;
  gap: var(--space-xs);
}

.action-btn {
  width: 32px;
  height: 32px;
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

.action-btn:hover:not(:disabled) {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.viewer-body {
  flex: 1;
  overflow: hidden;
  min-height: 200px;
  display: flex;
  flex-direction: column;
}

.viewer-loading,
.viewer-error,
.viewer-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-muted);
  gap: var(--space-sm);
}

.viewer-error {
  color: var(--error, #ef4444);
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.viewer-content {
  margin: 0;
  padding: var(--space-md);
  background: var(--bg-secondary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre;
  word-break: normal;
  overflow: auto;
  flex: 1;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.viewer-content code {
  display: block;
  min-width: fit-content;
}

.viewer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-top: 0.5px solid var(--border-default);
  background: var(--bg-secondary);
  font-size: 12px;
  color: var(--text-muted);
}

.file-path {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-encoding {
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  text-transform: uppercase;
}
</style>
