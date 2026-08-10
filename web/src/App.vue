<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, defineAsyncComponent } from 'vue'
import { useSession } from './composables/useSession'
import { useFiles } from './composables/useFiles'
import { useSettings } from './composables/useSettings'
import { useAppMode } from './composables/useAppMode'
import { useClientSurface } from './composables/useClientSurface'
import { useSessionMode } from './composables/useSessionMode'
import { useProjects } from './composables/useProjects'
import { useGlobalRecentSessions } from './composables/useGlobalRecentSessions'
import { collectActivePageContext, type RequestPagePayload } from './api/page-context'
import { api, type EventStreamSubscription, type GlobalSSEEventEnvelope, type Session } from './api/client'
import Header from './components/Header.vue'
import Sidebar from './components/Sidebar.vue'
import ChatPanel from './components/ChatPanel.vue'
import InputBox from './components/InputBox.vue'
import PromptCategories from './components/PromptCategories.vue'
import SearchOverlay from './components/SearchOverlay.vue'
import ProjectsPage from './components/ProjectsPage.vue'
import AutomationsPage from './components/AutomationsPage.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import BrowserExtensionSettingsPanel from './components/BrowserExtensionSettingsPanel.vue'
import SessionNotifications from './components/SessionNotifications.vue'
import AccessLogin from './components/AccessLogin.vue'
import FileViewer from './components/FileViewer.vue'
import TodoList from './components/TodoList.vue'
import PlanPanel from './components/PlanPanel.vue'
import McpProjectPanel from './components/McpProjectPanel.vue'
import RightPanel from './components/RightPanel.vue'
import { useAgentTerminal } from './composables/useAgentTerminal'
import { useFilePreview } from './composables/useFilePreview'
import { useTheme } from './composables/useTheme'
import { Globe2, Plus, RefreshCw, Settings, Terminal } from 'lucide-vue-next'
import { getTrustedExtensionParentContext, isTrustedExtensionParentEvent } from './utils/extension-parent'
import { useAccessAuth } from './composables/useAccessAuth'
import { parseSettingsDeepLink } from './utils/settings-deeplink'

import { MAX_PARALLEL_AGENTS } from './composables/useParallelSessions'

const MetricsDashboard = defineAsyncComponent(() => import('./components/MetricsDashboard.vue'))

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
  ensureSession,
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
const {
  handleSSEEvent: handleTerminalEvent,
  terminals: agentTerminals,
  setSessionContext: setTerminalSessionContext,
} = useAgentTerminal()

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
  isContentTruncated,
  loadFileContent,
  clearFileContent,
} = useFiles()

const {
  showSettings,
  openSettings,
  closeSettings,
  activeTab: settingsTab,
  currentProvider,
  currentModel,
  providers,
  selectModel: settingsSelectModel,
  loadProviders,
  loadConfig,
  loadPlatformDetail,
} = useSettings()

const { isBrowserExtension } = useClientSurface()
const {
  loading: accessLoading,
  enabled: accessEnabled,
  authenticated: accessAuthenticated,
  required: accessRequired,
  insecureTransport,
  initialize: initializeAccessAuth,
  logout: logoutAccessAuth,
} = useAccessAuth()

const ACCESS_TRANSPORT_WARNING_DURATION_MS = 5_000
const showAccessTransportWarning = ref(false)
let accessTransportWarningTimer: number | undefined

function clearAccessTransportWarningTimer() {
  if (accessTransportWarningTimer === undefined) return
  window.clearTimeout(accessTransportWarningTimer)
  accessTransportWarningTimer = undefined
}

watch([insecureTransport, accessAuthenticated], ([insecure, authenticated]) => {
  clearAccessTransportWarningTimer()
  showAccessTransportWarning.value = insecure && authenticated
  if (!showAccessTransportWarning.value) return
  accessTransportWarningTimer = window.setTimeout(() => {
    showAccessTransportWarning.value = false
    accessTransportWarningTimer = undefined
  }, ACCESS_TRANSPORT_WARNING_DURATION_MS)
}, { immediate: true })

