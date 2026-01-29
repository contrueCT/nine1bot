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

const {
  sessions,
  currentSession,
  messages,
  isLoading,
  isStreaming,
  currentDirectory,
  pendingQuestions,
  pendingPermissions,
  sessionError,
  loadSessions,
  createSession,
  selectSession,
  sendMessage,
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
  // 新增功能
  deleteMessagePart,
  updateMessagePart,
  summarizeSession,
  isSummarizing,
  todoItems,
  loadTodoItems
} = useSession()

const {
  files,
  isLoading: filesLoading,
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

onMounted(async () => {
  subscribeToEvents()

  // 设置会话切换的 watch
  stopSessionWatch = watch(currentSession, async () => {
    if (currentSession.value) {
      await loadPendingRequests()
    }
  })

  // 不传 directory 参数以加载所有会话
  await loadSessions()
  await loadFiles('.')

  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0])
  } else {
    // 创建新会话时使用当前工作目录
    await createSession('.')
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
})

// 注意：currentDirectory 可能是绝对路径，但文件 API 只接受相对路径
// 所以这里不再监听 currentDirectory 的变化来重新加载文件
// 文件浏览始终显示项目根目录的内容

async function handleSend(content: string) {
  if (!currentSession.value) {
    await createSession(currentDirectory.value || '.')
  }
  // 如果选择了模型，传递给 sendMessage
  const model = currentProvider.value && currentModel.value
    ? { providerID: currentProvider.value, modelID: currentModel.value }
    : undefined
  await sendMessage(content, model)
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
      :files="files"
      :filesLoading="filesLoading"
      :activeTab="sidebarTab"
      @toggle-collapse="toggleSidebar"
      @select-session="selectSession"
      @new-session="handleNewSession"
      @toggle-directory="toggleDirectory"
      @change-tab="(tab) => sidebarTab = tab"
      @delete-session="deleteSession"
      @rename-session="renameSession"
      @file-click="handleFileClick"
    />

    <!-- Main Content -->
    <div class="main-content">
      <!-- Header -->
      <Header
        :session="currentSession"
        :directory="currentDirectory"
        :isStreaming="isStreaming"
        :sidebarCollapsed="sidebarCollapsed"
        :isSummarizing="isSummarizing"
        @toggle-sidebar="toggleSidebar"
        @new-session="handleNewSession"
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
          @question-answered="(id, answers) => answerQuestion(id, answers)"
          @question-rejected="rejectQuestion"
          @permission-responded="respondPermission"
          @clear-error="clearSessionError"
          @open-settings="openSettings"
          @delete-part="handleDeletePart"
          @update-part="handleUpdatePart"
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
</style>
