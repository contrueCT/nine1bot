<script setup lang="ts">
import { ref } from 'vue'
import { Search, X, File, Folder } from 'lucide-vue-next'
import type { FileSearchResult } from '../api/client'

defineProps<{
  results: FileSearchResult[]
  isSearching: boolean
  error: string | null
}>()

const emit = defineEmits<{
  search: [pattern: string]
  clear: []
  selectFile: [path: string]
}>()

const searchQuery = ref('')
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function handleInput() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    if (searchQuery.value.trim()) {
      emit('search', searchQuery.value.trim())
    } else {
      emit('clear')
    }
  }, 300)
}

function clearSearch() {
  searchQuery.value = ''
  emit('clear')
}

function selectResult(result: FileSearchResult) {
  if (result.type === 'file') {
    emit('selectFile', result.path)
  }
}
</script>

<template>
  <div class="file-search">
    <div class="search-input-wrapper">
      <Search :size="16" class="search-icon" />
      <input
        v-model="searchQuery"
        type="text"
        class="search-input"
        placeholder="搜索文件..."
        @input="handleInput"
      />
      <button v-if="searchQuery" class="clear-btn" @click="clearSearch">
        <X :size="14" />
      </button>
    </div>

    <div v-if="isSearching" class="search-loading">
      <div class="loading-spinner-sm"></div>
      <span>搜索中...</span>
    </div>

    <div v-else-if="error" class="search-error">
      {{ error }}
    </div>

    <div v-else-if="results.length > 0" class="search-results custom-scrollbar">
      <div
        v-for="result in results"
        :key="result.path"
        class="search-result-item"
        :class="{ directory: result.type === 'directory' }"
        @click="selectResult(result)"
      >
        <Folder v-if="result.type === 'directory'" :size="14" class="result-icon" />
        <File v-else :size="14" class="result-icon" />
        <div class="result-info">
          <span class="result-name">{{ result.name }}</span>
          <span class="result-path">{{ result.path }}</span>
        </div>
      </div>
    </div>

    <div v-else-if="searchQuery && !isSearching" class="search-empty">
      未找到匹配的文件
    </div>
  </div>
</template>

<style scoped>
.file-search {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.search-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: var(--space-sm) var(--space-sm) var(--space-sm) 34px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
}

.clear-btn {
  position: absolute;
  right: 8px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.clear-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.search-loading,
.search-error,
.search-empty {
  padding: var(--space-md);
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.search-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
}

.search-error {
  color: var(--error, #ef4444);
}

.loading-spinner-sm {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.search-results {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}

.search-result-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.search-result-item:hover {
  background: var(--bg-tertiary);
}

.search-result-item.directory {
  cursor: default;
  opacity: 0.7;
}

.result-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.search-result-item:not(.directory) .result-icon {
  color: var(--accent);
}

.result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.result-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.result-path {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
