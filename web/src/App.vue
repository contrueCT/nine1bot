<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSession } from './composables/useSession'
import { useFiles } from './composables/useFiles'
import { useSettings } from './composables/useSettings'
import { useAppMode } from './composables/useAppMode'
import { useSessionMode } from './composables/useSessionMode'
import { useProjects } from './composables/useProjects'
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
  // 重试信息
  retryInfo
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
  selectProject: selectProjectFn,
  clearProject,
  updateProject,
  createProject: createProjectFn,
  deleteLocalProject,
  addSessionToProject,
} = useProjects()

// 文件查看器状态
const showFileViewer = ref(false)

// 待办事项面板状态
const showTodoList = ref(false)

// Plan面板状态
const showPlanPanel = ref(false)

// MCP project panel state
const showMcpPanel = ref(false)

// Pending project tag for auto-tagging new sessions created from project view
const pendingProjectTag = ref<string | null>(null)

// Search overlay
const showSearch = ref(false)

// Projects page
const showProjectsPage = ref(false)

const sidebarCollapsed = ref(false)

// Empty state detection for centered layout
const isEmptyState = computed(() =>
  messages.value.length === 0 && !isLoading.value && !currentProject.value && !showProjectsPage.value
)

// Handle model selection from InputBox
async function handleSelectModel(providerId: string, modelId: string) {
  await settingsSelectModel(providerId, modelId)
}

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
  await loadProjects()

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
  document.removeEventListener('keydown', handleGlobalKeydown)
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

// Tag new sessions with current app mode and pending project
watch(currentSession, (newSession, oldSession) => {
  if (newSession && !oldSession) {
    // A new session was just created (transitioned from draft/null to real session)
    setSessionMode(newSession.id, appMode.value)
    // Auto-tag with project if pending
    if (pendingProjectTag.value) {
      addSessionToProject(pendingProjectTag.value, newSession.id)
      pendingProjectTag.value = null
    }
  }
})

// 监听当前目录变化，更新文件树工作目录
watch(currentDirectory, async (newDir) => {
  setFilesDirectory(newDir || undefined)
  await loadFiles('.')
})

async function handleSend(content: string, files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode?: boolean) {
  // If viewing a project, clear project view and go to session
  if (currentProject.value || showProjectsPage.value) {
    clearProject()
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
  clearProject()
  showProjectsPage.value = false
  createSession(currentDirectory.value || '.')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// Mode switch handler — auto navigate to new chat
function handleSwitchMode(newMode: 'chat' | 'agent') {
  setAppMode(newMode)
  clearProject()
  showProjectsPage.value = false
  createSession(currentDirectory.value || '.')
}

// Project selection handler
function handleSelectProject(projectId: string) {
  if (projectId) {
    selectProjectFn(projectId)
  } else {
    // Empty string means go back to list view
    clearProject()
  }
}

// Open projects page
function handleOpenProjects() {
  showProjectsPage.value = true
  clearProject()
}

// Create a new local project
function handleCreateProject(name: string, instructions: string, directory?: string) {
  const newProject = createProjectFn(name, instructions, directory || currentDirectory.value || '.')
  // Auto-select the newly created project
  selectProjectFn(newProject.id)
}

// Handle project update
async function handleUpdateProject(projectId: string, updates: { name?: string; instructions?: string }) {
  await updateProject(projectId, updates)
}

// Handle search result selection
function handleSearchSelect(sessionId: string) {
  showSearch.value = false
  showProjectsPage.value = false
  const session = sessions.value.find(s => s.id === sessionId)
  if (session) {
    clearProject()
    selectSession(session)
  }
}

// Handle creating new session from project
function handleProjectNewSession(projectId: string) {
  // Use the project's working directory for the new session
  const project = projects.value.find(p => p.id === projectId)
  const dir = project?.worktree || currentDirectory.value || '.'

  // Set pending project tag so the session gets auto-tagged when created
  pendingProjectTag.value = projectId

  clearProject()
  showProjectsPage.value = false

  // Change to project directory and create session
  if (project?.worktree) {
    changeDirectory(project.worktree)
  }
  createSession(dir)
}

// Handle deleting a project
function handleDeleteProject(projectId: string) {
  deleteLocalProject(projectId)
}

// Handle selecting session from project detail
function handleProjectSelectSession(sessionId: string) {
  const session = sessions.value.find(s => s.id === sessionId)
  if (session) {
    clearProject()
    showProjectsPage.value = false
    selectSession(session)
  }
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
      :sessions="sessions"
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
      @select-session="(session) => { clearProject(); showProjectsPage = false; selectSession(session) }"
      @new-session="handleNewSession"
      @toggle-directory="toggleDirectory"
      @delete-session="deleteSession"
      @rename-session="renameSession"
      @file-click="handleFileClick"
      @abort-session="abortSession"
      @open-settings="openSettings"
      @open-search="showSearch = true"
      @change-directory="changeDirectory"
      @switch-mode="handleSwitchMode"
      @select-project="handleSelectProject"
      @open-projects="handleOpenProjects"
      @move-to-project="(sessionId: string, projectId: string) => addSessionToProject(projectId, sessionId)"
    />

    <!-- Main Content -->
    <div class="main-content">
      <!-- Header -->
      <Header
        :session="currentSession"
        :isStreaming="isStreaming"
        :sidebarCollapsed="sidebarCollapsed"
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
          @select-project="handleSelectProject"
          @update-project="handleUpdateProject"
          @select-session="handleProjectSelectSession"
          @new-session="handleProjectNewSession"
          @create-project="handleCreateProject"
          @delete-project="handleDeleteProject"
          @rename-session="renameSession"
          @delete-session="deleteSession"
          @close="showProjectsPage = false; clearProject()"
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
      :recentSessions="sessions.slice(0, 10)"
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
