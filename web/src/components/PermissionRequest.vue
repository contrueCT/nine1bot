<script setup lang="ts">
import { ref, computed } from 'vue'
import type { PermissionRequest } from '../api/client'
import { permissionApi } from '../api/client'

const props = defineProps<{
  request: PermissionRequest
}>()

const emit = defineEmits<{
  (e: 'responded', response: 'once' | 'always' | 'reject'): void
}>()

const isSubmitting = ref(false)
const isResponded = ref(false)
const responseType = ref<'once' | 'always' | 'reject' | null>(null)
const errorMessage = ref('')

const permissionLabel = computed(() => {
  const labels: Record<string, string> = {
    bash: '执行命令',
    edit: '编辑文件',
    read: '读取文件',
    glob: '搜索文件',
    grep: '搜索内容',
    list: '列出目录',
    webfetch: '访问 URL',
    websearch: '网页搜索',
    task: '运行任务',
    external_directory: '访问外部目录',
    doom_loop: '重复工具调用',
  }
  return labels[props.request.permission] || props.request.permission
})

const permissionIcon = computed(() => {
  const icons: Record<string, string> = {
    bash: 'terminal',
    edit: 'edit',
    read: 'file',
    external_directory: 'folder',
  }
  return icons[props.request.permission] || 'lock'
})

const patterns = computed(() => {
  if (!props.request.patterns?.length) return null
  return props.request.patterns.join(', ')
})

const respond = async (reply: 'once' | 'always' | 'reject') => {
  if (isSubmitting.value) return

  isSubmitting.value = true
  responseType.value = reply
  errorMessage.value = ''

  try {
    await permissionApi.reply(props.request.id, reply)
    isResponded.value = true
    emit('responded', reply)
  } catch (error) {
    console.error('Failed to respond to permission:', error)
    errorMessage.value = error instanceof Error ? error.message : '操作失败，请重试'
    responseType.value = null
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="permission-request" :class="{ responded: isResponded }">
    <div class="permission-header">
      <div class="permission-icon" :class="permissionIcon">
        <svg v-if="permissionIcon === 'terminal'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
        <svg v-else-if="permissionIcon === 'edit'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        <svg v-else-if="permissionIcon === 'file'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <svg v-else-if="permissionIcon === 'folder'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <span class="permission-label">权限请求</span>
    </div>

    <div class="permission-content">
      <div class="permission-type">{{ permissionLabel }}</div>
      <div v-if="patterns" class="permission-patterns">
        <code>{{ patterns }}</code>
      </div>
      <div v-if="request.metadata?.command" class="permission-detail">
        <code class="command">{{ request.metadata.command }}</code>
      </div>
    </div>

    <div v-if="!isResponded" class="permission-actions">
      <button
        class="btn btn-danger"
        :disabled="isSubmitting"
        @click="respond('reject')"
      >
        <span v-if="isSubmitting && responseType === 'reject'" class="loading-spinner small"></span>
        <span v-else>拒绝</span>
      </button>
      <button
        class="btn btn-ghost"
        :disabled="isSubmitting"
        @click="respond('once')"
      >
        <span v-if="isSubmitting && responseType === 'once'" class="loading-spinner small"></span>
        <span v-else>允许一次</span>
      </button>
      <button
        class="btn btn-primary"
        :disabled="isSubmitting"
        @click="respond('always')"
      >
        <span v-if="isSubmitting && responseType === 'always'" class="loading-spinner small"></span>
        <span v-else>始终允许</span>
      </button>
    </div>

    <div v-if="errorMessage" class="permission-error">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ errorMessage }}</span>
    </div>

    <div v-else class="permission-responded" :class="responseType">
      <template v-if="responseType === 'always'">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
        <span>已始终允许</span>
      </template>
      <template v-else-if="responseType === 'once'">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
        <span>已允许一次</span>
      </template>
      <template v-else>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
        <span>已拒绝</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.permission-request {
  background: var(--glass-bg);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin: var(--space-sm) 0;
}

.permission-request.responded {
  opacity: 0.7;
  border-color: var(--glass-border);
}

.permission-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.permission-icon {
  color: var(--warning);
  display: flex;
  align-items: center;
}

.permission-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--warning);
}

.permission-content {
  margin-bottom: var(--space-md);
}

.permission-type {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: var(--space-xs);
}

.permission-patterns {
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.permission-patterns code {
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
}

.permission-detail {
  margin-top: var(--space-sm);
}

.permission-detail .command {
  display: block;
  background: var(--surface-1);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-primary);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.permission-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-default);
}

.btn-danger {
  background: transparent;
  color: var(--error);
  border: 1px solid var(--error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--error);
  color: var(--solid-fg);
}

.permission-responded {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: 0.75rem;
  font-weight: 500;
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-default);
}

.permission-responded svg {
  flex-shrink: 0;
}

/* Color based on response type */
.permission-responded.always,
.permission-responded.once {
  color: var(--success);
}

.permission-responded.reject {
  color: var(--error);
}

.loading-spinner.small {
  width: 14px;
  height: 14px;
}

.permission-error {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-top: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--error-subtle);
  border: 1px solid var(--error);
  border-radius: var(--radius-sm);
  color: var(--error);
  font-size: 0.8125rem;
}

.permission-error svg {
  flex-shrink: 0;
}
</style>
