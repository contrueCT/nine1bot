<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted, toRef } from 'vue'
import { readChatViewport, saveChatViewport } from '../composables/chat-viewport'
import { isAtBottom, isTypingTarget, nextFollowing, UP_KEYS } from '../composables/scroll-follow'
import { splitPath, tildify, useWorkspacePath } from '../composables/useWorkspacePath'
import { ArrowDown, FolderOpen } from 'lucide-vue-next'
import type { InteractionState } from '../composables/interaction-state'
import type { Message, QuestionRequest, PermissionRequest } from '../api/client'
import MessageItem from './MessageItem.vue'
import AgentMessageGroup from './AgentMessageGroup.vue'
import AgentQuestion from './AgentQuestion.vue'
import PermissionRequestVue from './PermissionRequest.vue'
import DirectoryBrowser from './DirectoryBrowser.vue'

const props = defineProps<{
  messages: Message[]
  isLoading: boolean
  loadError?: string | null
  isStreaming: boolean
  sessionId?: string
  pendingQuestions?: QuestionRequest[]
  pendingPermissions?: PermissionRequest[]
  interactionStates?: Record<string, InteractionState>
  sessionError?: { message: string; dismissable?: boolean } | null
  currentDirectory?: string
  canChangeDirectory?: boolean
}>()

const emit = defineEmits<{
  (e: 'retry'): void
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

// Filter out invalid messages (e.g. corrupted data from backend)
const validMessages = computed(() =>
  props.messages.filter(m => m?.info?.id)
)

// Group consecutive assistant messages into one visual unit
type DisplayGroup =
  | { type: 'user'; message: Message; key: string }
  | { type: 'agent'; messages: Message[]; key: string; isLast: boolean }

const displayGroups = computed<DisplayGroup[]>(() => {
  const groups: DisplayGroup[] = []
  let agentGroup: Extract<DisplayGroup, { type: 'agent' }> | null = null

  for (const message of validMessages.value) {
    if (message.info.role === 'user') {
      agentGroup = null
      groups.push({ type: 'user', message, key: message.info.id })
    } else {
      if (!agentGroup) {
        agentGroup = { type: 'agent', messages: [], key: message.info.id, isLast: false }
        groups.push(agentGroup)
      }
      agentGroup.messages.push(message)
    }
  }

  // Mark last group
  if (groups.length > 0) {
    const last = groups[groups.length - 1]
    if (last.type === 'agent') last.isLast = true
  }

  return groups
})

// Time-based greeting
const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 12) return '上午好'
  if (hour < 18) return '下午好'
  return '晚上好'
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

/* 空态的主角是工作目录：Agent 接下来读写文件、执行命令都落在这里。
   草稿会话的目录是 "."，要先解析成绝对路径才有东西可显示。 */
const workspacePath = useWorkspacePath(toRef(props, 'currentDirectory'))
const workspace = computed(() => {
  const path = workspacePath.value
  if (!path) return null
  const { parent, name } = splitPath(tildify(path))
  return { parent, name, full: path }
})

