<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSession } from './composables/useSession'
import { useFiles } from './composables/useFiles'
import { useSettings } from './composables/useSettings'
import { useAppMode } from './composables/useAppMode'
import { useSessionMode } from './composables/useSessionMode'
import { useProjects } from './composables/useProjects'
import { useGlobalRecentSessions } from './composables/useGlobalRecentSessions'
import { api, type GlobalSSEEventEnvelope, type Session } from './api/client'
import Header from './components/Header.vue'
import Sidebar from './components/Sidebar.vue'
import ChatPanel from './components/ChatPanel.vue'
import InputBox from './components/InputBox.vue'
import PromptCategories from './components/PromptCategories.vue'
import SearchOverlay from './components/SearchOverlay.vue'
import ProjectsPage from './components/ProjectsPage.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import FileViewer from './components/FileViewer.vue'
import TodoList from './components/TodoList.vue'
import PlanPanel from './components/PlanPanel.vue'
import McpProjectPanel from './components/McpProjectPanel.vue'
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
  dismissNotification,
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
} = useFiles()

const { showSettings, openSettings, closeSettings, activeTab: settingsTab, currentProvider, currentModel, providers, selectModel: settingsSelectModel, loadProviders, loadConfig } = useSettings()

// App mode (chat / agent)
const { mode: appMode, setMode: setAppMode } = useAppMode()

// Session ↔ mode mapping
const { setMode: setSessionMode } = useSessionMode()

// Projects
const {
  projects,
  currentProject,
  loadProjects,
  selectProject,
  clearProject,
  openDirectory,
  updateProject,
  forgetProject,
  refreshProject,
  getProject,
} = useProjects()

const {
  recentSessions: globalRecentSessions,
  loadGlobalRecentSessions,
  refreshGlobalRecentSessions,
  startGlobalRecentPolling,
  stopGlobalRecentPolling,
} = useGlobalRecentSessions()

// 文件查看器状态
const showFileViewer = ref(false)

// 待办事项面板状态
const showTodoList = ref(false)

// Plan面板状态
const showPlanPanel = ref(false)

// MCP project panel state
const showMcpPanel = ref(false)

// Search overlay
const showSearch = ref(false)

// Projects page
const showProjectsPage = ref(false)

const sidebarCollapsed = ref(false)
const projectContextRevision = ref(0)

const sidebarSessions = computed(() => {
  if (appMode.value !== 'agent') {
    return sessions.value
  }

  const merged = new Map<string, Session>()
  for (const session of globalRecentSessions.value) {
    merged.set(session.id, session)
  }
  for (const session of sessions.value) {
    if (!merged.has(session.id)) {
      merged.set(session.id, session)
    }
  }
  if (currentSession.value && !merged.has(currentSession.value.id)) {
    merged.set(currentSession.value.id, currentSession.value)
  }
  return Array.from(merged.values()).sort((a, b) => b.time.updated - a.time.updated)
})

const searchRecentSessions = computed(() => {
  if (appMode.value === 'agent') {
    return sidebarSessions.value.slice(0, 300)
  }
  return sessions.value.slice(0, 300)
})

// Empty state detection for centered layout
const isEmptyState = computed(() =>
  messages.value.length === 0 && !isLoading.value && !showProjectsPage.value
)

// Handle model selection from InputBox
async function handleSelectModel(providerId: string, modelId: string) {
  await settingsSelectModel(providerId, modelId)
}

// 保存 watch 停止函数以便在 unmount 时清理
let stopSessionWatch: (() => void) | null = null
let unregisterTerminalHandler: (() => void) | null = null
let unregisterPreviewHandler: (() => void) | null = null
let globalEventSource: EventSource | null = null
let projectsRefreshTimer: ReturnType<typeof setTimeout> | null = null

async function refreshGlobalRecentsIfAgent() {
  if (appMode.value !== 'agent') return
  await refreshGlobalRecentSessions().catch((error) => {
    console.error('Failed to refresh global recent sessions:', error)
  })
}

function scheduleProjectsRefresh() {
  if (projectsRefreshTimer) return
  projectsRefreshTimer = setTimeout(() => {
    projectsRefreshTimer = null
    loadProjects().catch((error) => {
      console.error('Failed to refresh projects:', error)
    })
  }, 250)
}

