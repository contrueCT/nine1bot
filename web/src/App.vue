<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useSession } from './composables/useSession'
import { useFiles } from './composables/useFiles'
import { useSettings } from './composables/useSettings'
import Header from './components/Header.vue'
import Sidebar from './components/Sidebar.vue'
import ChatPanel from './components/ChatPanel.vue'
import InputBox from './components/InputBox.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import FileViewer from './components/FileViewer.vue'
import TodoList from './components/TodoList.vue'
import RightPanel from './components/RightPanel.vue'
import { useAgentTerminal } from './composables/useAgentTerminal'
import { useFilePreview } from './composables/useFilePreview'

import { MAX_PARALLEL_AGENTS } from './composables/useParallelSessions'

const {
  sessions,
  currentSession,
  messages,
  isLoading,
  isStreaming,
  isDraftSession,
  currentDirectory,
  pendingQuestions,
  pendingPermissions,
  sessionError,
  retryInfo,
  loadSessions,
  createSession,
  selectSession,
  sendMessage,
  abortSession,
  abortCurrentSession,
  subscribeToEvents,
  unsubscribe,
  loadPendingRequests,
  answerQuestion,
  rejectQuestion,
  respondPermission,
  clearSessionError,
  deleteSession,
  renameSession,
  // 工作目录管理
  changeDirectory,
  canChangeDirectory,
  // 新增功能
  deleteMessagePart,
  updateMessagePart,
  summarizeSession,
  isSummarizing,
  todoItems,
  loadTodoItems,
  // 事件处理器注册
  registerEventHandler,
  // 并行会话
  syncSessionStatus,
  runningCount,
  isSessionRunning,
  // 会话通知
  sessionNotifications,
  dismissNotification
} = useSession()

// Agent 终端
const { handleSSEEvent: handleTerminalEvent } = useAgentTerminal()

// 文件预览
const { handleSSEEvent: handlePreviewEvent } = useFilePreview()

const {
  files,
  isLoading: filesLoading,
  setDirectory: setFilesDirectory,
  loadFiles,
  toggleDirectory,
  // 文件查看
  fileContent,
  isLoadingContent,
  contentError,
  loadFileContent,
  clearFileContent,
  // 文件搜索 (预留功能)
  // searchResults,
  // isSearching,
  // searchError,
  // searchFiles,
  // clearSearch
} = useFiles()

const { showSettings, openSettings, closeSettings, currentProvider, currentModel } = useSettings()

// 文件查看器状态
const showFileViewer = ref(false)

// 待办事项面板状态
const showTodoList = ref(false)

const sidebarCollapsed = ref(false)
const sidebarTab = ref<'sessions' | 'files'>('sessions')

// 保存 watch 停止函数以便在 unmount 时清理
let stopSessionWatch: (() => void) | null = null
let unregisterTerminalHandler: (() => void) | null = null
let unregisterPreviewHandler: (() => void) | null = null

onMounted(async () => {
  // 先注册事件处理器，确保在 SSE 连接建立时能接收到 server.connected 事件
  unregisterTerminalHandler = registerEventHandler(handleTerminalEvent)
  unregisterPreviewHandler = registerEventHandler(handlePreviewEvent)

  // 然后建立 SSE 连接
  subscribeToEvents()

  // 设置会话切换的 watch
  stopSessionWatch = watch(currentSession, async () => {
    if (currentSession.value) {
      await loadPendingRequests()
    }
  })

  // Sync parallel session status from backend (for page refresh recovery)
  await syncSessionStatus()

  // 不传 directory 参数以加载所有会话
  await loadSessions()
  await loadFiles('.')

  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0])
  } else {
    // 进入草稿模式，不实际创建会话
    createSession('.')
  }

  // 加载待处理的问题和权限请求
  await loadPendingRequests()
})

onUnmounted(() => {
  unsubscribe()
  // 清理 watch
  if (stopSessionWatch) {
    stopSessionWatch()
    stopSessionWatch = null
  }
  // 清理终端事件处理器
  if (unregisterTerminalHandler) {
    unregisterTerminalHandler()
    unregisterTerminalHandler = null
  }
  // 清理文件预览事件处理器
  if (unregisterPreviewHandler) {
    unregisterPreviewHandler()
    unregisterPreviewHandler = null
  }
})

// 监听当前目录变化，更新文件树工作目录
watch(currentDirectory, async (newDir) => {
  setFilesDirectory(newDir || undefined)
  await loadFiles('.')
})

async function handleSend(content: string, files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode?: boolean) {
  // sendMessage 会自动处理草稿模式，在发送前创建会话
  const model = currentProvider.value && currentModel.value
    ? { providerID: currentProvider.value, modelID: currentModel.value }
    : undefined

  // 如果是规划模式，在消息前添加指令
  let finalContent = content
  if (planMode) {
    finalContent = `[规划模式] 请先制定详细的执行计划，列出所有待办事项，等待我确认后再执行。\n\n${content}`
  }

  await sendMessage(finalContent, model, files)
}