const messageContent = ref<HTMLDivElement>()
const following = ref(true)
const visibleCount = ref(40)
const visibleGroups = computed(() => displayGroups.value.slice(-visibleCount.value))
const hiddenCount = computed(() => Math.max(0, displayGroups.value.length - visibleCount.value))
const interactionCount = computed(() => (props.pendingQuestions?.length || 0) + (props.pendingPermissions?.length || 0))
let scrollFrame: number | undefined
let initialPosition = true
let programmatic = false
let resizeObserver: ResizeObserver | undefined
/* 算滚动方向用的基线。程序化写入之后也要同步，否则下一次真实滚动会拿旧值算方向。 */
let lastTop = 0
let touchY = 0
let restored = readChatViewport(props.sessionId)
function savePosition(id = props.sessionId) {
  if (!scrollContainer.value || initialPosition) return
  saveChatViewport(id, { top: scrollContainer.value.scrollTop, following: following.value, count: visibleCount.value })
}
function scheduleScrollToBottom() {
  if (scrollFrame !== undefined) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined
    const el = scrollContainer.value
    if (!el || props.isLoading || !props.messages.length) return
    programmatic = true
    if (initialPosition) {
      following.value = restored?.following ?? true
      el.scrollTop = following.value ? el.scrollHeight : restored?.top ?? 0
      initialPosition = false
    } else if (following.value) el.scrollTop = el.scrollHeight
    lastTop = el.scrollTop
    requestAnimationFrame(() => { programmatic = false })
  })
}
function handleScroll() {
  const el = scrollContainer.value
  if (!el) return
  if (initialPosition || programmatic) {
    lastTop = el.scrollTop
    return
  }
  const delta = el.scrollTop - lastTop
  lastTop = el.scrollTop
  following.value = nextFollowing(following.value, delta, isAtBottom(el))
  savePosition()
}
/** 明确的上翻意图（滚轮 / 触摸 / 键盘）：不等滚动落地就松手 */
function releaseFollow() {
  if (!following.value) return
  following.value = false
  savePosition()
}
function handleWheel(event: WheelEvent) {
  if (event.deltaY < 0) releaseFollow()
}
function handleTouchStart(event: TouchEvent) {
  touchY = event.touches[0]?.clientY ?? 0
}
function handleTouchMove(event: TouchEvent) {
  const y = event.touches[0]?.clientY ?? touchY
  // 手指往下拖 = 内容往上走 = 想看前面的内容
  if (y - touchY > 2) releaseFollow()
  touchY = y
}
/* 键位要挂在 window 上：消息流没有 tabindex，焦点通常在 body，事件不会冒到它身上 */
function handleKeydown(event: KeyboardEvent) {
  if (!UP_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return
  if (isTypingTarget(document.activeElement)) return
  const el = scrollContainer.value
  // 不可见（并行会话里的另一路）或根本不能滚，就别抢滚动条
  if (!el || !el.clientHeight || el.scrollHeight <= el.clientHeight) return
  releaseFollow()
}
function jumpToLatest() {
  following.value = true
  restored = undefined
  initialPosition = false
  const el = scrollContainer.value
  if (el) {
    el.scrollTop = el.scrollHeight
    lastTop = el.scrollTop
  }
  savePosition()
}
async function loadEarlier() {
  const el = scrollContainer.value
  if (!el) return
  const height = el.scrollHeight
  const top = el.scrollTop
  following.value = false
  programmatic = true
  visibleCount.value += 40
  await nextTick()
  el.scrollTop = top + el.scrollHeight - height
  lastTop = el.scrollTop
  requestAnimationFrame(() => { programmatic = false; savePosition() })
}
watch(() => props.sessionId, (id, oldId) => {
  savePosition(oldId)
  restored = readChatViewport(id)
  visibleCount.value = restored?.count ?? 40
  following.value = restored?.following ?? true
  initialPosition = true
  scheduleScrollToBottom()
})
watch(() => {
  const last = props.messages[props.messages.length - 1]
  return [props.messages.length, last?.parts?.[last.parts.length - 1]?.text?.length, props.isLoading, interactionCount.value]
}, scheduleScrollToBottom, { flush: 'post', immediate: true })
// Observe layout changes from Markdown, images and expanded tool output.
watch(messageContent, element => {
  resizeObserver?.disconnect()
  if (!element || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(scheduleScrollToBottom)
  resizeObserver.observe(element)
}, { flush: 'post' })
onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => {
  savePosition()
  window.removeEventListener('keydown', handleKeydown)
  resizeObserver?.disconnect()
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
})
</script>

<template>
  <div class="chat-viewport">
  <div
    class="chat-messages custom-scrollbar"
    ref="scrollContainer"
    @scroll.passive="handleScroll"
    @wheel.passive="handleWheel"
    @touchstart.passive="handleTouchStart"
    @touchmove.passive="handleTouchMove"
  >
    <div v-if="loadError" class="history-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-sm btn-ghost" @click="emit('retry')">重试加载</button>
    </div>
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
    <div v-if="validMessages.length === 0 && !isLoading && !sessionError && !loadError && !interactionCount" class="chat-empty">
      <div class="welcome-section">
        <template v-if="canChangeDirectory">
          <p class="welcome-lead">{{ greeting }}，Nine1Bot 会在这个目录里读写文件、执行命令。</p>
          <div class="workspace-hero">
            <div class="workspace-path" :title="workspace?.full">
              <span v-if="workspace?.parent" class="workspace-parent">{{ workspace.parent }}</span>
              <span class="workspace-name">{{ workspace?.name || '还没有选定工作目录' }}</span>
            </div>
            <button class="workspace-change" @click="openDirectoryPicker">
              <FolderOpen :size="15" />
              <span>{{ workspace ? '更换目录' : '选择目录' }}</span>
            </button>
          </div>
        </template>
        <p v-else class="welcome-lead">{{ greeting }}，可以直接提问，也可以让 Nine1Bot 处理当前页面。</p>
      </div>
    </div>

    <!-- Loading State: waiting for first messages -->
    <div v-else-if="isLoading && validMessages.length === 0" class="chat-loading">
      <div class="loading-spinner"></div>
      <span class="chat-loading-text">加载中…</span>
    </div>

    <!-- Messages -->
    <div class="messages-container" ref="messageContent" v-else>
      <button v-if="hiddenCount" class="load-earlier btn btn-ghost btn-sm" @click="loadEarlier">加载更早的消息（还有 {{ hiddenCount }} 组）</button>
      <template v-for="group in visibleGroups" :key="group.key">
        <!-- User message -->
        <MessageItem
          v-if="group.type === 'user'"
          :message="group.message"
          @delete-part="(msgId, partId) => emit('deletePart', msgId, partId)"
          @update-part="(msgId, partId, updates) => emit('updatePart', msgId, partId, updates)"
        />
        <!-- Consecutive agent messages as one group -->
        <div v-else class="agent-message-row">
          <AgentMessageGroup
            :messages="group.messages"
            :isStreaming="isStreaming && group.isLast"
          />
        </div>
      </template>

      <!-- Pending Permission Requests -->
      <div v-if="pendingPermissions?.length" class="pending-requests">
        <PermissionRequestVue
          v-for="request in pendingPermissions"
          :key="request.id"
          :request="request"
          :state="interactionStates?.[request.id]"
          @responded="(response) => emit('permissionResponded', request.id, response)"
        />
      </div>

      <!-- Pending Questions -->
      <div v-if="pendingQuestions?.length" class="pending-requests">
        <AgentQuestion
          v-for="request in pendingQuestions"
          :key="request.id"
          :request="request"
          :state="interactionStates?.[request.id]"
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
  <div v-if="!following || interactionCount" class="scroll-actions">
    <button v-if="interactionCount" class="pending-shortcut" @click="jumpToLatest">{{ interactionCount }} 项需要确认</button>
    <button v-if="!following" class="jump-latest" @click="jumpToLatest"><ArrowDown :size="15" />回到最新</button>
  </div>
  </div>
</template>

<style scoped>
.chat-viewport { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
.scroll-actions { position: absolute; bottom: 16px; right: 24px; display: flex; gap: 8px; z-index: var(--z-sticky); }
.jump-latest, .pending-shortcut { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border-default); padding: 8px 12px; border-radius: var(--radius-full); background: var(--bg-elevated); color: var(--text-primary); box-shadow: var(--shadow-sm); cursor: pointer; font-size: var(--text-13); }
.pending-shortcut { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 35%, transparent); }
.load-earlier { align-self: center; margin-bottom: 16px; }
@media (max-width: 640px) {
  .chat-viewport .messages-container { padding: 16px 4px; }
  .chat-viewport .agent-message-row { padding: 8px 0; }
  .chat-viewport :deep(.message-row) { padding: 12px 0; }
  .scroll-actions { right: 8px; bottom: 8px; }
}

