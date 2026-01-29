<script setup lang="ts">
import { ListTodo, Circle, CheckCircle2, Loader2, X } from 'lucide-vue-next'
import type { TodoItem } from '../api/client'

defineProps<{
  items: TodoItem[]
  isLoading?: boolean
}>()

const emit = defineEmits<{
  close: []
  refresh: []
}>()

function getStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return CheckCircle2
    case 'in_progress':
      return Loader2
    default:
      return Circle
  }
}

function getStatusClass(status: string) {
  switch (status) {
    case 'completed':
      return 'status-completed'
    case 'in_progress':
      return 'status-progress'
    default:
      return 'status-pending'
  }
}

function getStatusText(status: string) {
  switch (status) {
    case 'completed':
      return '已完成'
    case 'in_progress':
      return '进行中'
    default:
      return '待处理'
  }
}
</script>

<template>
  <div class="todo-panel">
    <div class="todo-header">
      <div class="todo-title">
        <ListTodo :size="18" />
        <span>待办事项</span>
        <span class="todo-count" v-if="items.length">{{ items.length }}</span>
      </div>
      <div class="todo-actions">
        <button class="action-btn" @click="emit('refresh')" :disabled="isLoading" title="刷新">
          <Loader2 v-if="isLoading" :size="16" class="spinning" />
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
        </button>
        <button class="action-btn" @click="emit('close')" title="关闭">
          <X :size="16" />
        </button>
      </div>
    </div>

    <div class="todo-body custom-scrollbar">
      <div v-if="isLoading && items.length === 0" class="todo-loading">
        <div class="loading-spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="items.length === 0" class="todo-empty">
        <ListTodo :size="32" class="empty-icon" />
        <p>暂无待办事项</p>
      </div>

      <div v-else class="todo-list">
        <div
          v-for="item in items"
          :key="item.id"
          class="todo-item"
          :class="getStatusClass(item.status)"
        >
          <component
            :is="getStatusIcon(item.status)"
            :size="16"
            class="todo-icon"
            :class="{ spinning: item.status === 'in_progress' }"
          />
          <div class="todo-content">
            <div class="todo-subject">{{ item.subject }}</div>
            <div v-if="item.description" class="todo-description">{{ item.description }}</div>
            <div class="todo-meta">
              <span class="todo-status">{{ getStatusText(item.status) }}</span>
              <span v-if="item.owner" class="todo-owner">{{ item.owner }}</span>
              <span v-if="item.blockedBy?.length" class="todo-blocked">
                阻塞于: {{ item.blockedBy.join(', ') }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-panel {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  max-height: 400px;
  box-shadow: var(--shadow-md);
}

.todo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  border-bottom: 1px solid var(--border);
}

.todo-title {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.todo-count {
  background: var(--accent);
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
}

.todo-actions {
  display: flex;
  gap: var(--space-xs);
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.todo-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-sm);
}

.todo-loading,
.todo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-xl);
  color: var(--text-muted);
  gap: var(--space-sm);
}

.empty-icon {
  opacity: 0.5;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.todo-item {
  display: flex;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  transition: all var(--transition-fast);
}

.todo-item:hover {
  background: var(--bg-tertiary);
}

.todo-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.status-pending .todo-icon {
  color: var(--text-muted);
}

.status-progress .todo-icon {
  color: var(--accent);
}

.status-completed .todo-icon {
  color: var(--success, #22c55e);
}

.status-completed .todo-subject {
  text-decoration: line-through;
  opacity: 0.7;
}

.todo-content {
  flex: 1;
  min-width: 0;
}

.todo-subject {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.todo-description {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.todo-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  font-size: 11px;
  color: var(--text-muted);
}

.todo-status {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-tertiary);
}

.status-progress .todo-status {
  background: rgba(var(--accent-rgb), 0.1);
  color: var(--accent);
}

.status-completed .todo-status {
  background: rgba(34, 197, 94, 0.1);
  color: var(--success, #22c55e);
}

.todo-owner {
  font-style: italic;
}

.todo-blocked {
  color: var(--warning, #f59e0b);
}
</style>
