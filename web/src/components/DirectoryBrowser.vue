<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Folder, ChevronRight, Home, X } from 'lucide-vue-next'
import { api } from '../api/client'

const emit = defineEmits<{
  select: [path: string]
  close: []
}>()

const currentPath = ref('~')
const parent = ref<string | null>(null)
const items = ref<Array<{
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
}>>([])
const isLoading = ref(false)
const error = ref<string | null>(null)

async function browse(path: string) {
  isLoading.value = true
  error.value = null
  try {
    const result = await api.browseDirectory(path)
    currentPath.value = result.path
    parent.value = result.parent
    items.value = result.items.filter(item => item.type === 'directory')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '无法加载目录'
    console.error('Failed to browse directory:', e)
  } finally {
    isLoading.value = false
  }
}

function navigateToParent() {
  if (parent.value) {
    browse(parent.value)
  }
}

function navigateToHome() {
  browse('~')
}

function selectDirectory(item: { path: string; type: string }) {
  if (item.type === 'directory') {
    browse(item.path)
  }
}

function confirmSelection() {
  emit('select', currentPath.value)
}

function closeModal() {
  emit('close')
}

onMounted(() => {
  browse('~')
})
</script>

<template>
  <div class="directory-browser-overlay" @click.self="closeModal">
    <div class="directory-browser-modal">
      <div class="modal-header">
        <h3 class="modal-title">选择工作目录</h3>
        <button class="close-btn" @click="closeModal">
          <X :size="20" />
        </button>
      </div>

      <div class="modal-body">
        <!-- Navigation Bar -->
        <div class="navigation-bar">
          <button class="nav-btn" @click="navigateToHome" title="主目录">
            <Home :size="16" />
          </button>
          <button 
            class="nav-btn" 
            @click="navigateToParent" 
            :disabled="!parent"
            title="上级目录"
          >
            <ChevronRight :size="16" style="transform: rotate(180deg)" />
          </button>
          <div class="current-path">{{ currentPath }}</div>
        </div>

        <!-- Loading State -->
        <div v-if="isLoading" class="loading-state">
          <div class="loading-spinner"></div>
          <span>加载中...</span>
        </div>

        <!-- Error State -->
        <div v-else-if="error" class="error-state">
          <p>{{ error }}</p>
          <button class="btn btn-sm" @click="browse(currentPath)">重试</button>
        </div>

        <!-- Directory List -->
        <div v-else class="directory-list custom-scrollbar">
          <div
            v-for="item in items"
            :key="item.path"
            class="directory-item"
            @click="selectDirectory(item)"
          >
            <Folder :size="16" class="folder-icon" />
            <span class="directory-name">{{ item.name }}</span>
            <ChevronRight :size="16" class="chevron-icon" />
          </div>
          <div v-if="items.length === 0" class="empty-state">
            此目录下没有子文件夹
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" @click="closeModal">取消</button>
        <button class="btn btn-primary" @click="confirmSelection">选择此目录</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.directory-browser-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fade-in 0.2s ease;
}

.directory-browser-modal {
  background: var(--bg-secondary);
  border-radius: 16px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
  animation: slide-up 0.3s ease;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.modal-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.navigation-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
}

.nav-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  cursor: pointer;
  padding: 8px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.nav-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--accent);
}

.nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.current-path {
  flex: 1;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  padding: 8px 12px;
  border-radius: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  gap: 16px;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.error-state p {
  color: var(--error, #ef4444);
  margin: 0;
}

.directory-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.directory-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.directory-item:hover {
  background: var(--bg-tertiary);
}

.folder-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.directory-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.empty-state {
  text-align: center;
  padding: 48px 24px;
  color: var(--text-muted);
  font-size: 14px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border);
}

.btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

.btn-primary {
  background: var(--accent);
  color: white;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slide-up {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