// 主题在 App 根初始化一次：启动即应用 data-theme，不随设置面板卸载失效
useTheme()

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
const showMetricsPage = ref(false)

// Automations page
const showAutomationsPage = ref(false)

const sidebarCollapsed = ref(false)
// 移动端（≤768px）侧边栏抽屉开关
const sidebarMobileOpen = ref(false)
const projectContextRevision = ref(0)
const extensionPageContext = ref<RequestPagePayload | undefined>()
const extensionPageLoading = ref(false)
const extensionRelayStatus = ref({
  origin: '',
  bootstrapUrl: '',
  extensionUrl: '',
  serverReachable: true,
  relayConnected: true,
  message: '',
})

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
  messages.value.length === 0 &&
  !isLoading.value &&
  !showProjectsPage.value &&
  !showMetricsPage.value &&
  !showAutomationsPage.value
)

const extensionPageLabel = computed(() => {
  if (extensionPageLoading.value) return '正在检测当前页面...'
  const page = extensionPageContext.value
  if (!page) return '无页面上下文'
  return page.title || page.url || page.platform
})

const extensionPageDetail = computed(() => {
  const page = extensionPageContext.value
  if (!page) return '打开受支持的页面以纳入浏览器上下文。'
  const parts = [page.platform, page.pageType, page.url].filter(Boolean)
  return parts.join(' · ')
})

const extensionConnectionIssue = computed(() =>
  isBrowserExtension.value && (!extensionRelayStatus.value.serverReachable || !extensionRelayStatus.value.relayConnected)
)

const extensionConnectionText = computed(() => {
  if (!extensionRelayStatus.value.serverReachable) return '未连接到 Nine1Bot 主进程'
  if (!extensionRelayStatus.value.relayConnected) return '浏览器 relay 正在重连，页面对话可继续，浏览器控制暂不可用'
  return ''
})

const extensionTerminals = computed(() => {
  if (!isBrowserExtension.value || !currentSession.value) return []
  return agentTerminals.value.filter((terminal) => terminal.sessionID === currentSession.value?.id)
})

// Handle model selection from InputBox
async function handleSelectModel(providerId: string, modelId: string) {
  await settingsSelectModel(providerId, modelId)
}

// 保存 watch 停止函数以便在 unmount 时清理
let stopSessionWatch: (() => void) | null = null
let unregisterTerminalHandler: (() => void) | null = null
let unregisterPreviewHandler: (() => void) | null = null
let globalEventSource: EventStreamSubscription | null = null
let projectsRefreshTimer: ReturnType<typeof setTimeout> | null = null
let authenticatedRuntimeStarted = false

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

async function refreshExtensionPageContext() {
  if (!isBrowserExtension.value) return
  extensionPageLoading.value = true
  try {
    extensionPageContext.value = await collectActivePageContext(1200)
  } catch (error) {
    console.error('Failed to collect extension page context:', error)
    extensionPageContext.value = undefined
  } finally {
    extensionPageLoading.value = false
  }
}

function handleExtensionParentMessage(event: MessageEvent) {
  if (!isBrowserExtension.value || !isTrustedExtensionParentEvent(event)) return
  const message = event.data as {
    type?: unknown
    settings?: {
      origin?: string
      bootstrapUrl?: string
      extensionUrl?: string
      serverReachable?: boolean
      relayConnected?: boolean
      message?: string
    }
  } | undefined
  if (message?.type === 'nine1bot.activePageChanged') {
    void refreshExtensionPageContext()
    return
  }
  if (message?.type === 'nine1bot.relayStatus' && message.settings) {
    extensionRelayStatus.value = {
      origin: message.settings.origin || '',
      bootstrapUrl: message.settings.bootstrapUrl || '',
      extensionUrl: message.settings.extensionUrl || '',
      serverReachable: message.settings.serverReachable !== false,
      relayConnected: message.settings.relayConnected !== false,
      message: message.settings.message || '',
    }
  }
}

