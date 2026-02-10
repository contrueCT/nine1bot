<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Search, X, MessageSquare, Clock } from 'lucide-vue-next'
import type { Session } from '../api/client'

const props = defineProps<{
  recentSessions?: Session[]
}>()

const emit = defineEmits<{
  close: []
  select: [sessionId: string]
}>()

const query = ref('')
const searchResults = ref<Session[]>([])
const isSearching = ref(false)
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement>()

let searchTimeout: ReturnType<typeof setTimeout> | null = null

// Display list: recent sessions when no query, search results when query exists
const displayList = computed(() => {
  if (query.value.trim()) {
    return searchResults.value
  }
  return props.recentSessions || []
})

const displayLabel = computed(() => {
  if (query.value.trim()) {
    return isSearching.value ? 'Searching...' : `${searchResults.value.length} results`
  }
  return 'Recent'
})

// Debounced search
watch(query, (newQuery) => {
  if (searchTimeout) clearTimeout(searchTimeout)

  if (!newQuery.trim()) {
    searchResults.value = []
    selectedIndex.value = 0
    return
  }

  isSearching.value = true
  searchTimeout = setTimeout(async () => {
    try {
      const params = new URLSearchParams({
        search: newQuery.trim(),
        roots: 'true',
        limit: '20'
      })
      const res = await fetch(`/session?${params}`)
      const data = await res.json()
      searchResults.value = Array.isArray(data) ? data : (data.data || [])
    } catch (e) {
      console.error('Search failed:', e)
      searchResults.value = []
    } finally {
      isSearching.value = false
      selectedIndex.value = 0
    }
  }, 300)
})

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, displayList.value.length - 1)
    return
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
    return
  }

  if (e.key === 'Enter') {
    e.preventDefault()
    const session = displayList.value[selectedIndex.value]
    if (session) {
      emit('select', session.id)
    }
    return
  }
}

function selectSession(session: Session) {
  emit('select', session.id)
}

function handleOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function getSessionTitle(session: Session): string {
  return session.title || `会话 ${session.id.slice(0, 6)}`
}

// Highlight matching text
function highlightMatch(text: string, search: string): string {
  if (!search.trim()) return text
  const regex = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return text.replace(regex, '<mark>$1</mark>')
}

onMounted(async () => {
  await nextTick()
  inputRef.value?.focus()
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (searchTimeout) clearTimeout(searchTimeout)
})
</script>

<template>
  <div class="search-overlay" @click="handleOverlayClick">
    <div class="search-modal">
      <!-- Search Input -->
      <div class="search-input-wrapper">
        <Search :size="18" class="search-input-icon" />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          class="search-input"
          placeholder="Search sessions..."
          autocomplete="off"
        />
        <button class="search-close-btn" @click="emit('close')">
          <X :size="16" />
        </button>
      </div>

      <!-- Results -->
      <div class="search-results">
        <div class="search-results-label">{{ displayLabel }}</div>
        <div class="search-results-list">
          <button
            v-for="(session, index) in displayList"
            :key="session.id"
            class="search-result-item"
            :class="{ selected: index === selectedIndex }"
            @click="selectSession(session)"
            @mouseenter="selectedIndex = index"
          >
            <MessageSquare :size="14" class="result-icon" />
            <span
              class="result-title"
              v-html="query.trim() ? highlightMatch(getSessionTitle(session), query) : getSessionTitle(session)"
            ></span>
            <span class="result-time">
              <Clock :size="12" />
              {{ formatTime(session.time.updated) }}
            </span>
          </button>

          <div v-if="displayList.length === 0 && !isSearching" class="search-empty">
            {{ query.trim() ? 'No sessions found' : 'No recent sessions' }}
          </div>
        </div>
      </div>

      <!-- Footer hint -->
      <div class="search-footer">
        <span class="search-hint">
          <kbd>↑</kbd><kbd>↓</kbd> navigate
          <kbd>↵</kbd> select
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  animation: overlayIn 0.15s ease-out;
}

@keyframes overlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.search-modal {
  width: 100%;
  max-width: 560px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: modalIn 0.2s ease-out;
}

@keyframes modalIn {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Search Input */
.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 0.5px solid var(--border-subtle);
}

.search-input-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 400;
  outline: none;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-close-btn {
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
}

.search-close-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Results */
.search-results {
  max-height: 400px;
  overflow-y: auto;
}

.search-results-label {
  padding: 10px 16px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.search-results-list {
  padding: 4px 8px;
}

.search-result-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.search-result-item:hover,
.search-result-item.selected {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.result-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.result-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-title :deep(mark) {
  background: var(--accent-subtle);
  color: var(--accent);
  border-radius: 2px;
  padding: 0 2px;
}

.result-time {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.search-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
}

/* Footer */
.search-footer {
  padding: 8px 16px;
  border-top: 0.5px solid var(--border-subtle);
  display: flex;
  justify-content: center;
}

.search-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.search-hint kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 4px;
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border-default);
  border-radius: 3px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  color: var(--text-secondary);
}
</style>
