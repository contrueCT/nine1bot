<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Search, X, MessageSquare, Clock } from 'lucide-vue-next'
import type { Session } from '../api/client'
import { highlightMatch } from '../utils/highlight'

const props = defineProps<{
  recentSessions?: Session[]
}>()

const emit = defineEmits<{
  close: []
  select: [sessionId: string]
}>()

const query = ref('')
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement>()
const resultsRef = ref<HTMLElement>()

// 键盘导航后确保选中项滚入可视区域
function scrollSelectedIntoView() {
  void nextTick(() => {
    resultsRef.value
      ?.querySelector('.search-result-item.selected')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

// Display list: recent sessions when no query, search results when query exists
const displayList = computed(() => {
  const source = props.recentSessions || []
  const term = query.value.trim().toLowerCase()
  if (!term) {
    return source
  }
  return source.filter((session) => getSessionTitle(session).toLowerCase().includes(term))
})

const displayLabel = computed(() => {
  return query.value.trim() ? `${displayList.value.length} 个结果` : '最近会话'
})

watch([query, () => props.recentSessions], () => {
  selectedIndex.value = 0
})

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, displayList.value.length - 1)
    scrollSelectedIntoView()
    return
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
    scrollSelectedIntoView()
    return
  }

  if (e.key === 'Enter') {
    if (e.isComposing || e.keyCode === 229) return
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

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}

function getSessionTitle(session: Session): string {
  return session.title || `会话 ${session.id.slice(0, 6)}`
}

onMounted(async () => {
  await nextTick()
  inputRef.value?.focus()
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
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
          placeholder="搜索会话..."
          autocomplete="off"
        />
        <button class="search-close-btn" @click="emit('close')">
          <X :size="16" />
        </button>
      </div>

      <!-- Results -->
      <div class="search-results">
        <div class="search-results-label">{{ displayLabel }}</div>
        <div class="search-results-list" ref="resultsRef">
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
              v-html="highlightMatch(getSessionTitle(session), query)"
            ></span>
            <span class="result-time">
              <Clock :size="12" />
              {{ formatTime(session.time.updated) }}
            </span>
          </button>

          <div v-if="displayList.length === 0" class="search-empty">
            {{ query.trim() ? '未找到匹配的会话' : '暂无最近会话' }}
          </div>
        </div>
      </div>

      <!-- Footer hint -->
      <div class="search-footer">
        <span class="search-hint">
          <kbd>↑</kbd><kbd>↓</kbd> 切换
          <kbd>↵</kbd> 选择
          <kbd>esc</kbd> 关闭
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(5px);
  animation: overlayIn 0.15s ease-out;
}

@keyframes overlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.search-modal {
  width: 100%;
  max-width: 600px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
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
  border-bottom: 1px solid var(--border-subtle);
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
  font-size: var(--text-md);
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
  overscroll-behavior: contain;
}

.search-results-label {
  position: sticky;
  top: 0;
  z-index: var(--z-base);
  padding: 10px 16px 4px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-subtle);
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
  font-size: var(--text-base);
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), transform var(--transition-fast);
  position: relative;
}

.search-result-item:hover,
.search-result-item.selected {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  transform: translateX(1px);
}

.search-result-item.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 999px;
  background: var(--accent);
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
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.search-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-base);
}

/* Footer */
.search-footer {
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  justify-content: center;
  background: var(--bg-elevated);
}

.search-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
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
  border: 1px solid var(--border-default);
  border-radius: 3px;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .search-overlay {
    padding: 9vh 10px 0;
  }

  .search-modal {
    max-width: 100%;
    border-radius: var(--radius-lg);
  }

  .search-results {
    max-height: 62vh;
  }

  .result-time {
    display: none;
  }
}
</style>
