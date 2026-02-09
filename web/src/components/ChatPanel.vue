<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { MessagesSquare, FolderOpen } from 'lucide-vue-next'
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

// 打开目录浏览器弹窗
function openDirectoryBrowser() {
  showDirectoryBrowser.value = true
}

// 处理目录选择
function handleDirectorySelect(path: string) {
  showDirectoryBrowser.value = false
  emit('changeDirectory', path)
}

// 取消目录选择
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

    <!-- Empty State -->
    <div v-if="messages.length === 0 && !isLoading && !sessionError" class="chat-empty">
      <div class="empty-state-icon glass-icon">
        <MessagesSquare :size="48" stroke-width="1.5" />
      </div>
      <p class="empty-state-title">Hello, I'm Nine1Bot</p>
      <p class="empty-state-description">How can I help you today?</p>

      <!-- Directory Selector Button (shown only for draft/new sessions) -->
      <div v-if="canChangeDirectory" class="directory-selector-section">
        <button class="directory-btn" @click="openDirectoryBrowser">
          <FolderOpen :size="20" />
          <span class="directory-btn-text">
            {{ currentDirectory && getDirectoryName(currentDirectory) ? `工作目录: ${getDirectoryName(currentDirectory)}` : '选择工作目录' }}
          </span>
        </button>
        <p class="directory-hint">选择一个工作目录来开始你的项目</p>
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

    <!-- Directory Browser Modal -->
    <DirectoryBrowser
      :visible="showDirectoryBrowser"
      :initial-path="currentDirectory || '~'"
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
  padding: 24px 0;
  display: flex;
  flex-direction: column;
}

.chat-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  animation: fade-in 0.5s var(--ease-smooth);
}

.glass-icon {
  width: 80px;
  height: 80px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-xl);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  color: var(--accent);
}

.empty-state-title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.empty-state-description {
  color: var(--text-muted);
  font-size: 15px;
}

.directory-selector-section {
  margin-top: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.directory-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 32px;
  background: var(--bg-secondary);
  border: 1.5px dashed var(--border-default);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  font-size: 16px;
  font-weight: var(--font-weight-normal);
  cursor: pointer;
  transition: all var(--transition-normal);
}

.directory-btn:hover {
  background: var(--bg-tertiary);
  border-color: var(--accent);
  color: var(--accent);
}

.directory-btn:hover svg {
  color: var(--accent);
}

.directory-btn svg {
  color: var(--text-muted);
  transition: color 0.2s ease;
}

.directory-btn-text {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-hint {
  color: var(--text-muted);
  font-size: 14px;
}

.bottom-spacer {
  height: 48px;
}

.pending-requests {
  padding: 0 var(--space-lg);
  margin-bottom: var(--space-md);
}

.session-error-banner {
  margin: var(--space-md) var(--space-lg);
  padding: var(--space-md);
  background: var(--error-subtle);
  border: 0.5px solid var(--error);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
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
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