async function handleProjectContextUpdated(projectID: string) {
  if (currentProject.value?.id === projectID) {
    projectContextRevision.value++
    await refreshProject(projectID).catch((error) => {
      console.error('Failed to refresh current project:', error)
    })
  } else {
    scheduleProjectsRefresh()
  }
}

function subscribeGlobalEvents() {
  if (globalEventSource) {
    globalEventSource.close()
    globalEventSource = null
  }

  globalEventSource = api.subscribeGlobalEvents((event: GlobalSSEEventEnvelope) => {
    const payload = event.payload
    if (payload?.type === 'project.context.updated') {
      const projectID = payload.properties?.projectID
      if (typeof projectID === 'string' && projectID.length > 0) {
        void handleProjectContextUpdated(projectID)
      }
      return
    }

    if (payload?.type === 'project.updated') {
      scheduleProjectsRefresh()
    }
  })
}

onMounted(async () => {
  // 先注册事件处理器，确保在 SSE 连接建立时能接收到 server.connected 事件
  unregisterTerminalHandler = registerEventHandler(handleTerminalEvent)
  unregisterPreviewHandler = registerEventHandler(handlePreviewEvent)

  // 然后建立 SSE 连接
  subscribeToEvents()
  subscribeGlobalEvents()

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
  await loadProjects()
  if (appMode.value === 'agent') {
    await loadGlobalRecentSessions().catch((error) => {
      console.error('Failed to load global recent sessions:', error)
    })
    startGlobalRecentPolling()
  }

  // 加载模型 providers 和配置（确保模型选择器立即可用）
  await loadProviders()
  await loadConfig()

  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0])
  } else {
    // 进入草稿模式，不实际创建会话
    createSession('.')
  }

  // 加载待处理的问题和权限请求
  await loadPendingRequests()

  // Cmd+K / Ctrl+K shortcut for search
  document.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  unsubscribe()
  if (globalEventSource) {
    globalEventSource.close()
    globalEventSource = null
  }
  if (projectsRefreshTimer) {
    clearTimeout(projectsRefreshTimer)
    projectsRefreshTimer = null
  }
  document.removeEventListener('keydown', handleGlobalKeydown)
  stopGlobalRecentPolling()
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

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    showSearch.value = !showSearch.value
  }
}

// Tag new sessions with current app mode
watch(currentSession, (newSession, oldSession) => {
  if (newSession && !oldSession) {
    // A new session was just created (transitioned from draft/null to real session)
    setSessionMode(newSession.id, appMode.value)
  }
})

// 监听当前目录变化，更新文件树工作目录
watch(currentDirectory, async (newDir) => {
  setFilesDirectory(newDir || undefined)
  await loadFiles('.')
})

watch(appMode, (newMode) => {
  if (newMode === 'agent') {
    void refreshGlobalRecentSessions().catch((error) => {
      console.error('Failed to refresh global recent sessions:', error)
    })
    startGlobalRecentPolling()
    return
  }
  stopGlobalRecentPolling()
})