function initialSessionIdFromUrl(): string {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  return params.get('session') || params.get('sessionId') || ''
}

async function selectSessionById(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  let session =
    sidebarSessions.value.find((item) => item.id === sessionId) ||
    sessions.value.find((item) => item.id === sessionId)

  if (!session) {
    await loadSessions()
    session =
      sidebarSessions.value.find((item) => item.id === sessionId) ||
      sessions.value.find((item) => item.id === sessionId)
  }

  if (!session) return false

  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  await selectSession(session)
  return true
}

function openCurrentExtensionSessionInMainWeb() {
  const sessionId = currentSession.value?.id
  if (!sessionId) return
  const parentContext = getTrustedExtensionParentContext()
  if (!parentContext) return
  parentContext.parent.postMessage({
    type: 'nine1bot.openMainSession',
    sessionID: sessionId,
  }, parentContext.origin)
}

function stopAuthenticatedRuntime() {
  if (!authenticatedRuntimeStarted) return
  authenticatedRuntimeStarted = false
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
  if (stopSessionWatch) {
    stopSessionWatch()
    stopSessionWatch = null
  }
  if (unregisterTerminalHandler) {
    unregisterTerminalHandler()
    unregisterTerminalHandler = null
  }
  if (unregisterPreviewHandler) {
    unregisterPreviewHandler()
    unregisterPreviewHandler = null
  }
  sessions.value = []
  currentSession.value = null
  messages.value = []
  files.value = []
  clearFileContent()
  extensionPageContext.value = undefined
}

async function startAuthenticatedRuntime() {
  if (authenticatedRuntimeStarted) return
  authenticatedRuntimeStarted = true

  // 先注册事件处理器，确保在 SSE 连接建立时能接收到 server.connected 事件
  unregisterTerminalHandler = registerEventHandler(handleTerminalEvent)
  unregisterPreviewHandler = registerEventHandler(handlePreviewEvent)

  // 然后建立 SSE 连接
  subscribeToEvents()
  subscribeGlobalEvents()

  // 设置会话切换的 watch
  stopSessionWatch = watch(currentSession, async () => {
    setTerminalSessionContext(currentSession.value?.id || null)
    if (currentSession.value) {
      await loadPendingRequests()
    }
  }, { immediate: true })

  // Sync parallel session status from backend (for page refresh recovery)
  await syncSessionStatus()

  // 不传 directory 参数以加载所有会话
  await loadSessions()
  if (!isBrowserExtension.value) {
    await loadFiles('.')
    await loadProjects()
  }
  if (!isBrowserExtension.value && appMode.value === 'agent') {
    await loadGlobalRecentSessions().catch((error) => {
      console.error('Failed to load global recent sessions:', error)
    })
    startGlobalRecentPolling()
  }

  // 加载模型 providers 和配置（确保模型选择器立即可用）
  await loadProviders()
  await loadConfig()

  const requestedSessionId = initialSessionIdFromUrl()

  if (isBrowserExtension.value) {
    await refreshExtensionPageContext()
    createSession('.')
  } else if (requestedSessionId && await selectSessionById(requestedSessionId)) {
    window.history.replaceState({}, '', window.location.pathname)
  } else if (sessions.value.length > 0) {
    await selectSession(sessions.value[0])
  } else {
    // 进入草稿模式，不实际创建会话
    createSession('.')
  }

  // 加载待处理的问题和权限请求
  if (!isBrowserExtension.value || currentSession.value) {
    await loadPendingRequests()
  }

  // Cmd+K / Ctrl+K 搜索（仅主界面）与 Escape 关闭浮层
  document.addEventListener('keydown', handleGlobalKeydown)
}

async function handleAccessLogout() {
  stopAuthenticatedRuntime()
  await logoutAccessAuth()
}

