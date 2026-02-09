<script setup lang="ts">
import { computed } from 'vue'
import { ListTodo, Circle, CheckCircle2, Loader2, X, ClipboardList } from 'lucide-vue-next'
import type { TodoItem } from '../api/client'

const props = defineProps<{
  items: TodoItem[]
  isLoading?: boolean
}>()

const emit = defineEmits<{
  close: []
  refresh: []
}>()

// 检测是否有 plan mode 任务
const hasPlanMode = computed(() => props.items.some(item => item.planMode))

// 获取当前进行中的任务
const currentTask = computed(() => props.items.find(item => item.status === 'in_progress'))

// 任务统计
const stats = computed(() => {
  const total = props.items.length
  const completed = props.items.filter(item => item.status === 'completed').length
  const pending = props.items.filter(item => item.status === 'pending').length
  const inProgress = props.items.filter(item => item.status === 'in_progress').length
  return { total, completed, pending, inProgress }
})

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
    case 'cancelled':
      return '已取消'
    default:
      return '待处理'
  }
}

function getPriorityClass(priority: string) {
  switch (priority) {
    case 'high':
      return 'priority-high'
    case 'medium':
      return 'priority-medium'
    default:
      return 'priority-low'
  }
}

function getPriorityText(priority: string) {
  switch (priority) {
    case 'high':
      return '高'
    case 'medium':
      return '中'
    default:
      return '低'
  }
}

// 获取显示文本（进行中的任务显示 activeForm，否则显示 content）
function getDisplayText(item: TodoItem): string {
  if (item.status === 'in_progress' && item.activeForm) {
    return item.activeForm
  }
  return item.content
}
</script>

<template>
  <div class="todo-panel" :class="{ 'plan-mode': hasPlanMode }">
    <div class="todo-header">
      <div class="todo-title">
        <ClipboardList v-if="hasPlanMode" :size="18" class="plan-icon" />
        <ListTodo v-else :size="18" />
        <span>{{ hasPlanMode ? '规划模式' : '待办事项' }}</span>
        <span class="todo-count" v-if="items.length">{{ stats.completed }}/{{ stats.total }}</span>
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

    <!-- 当前任务进度显示 -->
    <div v-if="currentTask" class="current-task">
      <Loader2 :size="14" class="spinning" />
      <span class="current-task-text">{{ currentTask.activeForm || currentTask.content }}</span>
    </div>

    <!-- 进度条 -->
    <div v-if="items.length > 0" class="progress-bar">
      <div class="progress-fill" :style="{ width: `${(stats.completed / stats.total) * 100}%` }"></div>
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
          :class="[getStatusClass(item.status), { 'plan-item': item.planMode }]"
        >
          <component
            :is="getStatusIcon(item.status)"
            :size="16"
            class="todo-icon"
            :class="{ spinning: item.status === 'in_progress' }"
          />
          <div class="todo-content">
            <div class="todo-text">{{ getDisplayText(item) }}</div>
            <div class="todo-meta">
              <span class="todo-status">{{ getStatusText(item.status) }}</span>
              <span class="todo-priority" :class="getPriorityClass(item.priority)">
                {{ getPriorityText(item.priority) }}
              </span>
              <span v-if="item.planMode" class="todo-plan-badge">规划</span>
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
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  max-height: 400px;
  box-shadow: var(--shadow-md);
}

.todo-panel.plan-mode {
  border-color: var(--accent);
}

.plan-icon {
  color: var(--accent);
}

.todo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  border-bottom: 0.5px solid var(--border-subtle);
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
  border: 2px solid var(--border-default);
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
  border: 0.5px solid var(--border-subtle);
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

.status-completed .todo-text {
  text-decoration: line-through;
  opacity: 0.7;
}

.todo-content {
  flex: 1;
  min-width: 0;
}

.todo-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
  line-height: 1.4;
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

.todo-priority {
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
}

.priority-high {
  background: rgba(239, 68, 68, 0.1);
  color: var(--error, #ef4444);
}

.priority-medium {
  background: rgba(245, 158, 11, 0.1);
  color: var(--warning, #f59e0b);
}

.priority-low {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

/* Current task indicator */
.current-task {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  background: rgba(var(--accent-rgb, 99, 102, 241), 0.1);
  border-bottom: 0.5px solid var(--border-subtle);
  font-size: 12px;
  color: var(--accent);
}

.current-task-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Progress bar */
.progress-bar {
  height: 3px;
  background: var(--bg-tertiary);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}

/* Plan mode specific styles */
.plan-item {
  border-left: 2px solid var(--accent);
}

.todo-plan-badge {
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(var(--accent-rgb, 99, 102, 241), 0.15);
  color: var(--accent);
}
</style>