async function handleSend(content: string, files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode?: boolean) {
  // If viewing projects page, close it
  if (showProjectsPage.value) {
    showProjectsPage.value = false
  }

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
  showProjectsPage.value = false
  createSession(currentDirectory.value || '.')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// Mode switch handler — auto navigate to new chat
function handleSwitchMode(newMode: 'chat' | 'agent') {
  setAppMode(newMode)
  showProjectsPage.value = false
  createSession(currentDirectory.value || '.')
}

async function handleSelectProject(projectId: string) {
  if (!projectId) {
    clearProject()
    return
  }

  const project = await selectProject(projectId)
  if (!project) return

  const directory = project.rootDirectory || project.worktree
  if (canChangeDirectory()) {
    await changeDirectory(directory).catch(() => {
      createSession(directory)
    })
  } else {
    createSession(directory)
  }
  await loadSessions()
  await refreshGlobalRecentsIfAgent()
}

function handleOpenProjects() {
  showProjectsPage.value = true
  loadProjects().catch((error) => {
    console.error('Failed to load projects:', error)
  })
}

async function handleCreateProject(name: string, instructions: string, directory?: string) {
  if (!directory) return

  const project = await openDirectory(directory, {
    name: name || undefined,
    instructions: instructions || undefined,
  })

  const targetDirectory = project.rootDirectory || project.worktree
  if (canChangeDirectory()) {
    await changeDirectory(targetDirectory).catch(() => {
      createSession(targetDirectory)
    })
  } else {
    createSession(targetDirectory)
  }
  await loadSessions()
  await refreshGlobalRecentsIfAgent()
}

async function handleUpdateProject(projectId: string, updates: { name?: string; instructions?: string }) {
  await updateProject(projectId, updates)
}

// Handle search result selection
function handleSearchSelect(sessionId: string) {
  showSearch.value = false
  showProjectsPage.value = false
  const session = searchRecentSessions.value.find(s => s.id === sessionId) || sessions.value.find(s => s.id === sessionId)
  if (session) {
    selectSession(session)
  }
}

function handleProjectNewSession(projectId: string) {
  const project = getProject(projectId)
  if (!project) return
  showProjectsPage.value = false
  createSession(project.rootDirectory || project.worktree)
}

async function handleDeleteProject(projectId: string) {
  await forgetProject(projectId)
  await refreshGlobalRecentsIfAgent()
}

async function handleProjectSelectSession(session: Session) {
  showProjectsPage.value = false
  await selectSession(session)
}

async function handleSidebarSelectSession(session: Session) {
  showProjectsPage.value = false
  await selectSession(session)
}

async function handleDeleteSession(sessionId: string) {
  await deleteSession(sessionId)
  await refreshGlobalRecentsIfAgent()
}

async function handleRenameSession(sessionId: string, title: string) {
  await renameSession(sessionId, title)
  await refreshGlobalRecentsIfAgent()
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

// Toggle Plan panel
function togglePlanPanel() {
  showPlanPanel.value = !showPlanPanel.value
}

// Toggle MCP project panel
function toggleMcpPanel() {
  showMcpPanel.value = !showMcpPanel.value
}

// Open settings with specific tab
function handleOpenMcp() {
  settingsTab.value = 'mcp'
  openSettings()
}

function handleOpenSkills() {
  settingsTab.value = 'skills'
  openSettings()
}

// 处理提示分类选择
function handlePromptSelect(prompt: string) {
  handleSend(prompt)
}
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <Sidebar
      :collapsed="sidebarCollapsed"
      :sessions="sidebarSessions"
      :currentSession="currentSession"
      :isDraftSession="isDraftSession"
      :files="files"
      :filesLoading="filesLoading"
      :mode="appMode"
      :projects="projects"
      :currentProjectId="currentProject?.id || null"
      :currentDirectory="currentDirectory"
      :canChangeDirectory="canChangeDirectory()"
      :isSessionRunning="isSessionRunning"
      :runningCount="runningCount"
      :maxParallelAgents="MAX_PARALLEL_AGENTS"
      @toggle-collapse="toggleSidebar"
      @select-session="handleSidebarSelectSession"
      @new-session="handleNewSession"
      @toggle-directory="toggleDirectory"
      @delete-session="handleDeleteSession"
      @rename-session="handleRenameSession"
      @file-click="handleFileClick"
      @abort-session="abortSession"
      @open-settings="openSettings"
      @open-search="showSearch = true"
      @change-directory="changeDirectory"
      @switch-mode="handleSwitchMode"
      @select-project="handleSelectProject"
      @open-projects="handleOpenProjects"
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
      />

      <!-- Chat Area -->
      <div class="chat-panel" :class="{ 'empty-layout': isEmptyState }">
        <!-- Projects Page -->
        <ProjectsPage
          v-if="showProjectsPage"
          :projects="projects"
          :currentProject="currentProject"
          :projectContextRevision="projectContextRevision"
          @select-project="handleSelectProject"
          @update-project="handleUpdateProject"
          @select-session="handleProjectSelectSession"
          @new-session="handleProjectNewSession"
          @create-project="handleCreateProject"
          @delete-project="handleDeleteProject"
          @rename-session="handleRenameSession"
          @delete-session="handleDeleteSession"
          @close="showProjectsPage = false"
        />

        <!-- Empty State: Centered greeting + input + prompts -->
        <template v-else-if="isEmptyState">
          <div class="empty-center-wrapper">
            <ChatPanel
              :messages="messages"
              :isLoading="isLoading"
              :isStreaming="isStreaming"
              :pendingQuestions="pendingQuestions"
              :pendingPermissions="pendingPermissions"
              :sessionError="sessionError"
              :currentDirectory="currentDirectory"
              :canChangeDirectory="canChangeDirectory()"
              :mode="appMode"
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
              :centered="true"
              :providers="providers"
              :currentProvider="currentProvider"
              :currentModel="currentModel"
              :mode="appMode"
              :messages="messages"
              @send="handleSend"
              @abort="abortCurrentSession"
              @select-model="handleSelectModel"
              @open-mcp="handleOpenMcp"
              @toggle-mcp-panel="toggleMcpPanel"
              @open-skills="handleOpenSkills"
              @compress-session="handleSummarize"
              @toggle-todo="toggleTodoList"
              @toggle-plan="togglePlanPanel"
            />
            <PromptCategories
              @select="handlePromptSelect"
            />
          </div>
        </template>

        <!-- Normal Chat View with messages -->
        <template v-else>
          <ChatPanel
            :messages="messages"
            :isLoading="isLoading"
            :isStreaming="isStreaming"
            :pendingQuestions="pendingQuestions"
            :pendingPermissions="pendingPermissions"
            :sessionError="sessionError"
            :currentDirectory="currentDirectory"
            :canChangeDirectory="canChangeDirectory()"
            :mode="appMode"
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
            :centered="false"
            :providers="providers"
            :currentProvider="currentProvider"
            :currentModel="currentModel"
            :mode="appMode"
            :messages="messages"
            @send="handleSend"
            @abort="abortCurrentSession"
            @select-model="handleSelectModel"
            @open-mcp="handleOpenMcp"
            @toggle-mcp-panel="toggleMcpPanel"
            @open-skills="handleOpenSkills"
            @compress-session="handleSummarize"
            @toggle-todo="toggleTodoList"
            @toggle-plan="togglePlanPanel"
          />
        </template>

        <!-- Plan Panel (click outside to close) -->
        <div v-if="showPlanPanel" class="panel-overlay" @click.self="showPlanPanel = false">
          <div class="plan-panel-container">
            <PlanPanel
              :messages="messages"
              @close="showPlanPanel = false"
            />
          </div>
        </div>

        <!-- Todo List Panel (click outside to close) -->
        <div v-if="showTodoList" class="panel-overlay" @click.self="showTodoList = false">
          <div class="todo-panel-container">
            <TodoList
              :items="todoItems"
              :isLoading="isLoading"
              @close="showTodoList = false"
              @refresh="loadTodoItems"
            />
          </div>
        </div>

        <!-- MCP Project Panel (click outside to close) -->
        <div v-if="showMcpPanel" class="panel-overlay" @click.self="showMcpPanel = false">
          <div class="mcp-panel-container">
            <McpProjectPanel
              :currentDirectory="currentDirectory"
              @close="showMcpPanel = false"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Right Panel (Terminal + Preview) -->
    <RightPanel />

    <!-- Search Overlay -->
    <SearchOverlay
      v-if="showSearch"
      :recentSessions="searchRecentSessions"
      @close="showSearch = false"
      @select="handleSearchSelect"
    />

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

.panel-overlay {
  position: absolute;
  inset: 0;
  z-index: 99;
}

.plan-panel-container {
  position: absolute;
  top: calc(var(--header-height) + var(--space-md));
  left: var(--space-md);
  z-index: 100;
  width: 520px;
  max-width: calc(100% - var(--space-md) * 2);
}

.todo-panel-container {
  position: absolute;
  top: calc(var(--header-height) + var(--space-md));
  right: var(--space-md);
  z-index: 100;
  width: 360px;
  max-width: calc(100% - var(--space-md) * 2);
}

.mcp-panel-container {
  position: absolute;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  width: 320px;
  max-width: calc(100% - var(--space-md) * 2);
}

.chat-panel {
  position: relative;
}

/* Empty layout: PromptCategories centering */
.chat-panel.empty-layout :deep(.prompt-categories-wrapper) {
  margin: 0 auto;
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
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  animation: slideIn 0.3s var(--ease-smooth);
}

.notification-toast.success {
  border-color: var(--success);
  background: var(--bg-elevated);
}

.notification-toast.info {
  border-color: var(--accent);
  background: var(--bg-elevated);
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
  color: var(--success);
}

.notification-toast.info .notification-icon {
  background: rgba(99, 102, 241, 0.2);
  color: var(--accent);
}

.notification-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.notification-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notification-message {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.notification-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.notification-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
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