watch(accessAuthenticated, (value) => {
  if (!value) stopAuthenticatedRuntime()
})

function applySettingsDeepLink() {
  const target = parseSettingsDeepLink(window.location.href)
  if (target?.section !== 'platforms') return
  settingsTab.value = 'platforms'
  openSettings()
  if (target.platformId) void loadPlatformDetail(target.platformId)
}

onMounted(async () => {
  if (isBrowserExtension.value) {
    window.addEventListener('message', handleExtensionParentMessage)
  }
  const allowed = await initializeAccessAuth(isBrowserExtension.value ? 'browser-extension' : 'web')
  if (allowed) {
    await startAuthenticatedRuntime()
    if (!isBrowserExtension.value) applySettingsDeepLink()
  }
})

onUnmounted(() => {
  window.removeEventListener('message', handleExtensionParentMessage)
  clearAccessTransportWarningTimer()
  stopAuthenticatedRuntime()
})

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    if (isBrowserExtension.value) return
    e.preventDefault()
    showSearch.value = !showSearch.value
    return
  }
  // Escape 统一关闭浮层（搜索/文件查看器/目录选择器各自处理自己的 Escape）
  if (e.key === 'Escape') {
    if (showPlanPanel.value) showPlanPanel.value = false
    else if (showTodoList.value) showTodoList.value = false
    else if (showMcpPanel.value) showMcpPanel.value = false
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

async function handleSend(content: string, files?: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode?: boolean, onResult?: (success: boolean) => void) {
  // If viewing projects page, close it
  if (showProjectsPage.value) {
    showProjectsPage.value = false
  }
  if (showMetricsPage.value) {
    showMetricsPage.value = false
  }
  if (showAutomationsPage.value) {
    showAutomationsPage.value = false
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

  const success = await sendMessage(finalContent, model, files)
  onResult?.(success)
}

async function ensureCurrentSessionId() {
  const session = await ensureSession()
  return session?.id ?? null
}

function handleNewSession() {
  sidebarMobileOpen.value = false
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  void refreshExtensionPageContext()
  createSession(currentDirectory.value || '.')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// Mode switch handler — auto navigate to new chat
function handleSwitchMode(newMode: 'chat' | 'agent') {
  sidebarMobileOpen.value = false
  setAppMode(newMode)
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  createSession(currentDirectory.value || '.')
}

async function handleSelectProject(projectId: string) {
  sidebarMobileOpen.value = false
  if (!projectId) {
    clearProject()
    return
  }

  showMetricsPage.value = false
  showAutomationsPage.value = false
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
  sidebarMobileOpen.value = false
  showMetricsPage.value = false
  showProjectsPage.value = true
  showAutomationsPage.value = false
  loadProjects().catch((error) => {
    console.error('Failed to load projects:', error)
  })
}

function handleOpenAutomations() {
  sidebarMobileOpen.value = false
  showAutomationsPage.value = true
  showProjectsPage.value = false
  showMetricsPage.value = false
  loadProjects().catch((error) => {
    console.error('Failed to load projects:', error)
  })
}

function handleOpenMetrics() {
  sidebarMobileOpen.value = false
  showProjectsPage.value = false
  showAutomationsPage.value = false
  showMetricsPage.value = true
}

function handleToggleMetrics() {
  sidebarMobileOpen.value = false
  showProjectsPage.value = false
  showAutomationsPage.value = false
  showMetricsPage.value = !showMetricsPage.value
}

async function handleOpenMetricsSession(sessionId: string) {
  let session =
    sidebarSessions.value.find((item) => item.id === sessionId) ||
    sessions.value.find((item) => item.id === sessionId)

  if (!session) {
    await loadSessions()
    session =
      sidebarSessions.value.find((item) => item.id === sessionId) ||
      sessions.value.find((item) => item.id === sessionId)
  }

  if (!session) return

  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  await selectSession(session)
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
  showProjectsPage.value = false
  showAutomationsPage.value = false
  await loadSessions()
  await refreshGlobalRecentsIfAgent()
}

async function handleUpdateProject(projectId: string, updates: { name?: string; instructions?: string }, done?: () => void) {
  try {
    await updateProject(projectId, updates)
  } finally {
    done?.()
  }
}

// Handle search result selection
function handleSearchSelect(sessionId: string) {
  sidebarMobileOpen.value = false
  showSearch.value = false
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  const session = searchRecentSessions.value.find(s => s.id === sessionId) || sessions.value.find(s => s.id === sessionId)
  if (session) {
    selectSession(session)
  }
}

function handleProjectNewSession(projectId: string) {
  const project = getProject(projectId)
  if (!project) return
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  createSession(project.rootDirectory || project.worktree)
}

async function handleDeleteProject(projectId: string) {
  await forgetProject(projectId)
  await refreshGlobalRecentsIfAgent()
}

async function handleProjectSelectSession(session: Session) {
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  await selectSession(session)
}

async function handleSidebarSelectSession(session: Session) {
  sidebarMobileOpen.value = false
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
  await selectSession(session)
}

async function handleAutomationSelectSession(session: Session) {
  showProjectsPage.value = false
  showMetricsPage.value = false
  showAutomationsPage.value = false
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
  <div v-if="accessLoading" class="access-loading">正在检查访问权限…</div>

  <AccessLogin v-else-if="accessRequired" @authenticated="startAuthenticatedRuntime" />

  <template v-else>
    <Transition name="access-transport-warning">
      <div v-if="showAccessTransportWarning" class="access-transport-warning" role="status">
        当前通过 HTTP 访问；功能可用，但传输内容不会被加密。
      </div>
    </Transition>
    <button
      v-if="accessEnabled"
      class="access-logout-button"
      type="button"
      title="退出 WebUI 登录"
      @click="handleAccessLogout"
    >退出登录</button>

  <div v-if="isBrowserExtension" class="extension-app-layout">
    <header class="extension-chat-header">
      <div class="extension-header-main">
        <div class="extension-title-row">
          <span class="extension-title">浏览器对话</span>
          <span class="extension-badge">扩展</span>
        </div>
        <div class="extension-page-context" :title="extensionPageDetail">
          <Globe2 :size="14" />
          <span>{{ extensionPageLabel }}</span>
        </div>
      </div>
      <div class="extension-header-actions">
        <button class="extension-icon-btn" type="button" title="刷新页面上下文" @click="refreshExtensionPageContext">
          <RefreshCw :size="16" />
        </button>
        <button class="extension-icon-btn" type="button" title="设置" @click="openSettings">
          <Settings :size="16" />
        </button>
        <button class="extension-action-btn" type="button" @click="handleNewSession">
          <Plus :size="16" />
          <span>新会话</span>
        </button>
      </div>
    </header>

    <main class="extension-chat-body" :class="{ 'empty-layout': isEmptyState }">
      <div v-if="extensionConnectionIssue" class="extension-connection-banner">
        <div>
          <strong>{{ extensionConnectionText }}</strong>
          <span>{{ extensionRelayStatus.origin || 'http://127.0.0.1:4096' }}</span>
        </div>
        <button type="button" @click="openSettings">设置连接</button>
      </div>

      <ChatPanel
        :messages="messages"
        :isLoading="isLoading"
        :isStreaming="isStreaming"
        :sessionId="currentSession?.id"
        :pendingQuestions="pendingQuestions"
        :pendingPermissions="pendingPermissions"
        :sessionError="sessionError"
        :currentDirectory="currentDirectory"
        :canChangeDirectory="false"
        mode="chat"
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
        :centered="messages.length === 0"
        :ensureSession="ensureCurrentSessionId"
        :providers="providers"
        :currentProvider="currentProvider"
        :currentModel="currentModel"
        mode="chat"
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

      <div v-if="showPlanPanel" class="panel-overlay" @click.self="showPlanPanel = false">
        <div class="plan-panel-container">
          <PlanPanel :messages="messages" @close="showPlanPanel = false" />
        </div>
      </div>

      <div v-if="showTodoList" class="panel-overlay" @click.self="showTodoList = false">
        <div class="todo-panel-container">
          <TodoList :items="todoItems" :isLoading="isLoading" @close="showTodoList = false" @refresh="loadTodoItems" />
        </div>
      </div>

      <div v-if="showMcpPanel" class="panel-overlay" @click.self="showMcpPanel = false">
        <div class="mcp-panel-container">
          <McpProjectPanel :currentDirectory="currentDirectory" @close="showMcpPanel = false" />
        </div>
      </div>

      <aside v-if="extensionTerminals.length > 0" class="extension-terminal-notice">
        <Terminal :size="16" />
        <div>
          <strong>终端已在主界面打开</strong>
          <span>侧边栏内不展示 PTY 终端，点击继续到完整对话。</span>
        </div>
        <button type="button" @click="openCurrentExtensionSessionInMainWeb">继续</button>
      </aside>
    </main>

    <BrowserExtensionSettingsPanel v-if="showSettings" @close="closeSettings" />

    <SessionNotifications
      :notifications="sessionNotifications"
      @dismiss="dismissNotification"
    />
  </div>

  <div v-else class="app-layout">
    <!-- Sidebar -->
    <Sidebar
      :collapsed="sidebarCollapsed"
      :mobileOpen="sidebarMobileOpen"
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
      :activePage="showMetricsPage ? 'metrics' : showAutomationsPage ? 'automations' : showProjectsPage ? 'projects' : 'chat'"
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
      @open-metrics="handleOpenMetrics"
      @open-automations="handleOpenAutomations"
    />

    <!-- 移动端侧边栏遮罩（点击关闭） -->
    <div
      v-if="sidebarMobileOpen"
      class="sidebar-scrim"
      @click="sidebarMobileOpen = false"
    ></div>

    <!-- Main Content -->
    <div class="main-content">
      <!-- Header -->
      <Header
        :session="currentSession"
        :isStreaming="isStreaming"
        :sidebarCollapsed="sidebarCollapsed"
        :isSummarizing="isSummarizing"
        :retryInfo="retryInfo"
        :showMetrics="showMetricsPage"
        @toggle-sidebar="toggleSidebar"
        @toggle-mobile-sidebar="sidebarMobileOpen = !sidebarMobileOpen"
        @abort="abortCurrentSession"
        @toggle-metrics="handleToggleMetrics"
      />

      <!-- Chat Area -->
      <div class="chat-panel" :class="{ 'empty-layout': isEmptyState }">
        <!-- Automations Page -->
        <AutomationsPage
          v-if="showAutomationsPage"
          :projects="projects"
          @select-session="handleAutomationSelectSession"
        />

        <!-- Projects Page -->
        <ProjectsPage
          v-else-if="showProjectsPage"
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

        <MetricsDashboard
          v-else-if="showMetricsPage"
          :visible="showMetricsPage"
          @open-session="handleOpenMetricsSession"
        />

        <!-- Keep one composer instance while empty/loading state changes. -->
        <template v-else>
          <div class="conversation-content" :class="{ 'empty-center-wrapper': isEmptyState }">
            <ChatPanel
              :messages="messages"
              :isLoading="isLoading"
              :isStreaming="isStreaming"
              :sessionId="currentSession?.id"
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
              :centered="isEmptyState"
              :ensureSession="ensureCurrentSessionId"
              :providers="providers"
              :currentProvider="currentProvider"
              :currentModel="currentModel"
              :mode="appMode"
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
              v-if="isEmptyState"
              @select="handlePromptSelect"
            />
          </div>
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
      :truncated="isContentTruncated"
      @close="closeFileViewer"
    />

    <SessionNotifications
      :notifications="sessionNotifications"
      @dismiss="dismissNotification"
    />
  </div>
  </template>
</template>

<style scoped>
/* Layout uses global styles from style.css */

.access-loading {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg-primary);
  color: var(--text-muted);
}

.access-transport-warning {
  position: fixed;
  z-index: 1000;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 220px);
  padding: 6px 10px;
  border-radius: 7px;
  background: #fff4d6;
  color: #7a4b00;
  font-size: 11px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.access-transport-warning-enter-active,
.access-transport-warning-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.access-transport-warning-enter-from,
.access-transport-warning-leave-to {
  opacity: 0;
  transform: translate(-50%, -4px);
}

.access-logout-button {
  position: fixed;
  z-index: 1001;
  right: 12px;
  bottom: 12px;
  padding: 6px 10px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.78;
}

.access-logout-button:hover { opacity: 1; color: var(--text-primary); }

.extension-app-layout {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-primary);
}

.extension-chat-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-height: 58px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-elevated);
}

