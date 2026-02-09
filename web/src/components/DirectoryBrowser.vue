<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { Folder, FolderOpen, ChevronUp, X, Loader2, AlertCircle, Home } from 'lucide-vue-next'
import { api } from '../api/client'

interface DirectoryItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
}

const props = defineProps<{
  visible: boolean
  initialPath?: string
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'cancel'): void
}>()

const currentPath = ref('')
const parentPath = ref<string | null>(null)
const items = ref<DirectoryItem[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)

// 加载目录内容
async function loadDirectory(path: string) {
  isLoading.value = true
  error.value = null

  try {
    const result = await api.browseDirectory(path)
    currentPath.value = result.path
    parentPath.value = result.parent
    // 只显示目录，过滤掉文件
    items.value = result.items.filter(item => item.type === 'directory')
  } catch (e: any) {
    error.value = e.message || '无法访问此目录'
    // 如果是首次加载失败，尝试加载主目录
    if (!currentPath.value) {
      try {
        const fallback = await api.browseDirectory('~')
        currentPath.value = fallback.path
        parentPath.value = fallback.parent
        items.value = fallback.items.filter(item => item.type === 'directory')
        error.value = null
      } catch {
        // 忽略回退错误
      }
    }
  } finally {
    isLoading.value = false
  }
}

// 返回上级目录
function navigateUp() {
  if (parentPath.value) {
    loadDirectory(parentPath.value)
  }
}

// 进入子目录
function navigateTo(item: DirectoryItem) {
  loadDirectory(item.path)
}

// 返回主目录
function navigateHome() {
  loadDirectory('~')
}

// 确认选择
function confirm() {
  emit('select', currentPath.value)
}

// 取消
function cancel() {
  emit('cancel')
}

// 点击遮罩关闭
function handleOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
    cancel()
  }
}

// 键盘事件处理
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) {
    cancel()
  }
}

// 获取目录显示名称
function getDisplayPath(path: string): string {
  // Windows 路径处理
  if (path.includes('\\')) {
    return path
  }
  return path
}

// 监听 visible 变化，加载初始目录
watch(() => props.visible, (visible) => {
  if (visible) {
    const path = props.initialPath || '~'
    loadDirectory(path)
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click="handleOverlayClick">
      <div class="modal directory-browser-modal">
        <!-- Header -->
        <div class="modal-header">
          <h2 class="modal-title">选择工作目录</h2>
          <button class="btn btn-ghost btn-icon sm" @click="cancel">
            <X :size="18" />
          </button>
        </div>

        <!-- Current Path Bar -->
        <div class="directory-path-bar">
          <button
            class="path-btn home-btn"
            @click="navigateHome"
            title="返回主目录"
          >
            <Home :size="16" />
          </button>
          <button
            class="path-btn up-btn"
            @click="navigateUp"
            :disabled="!parentPath"
            title="返回上级目录"
          >
            <ChevronUp :size="16" />
          </button>
          <div class="current-path">
            <FolderOpen :size="16" class="path-icon" />
            <span class="path-text">{{ getDisplayPath(currentPath) }}</span>
          </div>
        </div>

        <!-- Directory List -->
        <div class="modal-body directory-list">
          <!-- Loading State -->
          <div v-if="isLoading" class="directory-state">
            <Loader2 :size="24" class="spin" />
            <span>加载中...</span>
          </div>

          <!-- Error State -->
          <div v-else-if="error" class="directory-state error">
            <AlertCircle :size="24" />
            <span>{{ error }}</span>
            <button class="btn btn-secondary btn-sm" @click="navigateHome">
              返回主目录
            </button>
          </div>

          <!-- Empty State -->
          <div v-else-if="items.length === 0" class="directory-state">
            <Folder :size="24" />
            <span>此目录下没有子目录</span>
          </div>

          <!-- Directory Items -->
          <div v-else class="directory-items">
            <button
              v-for="item in items"
              :key="item.path"
              class="directory-item"
              @click="navigateTo(item)"
              @dblclick="navigateTo(item)"
            >
              <Folder :size="18" class="item-icon" />
              <span class="item-name">{{ item.name }}</span>
            </button>
          </div>
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="cancel">
            取消
          </button>
          <button class="btn btn-primary" @click="confirm" :disabled="!currentPath">
            选择此目录
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.directory-browser-modal {
  width: 90%;
  max-width: 550px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

.directory-path-bar {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-lg);
  background: var(--bg-secondary);
  border-bottom: 0.5px solid var(--border-subtle);
}

.path-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-normal);
  flex-shrink: 0;
}

.path-btn:hover:not(:disabled) {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.path-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.current-path {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  border: 0.5px solid var(--border-subtle);
  min-width: 0;
}

.path-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.path-text {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-list {
  flex: 1;
  min-height: 200px;
  max-height: 400px;
  padding: var(--space-sm) !important;
}

.directory-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  height: 100%;
  min-height: 150px;
  color: var(--text-tertiary);
}

.directory-state.error {
  color: var(--status-error);
}

.directory-state .spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.directory-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.directory-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--transition-normal);
  text-align: left;
  width: 100%;
}

.directory-item:hover {
  background: var(--bg-secondary);
}

.directory-item:active {
  background: var(--bg-tertiary);
}

.item-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
}

.modal-footer {
  gap: var(--space-sm);
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 0.8125rem;
}
</style>
