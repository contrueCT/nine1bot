<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import type { Message, QuestionRequest, PermissionRequest } from '../api/client'
import MessageItem from './MessageItem.vue'
import AgentQuestion from './AgentQuestion.vue'
import PermissionRequestVue from './PermissionRequest.vue'
import DirectoryBrowser from './DirectoryBrowser.vue'

const props = defineProps<{
  messages: Message[]
  isLoading: boolean
  isStreaming: boolean
  pendingQuestions?: QuestionRequest[]
  pendingPermissions?: PermissionRequest[]
  sessionError?: { message: string; dismissable?: boolean } | null
  currentDirectory?: string
  canChangeDirectory?: boolean
  mode?: 'chat' | 'agent'
}>()

const emit = defineEmits<{
  (e: 'questionAnswered', requestId: string, answers: string[][]): void
  (e: 'questionRejected', requestId: string): void
  (e: 'permissionResponded', requestId: string, response: 'once' | 'always' | 'reject'): void
  (e: 'clearError'): void
  (e: 'openSettings'): void
  (e: 'deletePart', messageId: string, partId: string): void
  (e: 'updatePart', messageId: string, partId: string, updates: { text?: string }): void
  (e: 'changeDirectory', path: string): void
}>()

const scrollContainer = ref<HTMLDivElement>()
const showDirectoryBrowser = ref(false)

// Time-based greeting (Claude.ai style)
const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
})

function openDirectoryPicker() {
  showDirectoryBrowser.value = true
}

function handleDirectorySelect(path: string) {
  showDirectoryBrowser.value = false
  emit('changeDirectory', path)
}

function handleDirectoryCancel() {
  showDirectoryBrowser.value = false
}

// 获取目录显示名称
function getDirectoryName(path: string): string {
  if (!path || path === '~' || path === '.') return ''
  // 处理 Windows 和 Unix 路径
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

watch(() => props.messages, async () => {
  await nextTick()
  scrollToBottom()
}, { deep: true })

watch(() => props.isStreaming, async (streaming) => {
  if (streaming) {
    await nextTick()
    scrollToBottom()
  }
})

function scrollToBottom() {
  if (scrollContainer.value) {
    // Check if user is already near bottom to avoid annoying auto-scroll if they are reading history
    const isNearBottom = scrollContainer.value.scrollHeight - scrollContainer.value.scrollTop - scrollContainer.value.clientHeight < 100

    if (isNearBottom || props.messages.length <= 1) {
       // Always scroll on simple cases
       scrollContainer.value.scrollTo({
        top: scrollContainer.value.scrollHeight,
        behavior: 'smooth'
      })
    }
  }
}
</script>

<template>
  <div class="chat-messages custom-scrollbar" ref="scrollContainer">
    <!-- Session Error Banner -->
    <div v-if="sessionError" class="session-error-banner">
      <div class="error-content">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="error-message">{{ sessionError.message }}</span>
      </div>
      <div class="error-actions">
        <button class="btn btn-sm btn-primary" @click="emit('openSettings')">打开设置</button>
        <button v-if="sessionError.dismissable" class="btn btn-sm btn-ghost" @click="emit('clearError')">关闭</button>
      </div>
    </div>

    <!-- Empty State (Claude.ai style centered greeting) -->
    <div v-if="messages.length === 0 && !isLoading && !sessionError" class="chat-empty">
      <div class="welcome-section">
        <div class="greeting-row">
          <!-- Decorative star icon -->
          <svg class="greeting-icon" width="32" height="32" viewBox="0 0 100 101" fill="none">
            <path d="M50 0L56.2 37.5L87.5 12.5L68.8 46.9L100 50L68.8 53.1L87.5 87.5L56.2 62.5L50 100L43.8 62.5L12.5 87.5L31.2 53.1L0 50L31.2 46.9L12.5 12.5L43.8 37.5L50 0Z" fill="currentColor"/>
          </svg>
          <span class="greeting-text">{{ greeting }}</span>
        </div>

        <!-- Directory Selector (only in code mode, subtle, below greeting) -->
        <div v-if="canChangeDirectory && mode === 'agent'" class="directory-selector-section">
          <button class="directory-btn" @click="openDirectoryPicker">
            <FolderOpen :size="16" />
            <span class="directory-btn-text">
              {{ currentDirectory && getDirectoryName(currentDirectory) ? getDirectoryName(currentDirectory) : '选择工作目录' }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Messages -->
    <div class="messages-container" v-else>
      <MessageItem
        v-for="message in messages"
        :key="message.info.id"
        :message="message"
        @delete-part="(msgId, partId) => emit('deletePart', msgId, partId)"
        @update-part="(msgId, partId, updates) => emit('updatePart', msgId, partId, updates)"
      />

      <!-- Pending Permission Requests -->
      <div v-if="pendingPermissions?.length" class="pending-requests">
        <PermissionRequestVue
          v-for="request in pendingPermissions"
          :key="request.id"
          :request="request"
          @responded="(response) => emit('permissionResponded', request.id, response)"
        />
      </div>

      <!-- Pending Questions -->
      <div v-if="pendingQuestions?.length" class="pending-requests">
        <AgentQuestion
          v-for="request in pendingQuestions"
          :key="request.id"
          :request="request"
          @answered="(id, answers) => emit('questionAnswered', id, answers)"
          @rejected="(id) => emit('questionRejected', id)"
        />
      </div>

      <!-- Streaming Indicator is handled inside the last Agent message usually, or as a typing bubble -->
      <!-- Added extra space at bottom for scrolling past the input box -->
      <div class="bottom-spacer"></div>
    </div>

    <!-- Directory Browser -->
    <DirectoryBrowser
      :visible="showDirectoryBrowser"
      :initial-path="currentDirectory"
      @select="handleDirectorySelect"
      @cancel="handleDirectoryCancel"
    />
  </div>
</template>

<style scoped>
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  scroll-behavior: smooth;
}

.messages-container {
  max-width: var(--input-max-width);
  margin: 0 auto;
  padding: 24px var(--space-md);
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* === Claude.ai Empty State === */
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  animation: fade-in 0.6s ease-out;
  padding: 0 var(--space-md);
}

.welcome-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xl);
  max-width: var(--input-max-width);
  width: 100%;
}

.greeting-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.greeting-icon {
  color: var(--accent);
  flex-shrink: 0;
  opacity: 0.8;
}

.greeting-text {
  font-family: var(--font-serif);
  font-size: 2rem;
  font-weight: 400;
  color: var(--text-primary);
  line-height: 1.3;
  letter-spacing: -0.01em;
}

/* Directory selector */
.directory-selector-section {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.directory-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: transparent;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-full);
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  transition: all var(--transition-normal);
}

.directory-btn:hover {
  background: var(--bg-tertiary);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.directory-btn svg {
  color: inherit;
}

.directory-btn-text {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bottom-spacer {
  height: 48px;
}

.pending-requests {
  padding: 0 var(--space-lg);
  margin-bottom: var(--space-md);
}

.session-error-banner {
  max-width: var(--input-max-width);
  margin: var(--space-md) auto;
  padding: var(--space-md);
  background: var(--error-subtle);
  border: 0.5px solid var(--error);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  width: 100%;
}

.error-content {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  color: var(--error);
}

.error-content svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.error-message {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--text-primary);
}

.error-actions {
  display: flex;
  gap: var(--space-sm);
  margin-left: 28px;
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 0.75rem;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
