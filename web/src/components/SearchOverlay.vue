<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick, toRef } from 'vue'
import { Search, X, MessageSquare, Clock } from 'lucide-vue-next'
import type { Session, SessionSearchResult } from '../api/client'
import { highlightMatch } from '../utils/highlight'
import { useModalFocus } from '../composables/useModalFocus'
import { useSessionSearch } from '../composables/useSessionSearch'

const props = defineProps<{ recentSessions?: Session[]; directory: string }>()
const emit = defineEmits<{ close: []; select: [result: SessionSearchResult] }>()
const query = ref('')
const selectedIndex = ref(0)
const modalRef = ref<HTMLElement>()
const inputRef = ref<HTMLInputElement>()
const resultsRef = ref<HTMLElement>()
const { results, loading, error, hasMore, retry } = useSessionSearch(query, toRef(props, 'directory'))
useModalFocus(modalRef, () => emit('close'))
const displayList = computed<SessionSearchResult[]>(() => query.value.trim() ? results.value :
  (props.recentSessions || []).map(session => ({ session, snippet: '' })))
const displayLabel = computed(() => !query.value.trim() ? '最近会话（所有项目）' :
  loading.value ? '正在搜索当前项目…' : error.value ? '搜索未完成' :
  `${displayList.value.length} 个会话${hasMore.value ? '（仅显示前 50 个，请缩小关键词范围）' : ''}`)
watch(displayList, () => { selectedIndex.value = 0 })
function handleKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return
  // Keep close/retry buttons' native keyboard activation intact.
  if (e.target !== inputRef.value) return
  e.preventDefault()
  if (e.key === 'Enter') {
    const result = displayList.value[selectedIndex.value]
    if (result) emit('select', result)
    return
  }
  selectedIndex.value = Math.max(0, Math.min(selectedIndex.value + (e.key === 'ArrowDown' ? 1 : -1), displayList.value.length - 1))
  void nextTick(() => resultsRef.value?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }))
}
function title(session: Session) { return session.title || `会话 ${session.id.slice(0, 6)}` }
function formatTime(timestamp: number) { return new Date(timestamp).toLocaleDateString() }
onMounted(async () => { await nextTick(); inputRef.value?.focus() })
</script>

<template>
  <div class="search-overlay" @click.self="emit('close')">
    <div ref="modalRef" class="search-modal" role="dialog" aria-modal="true" aria-label="搜索会话" tabindex="-1" @keydown="handleKeydown">
      <div class="search-input-wrapper">
        <Search :size="18" class="search-input-icon" />
        <input ref="inputRef" v-model="query" type="text" class="search-input"
          placeholder="搜索当前项目的标题和消息…" aria-label="搜索当前项目的标题和消息"
          role="combobox" aria-autocomplete="list" aria-controls="session-search-results" :aria-expanded="displayList.length > 0"
          :aria-activedescendant="displayList.length ? `session-search-result-${selectedIndex}` : undefined" autocomplete="off" maxlength="500" />
        <button class="search-close-btn" aria-label="关闭搜索" @click="emit('close')"><X :size="16" /></button>
      </div>
      <p class="search-scope">搜索当前项目主会话历史的标题和用户、助手正文；不含自动化会话、子会话、工具输出、附件和思考过程</p>
      <div class="search-results" :aria-busy="loading">
        <div class="search-results-label" role="status" aria-live="polite">{{ displayLabel }}</div>
        <div v-if="error" class="search-empty" role="alert">{{ error }} <button @click="retry">重试</button></div>
        <div id="session-search-results" ref="resultsRef" class="search-results-list" role="listbox" aria-label="搜索结果">
          <button v-for="(result, index) in displayList" :id="`session-search-result-${index}`"
            :key="`${result.session.id}:${result.messageID || 'title'}`" class="search-result-item" role="option"
            :aria-selected="index === selectedIndex" :class="{ selected: index === selectedIndex }"
            @click="emit('select', result)" @mouseenter="selectedIndex = index" @focus="selectedIndex = index">
            <MessageSquare :size="14" class="result-icon" />
            <span class="result-title">
              <span v-html="highlightMatch(title(result.session), query.trim())"></span>
              <span v-if="result.snippet" class="result-snippet" v-html="highlightMatch(result.snippet, query.trim())"></span>
              <span v-if="query.trim()" class="result-kind">{{ result.messageID ? '消息匹配 · 点击定位' : '标题匹配' }}</span>
            </span>
            <span class="result-time"><Clock :size="12" />{{ formatTime(result.session.time.updated) }}</span>
          </button>
        </div>
        <div v-if="!loading && !error && !displayList.length" class="search-empty">
          {{ query.trim() ? '当前项目中没有匹配的标题或消息' : '暂无最近会话' }}
        </div>
      </div>
      <div class="search-footer"><span class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> 切换 <kbd>↵</kbd> 选择 <kbd>esc</kbd> 关闭</span></div>
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

.search-scope { margin: 0; padding: 8px 16px; color: var(--text-muted); font-size: var(--text-xs); }
.result-snippet, .result-kind { display: block; white-space: normal; overflow-wrap: anywhere; margin-top: 4px; font-size: var(--text-xs); color: var(--text-muted); }
.result-snippet { max-height: 4.5em; overflow: hidden; }
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