function handleNewSession() {
  createSession(currentDirectory.value || '.')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// 处理消息部分删除
async function handleDeletePart(messageId: string, partId: string) {
  try {
    await deleteMessagePart(messageId, partId)
  } catch (error) {
    console.error('Failed to delete message part:', error)
  }
}

// 处理消息部分更新
async function handleUpdatePart(messageId: string, partId: string, updates: { text?: string }) {
  try {
    await updateMessagePart(messageId, partId, updates)
  } catch (error) {
    console.error('Failed to update message part:', error)
  }
}

// 处理会话压缩
async function handleSummarize() {
  try {
    await summarizeSession()
  } catch (error) {
    console.error('Failed to summarize session:', error)
  }
}

// 切换待办事项面板
function toggleTodoList() {
  showTodoList.value = !showTodoList.value
  if (showTodoList.value) {
    loadTodoItems()
  }
}

// 处理文件点击查看
async function handleFileClick(path: string) {
  showFileViewer.value = true
  await loadFileContent(path)
}

// 关闭文件查看器
function closeFileViewer() {
  showFileViewer.value = false
  clearFileContent()
}
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <Sidebar
      :collapsed="sidebarCollapsed"
      :sessions="sessions"
      :currentSession="currentSession"
      :isDraftSession="isDraftSession"
      :files="files"
      :filesLoading="filesLoading"
      :activeTab="sidebarTab"
      :currentDirectory="currentDirectory"
      :canChangeDirectory="canChangeDirectory()"
      :isSessionRunning="isSessionRunning"
      :runningCount="runningCount"
      :maxParallelAgents="MAX_PARALLEL_AGENTS"
      @toggle-collapse="toggleSidebar"
      @select-session="selectSession"
      @new-session="handleNewSession"
      @toggle-directory="toggleDirectory"
      @change-tab="(tab) => sidebarTab = tab"
      @delete-session="deleteSession"
      @rename-session="renameSession"
      @file-click="handleFileClick"
      @abort-session="abortSession"
      @change-directory="changeDirectory"
    />

    <!-- Main Content -->
    <div class="main-content">
      <!-- Header -->
      <Header
        :session="currentSession"
        :isStreaming="isStreaming"
        :sidebarCollapsed="sidebarCollapsed"
        :isSummarizing="isSummarizing"
        :retryInfo="retryInfo"
        @toggle-sidebar="toggleSidebar"
        @abort="abortCurrentSession"
        @open-settings="openSettings"
        @summarize="handleSummarize"
        @toggle-todo="toggleTodoList"
      />

      <!-- Chat Area -->
      <div class="chat-panel">
        <ChatPanel
          :messages="messages"
          :isLoading="isLoading"
          :isStreaming="isStreaming"
          :pendingQuestions="pendingQuestions"
          :pendingPermissions="pendingPermissions"
          :sessionError="sessionError"
          :currentDirectory="currentDirectory"
          :canChangeDirectory="canChangeDirectory()"
          @question-answered="(id, answers) => answerQuestion(id, answers)"
          @question-rejected="rejectQuestion"
          @permission-responded="respondPermission"
          @clear-error="clearSessionError"
          @open-settings="openSettings"
          @delete-part="handleDeletePart"
          @update-part="handleUpdatePart"
          @change-directory="changeDirectory"
        />
        <InputBox
          :disabled="isLoading"
          :isStreaming="isStreaming"
          @send="handleSend"
          @abort="abortCurrentSession"
        />

        <!-- Todo List Panel -->
        <div v-if="showTodoList" class="todo-panel-container">
          <TodoList
            :items="todoItems"
            :isLoading="isLoading"
            @close="showTodoList = false"
            @refresh="loadTodoItems"
          />
        </div>
      </div>
    </div>

    <!-- Right Panel (Terminal + Preview) -->
    <RightPanel />

    <!-- Settings Modal -->
    <SettingsPanel
      v-if="showSettings"
      @close="closeSettings"
    />

    <!-- File Viewer Modal -->
    <FileViewer
      v-if="showFileViewer"
      :file="fileContent"
      :isLoading="isLoadingContent"
      :error="contentError"
      @close="closeFileViewer"
    />

    <!-- Session Notifications Toast -->
    <div class="notifications-container" v-if="sessionNotifications.length > 0">
      <div
        v-for="notification in sessionNotifications"
        :key="notification.id"
        class="notification-toast"
        :class="notification.type"
      >
        <div class="notification-icon">
          <svg v-if="notification.type === 'success'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div class="notification-content">
          <span class="notification-title">{{ notification.sessionTitle }}</span>
          <span class="notification-message">{{ notification.message }}</span>
        </div>
        <button class="notification-close" @click="dismissNotification(notification.id)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Layout uses global styles from style.css */

.todo-panel-container {
  position: absolute;
  top: calc(var(--header-height) + var(--space-md));
  right: var(--space-md);
  z-index: 100;
  width: 360px;
  max-width: calc(100% - var(--space-md) * 2);
}

.chat-panel {
  position: relative;
}

/* Session Notifications */
.notifications-container {
  position: fixed;
  bottom: var(--space-lg);
  right: var(--space-lg);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  max-width: 320px;
}

.notification-toast {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  animation: slideIn 0.3s ease-out;
}

.notification-toast.success {
  border-color: var(--color-success);
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), var(--color-bg-elevated));
}

.notification-toast.info {
  border-color: var(--color-accent);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), var(--color-bg-elevated));
}

.notification-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex-shrink: 0;
}

.notification-toast.success .notification-icon {
  background: rgba(34, 197, 94, 0.2);
  color: var(--color-success);
}

.notification-toast.info .notification-icon {
  background: rgba(99, 102, 241, 0.2);
  color: var(--color-accent);
}

.notification-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.notification-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notification-message {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.notification-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.notification-close:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
</style>