.extension-header-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.extension-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.extension-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
}

.extension-badge {
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--accent-subtle);
  color: var(--accent);
  font-size: var(--text-xs);
  line-height: 16px;
}

.extension-page-context {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.extension-page-context span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.extension-icon-btn,
.extension-action-btn {
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.extension-icon-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-secondary);
}

.extension-icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.extension-action-btn {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: var(--text-sm);
  font-weight: 600;
}

.extension-action-btn:hover {
  background: var(--accent-hover);
}

.extension-chat-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 12px 12px;
}

.extension-connection-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 10px 0 0;
  padding: 10px 12px;
  border: 1px solid rgba(180, 35, 24, 0.22);
  border-radius: var(--radius-md);
  background: rgba(180, 35, 24, 0.06);
  color: var(--text-primary);
}

.extension-connection-banner div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.extension-connection-banner strong {
  font-size: var(--text-sm);
  font-weight: 650;
}

.extension-connection-banner span {
  color: var(--text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-connection-banner button,
.extension-terminal-notice button {
  flex-shrink: 0;
  height: 28px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 0 10px;
  background: var(--accent);
  color: var(--accent-fg);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
}

.extension-terminal-notice {
  position: absolute;
  right: 12px;
  bottom: 86px;
  z-index: var(--z-fixed);
  width: min(330px, calc(100% - 24px));
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
}

.extension-terminal-notice > svg {
  flex-shrink: 0;
  color: var(--accent);
}

.extension-terminal-notice div {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.extension-terminal-notice strong {
  font-size: var(--text-sm);
  font-weight: 650;
}

.extension-terminal-notice span {
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.4;
}

.extension-chat-body :deep(.chat-messages) {
  flex: 1;
}

.extension-chat-body :deep(.chat-empty) {
  padding-top: 32px;
}

.extension-chat-body :deep(.input-container) {
  padding-bottom: 0;
}

.panel-overlay {
  position: absolute;
  inset: 0;
  z-index: var(--z-scrim);
}

.plan-panel-container {
  position: absolute;
  top: calc(var(--header-height) + var(--space-md));
  left: var(--space-md);
  z-index: var(--z-dropdown);
  width: 520px;
  max-width: calc(100% - var(--space-md) * 2);
}

.todo-panel-container {
  position: absolute;
  top: calc(var(--header-height) + var(--space-md));
  right: var(--space-md);
  z-index: var(--z-dropdown);
  width: 360px;
  max-width: calc(100% - var(--space-md) * 2);
}

.mcp-panel-container {
  position: absolute;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-dropdown);
  width: 320px;
  max-width: calc(100% - var(--space-md) * 2);
}

.chat-panel {
  position: relative;
}

.conversation-content:not(.empty-center-wrapper) {
  display: contents;
}

/* Empty layout: PromptCategories centering */
.chat-panel.empty-layout :deep(.prompt-categories-wrapper) {
  margin: 0 auto;
}

</style>
