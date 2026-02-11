<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { FolderOpen, ArrowLeft, Check, X, Loader2, Home } from 'lucide-vue-next'
import { api } from '../api/client'

const emit = defineEmits<{
  select: [path: string]
  cancel: []
}>()

const currentPath = ref('')
const parentPath = ref<string | null>(null)
const items = ref<Array<{ name: string; path: string; type: 'file' | 'directory' }>>([])
const isLoading = ref(false)
const error = ref('')

async function browse(path: string) {
  isLoading.value = true
  error.value = ''
  try {
    const result = await api.browseDirectory(path)
    currentPath.value = result.path
    parentPath.value = result.parent
    items.value = result.items.filter(i => i.type === 'directory')
  } catch (e: any) {
    error.value = e.message || 'Failed to browse directory'
  } finally {
    isLoading.value = false
  }
}

function selectDirectory() {
  emit('select', currentPath.value)
}

function goUp() {
  if (parentPath.value) {
    browse(parentPath.value)
  }
}

function goHome() {
  browse('~')
}

onMounted(() => {
  browse('~')
})
</script>

<template>
  <div class="dir-browser">
    <div class="dir-browser-header">
      <span class="dir-browser-title">Select Directory</span>
      <button class="dir-browser-close" @click="emit('cancel')">
        <X :size="16" />
      </button>
    </div>

    <!-- Current path bar -->
    <div class="dir-path-bar">
      <button class="dir-nav-btn" @click="goHome" title="Home">
        <Home :size="14" />
      </button>
      <button class="dir-nav-btn" @click="goUp" :disabled="!parentPath" title="Up">
        <ArrowLeft :size="14" />
      </button>
      <span class="dir-current-path">{{ currentPath }}</span>
    </div>

    <!-- Directory list -->
    <div class="dir-list custom-scrollbar">
      <div v-if="isLoading" class="dir-loading">
        <Loader2 :size="16" class="spin" />
        <span>Loading...</span>
      </div>

      <div v-else-if="error" class="dir-error">
        {{ error }}
      </div>

      <template v-else>
        <button
          v-for="item in items"
          :key="item.path"
          class="dir-item"
          @click="browse(item.path)"
        >
          <FolderOpen :size="14" />
          <span>{{ item.name }}</span>
        </button>

        <div v-if="items.length === 0" class="dir-empty">
          No subdirectories
        </div>
      </template>
    </div>

    <!-- Footer -->
    <div class="dir-footer">
      <button class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
      <button class="btn btn-primary btn-sm" @click="selectDirectory" :disabled="!currentPath">
        <Check :size="14" />
        <span>Select this folder</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.dir-browser {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 400px;
  max-width: 90vw;
  max-height: 500px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dir-browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 0.5px solid var(--border-subtle);
}

.dir-browser-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.dir-browser-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.dir-browser-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dir-path-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: var(--space-xs) var(--space-sm);
  border-bottom: 0.5px solid var(--border-subtle);
  background: var(--bg-primary);
}

.dir-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.dir-nav-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dir-nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.dir-current-path {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.dir-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-xs);
  min-height: 200px;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
  text-align: left;
}

.dir-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dir-item svg {
  color: var(--accent);
  flex-shrink: 0;
}

.dir-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--space-xl);
  color: var(--text-muted);
  font-size: 13px;
}

.dir-error {
  padding: var(--space-md);
  color: var(--error);
  font-size: 13px;
  text-align: center;
}

.dir-empty {
  padding: var(--space-xl);
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

.dir-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-top: 0.5px solid var(--border-subtle);
}

.dir-footer .btn {
  display: flex;
  align-items: center;
  gap: 6px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