.history-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin: 16px auto;
  padding: 12px 16px;
  max-width: var(--input-max-width);
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  font-size: var(--text-13);
  line-height: 1.6;
}
.history-error > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.history-error > button { flex-shrink: 0; }
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.messages-container {
  max-width: var(--input-max-width);
  margin: 0 auto;
  padding: 24px var(--space-md);
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* === Empty State === */
/* 贴着输入框往下沉：目光从目录名直接落到要输入的地方。
   左边缘和输入框对齐，所以这里不再加横向内边距。 */
.chat-empty {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  padding: 0 0 var(--space-xl);
  overflow: hidden;
}

.welcome-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  max-width: var(--input-max-width);
  width: 100%;
  margin: 0 auto;
}

.welcome-lead {
  color: var(--text-secondary);
  font-size: var(--text-md);
  line-height: 1.6;
  max-width: 34em;
}

.workspace-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-md);
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-default);
}

.workspace-path {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.workspace-parent {
  font-family: var(--font-mono);
  font-size: var(--text-13);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-name {
  font-size: 2.571rem;
  font-weight: 500;
  line-height: 1.15;
  letter-spacing: -0.025em;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.workspace-change {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--text-13);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast);
}

.workspace-change:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

@media (max-width: 640px) {
  .workspace-hero { flex-direction: column; align-items: flex-start; }
  .workspace-name { font-size: var(--text-3xl); }
}

/* === Loading State === */
.chat-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  color: var(--text-muted);
  animation: fade-up 0.3s var(--ease-smooth, ease);
}

.chat-loading-text {
  font-size: var(--text-13);
}

.bottom-spacer {
  height: 48px;
}

.agent-message-row {
  padding: 8px var(--space-lg);
  max-width: var(--input-max-width);
  width: 100%;

}

.pending-requests {
  padding: 0 var(--space-lg);
  margin-bottom: var(--space-md);
}

.session-error-banner {
  max-width: var(--input-max-width);
  margin: var(--space-md) auto;
  padding: var(--space-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
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
  font-size: var(--text-13);
  line-height: 1.65;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.error-actions {
  display: flex;
  gap: var(--space-sm);
  margin-left: 28px;
}

</style>
