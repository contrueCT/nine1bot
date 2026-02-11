<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  PanelLeftClose, PanelLeft, MessageSquare, Plus, Search,
  FolderOpen, Code2, Sparkles, Pencil, Trash2, X, Check,
  Loader2, Square, ChevronRight, User, MessageCircle, EllipsisVertical
} from 'lucide-vue-next'
import type { Session, FileItem } from '../api/client'
import type { AppMode } from '../composables/useAppMode'
import { useSessionMode } from '../composables/useSessionMode'
import { useUserProfile } from '../composables/useUserProfile'

export interface ProjectInfo {
  id: string
  name?: string
  worktree: string
  icon?: { url?: string; override?: string; color?: string }
  instructions?: string
  time: { created: number; updated: number }
  sandboxes: string[]
}

const props = defineProps<{
  collapsed: boolean
  sessions: Session[]
  currentSession: Session | null
  isDraftSession: boolean
  files: FileItem[]
  filesLoading: boolean
  mode: AppMode
  // Projects
  projects: ProjectInfo[]
  currentProjectId: string | null
  // Working directory
  currentDirectory: string
  canChangeDirectory: boolean
  // Parallel session props
  isSessionRunning: (sessionId: string) => boolean
  runningCount: number
  maxParallelAgents: number
}>()

const emit = defineEmits<{
  'toggle-collapse': []
  'select-session': [session: Session]
  'new-session': []
  'toggle-directory': [file: FileItem]
  'delete-session': [sessionId: string]
  'rename-session': [sessionId: string, title: string]
  'file-click': [path: string]
  'abort-session': [sessionId: string]
  'open-settings': []
  'open-search': []
  'change-directory': [directory: string]
  'switch-mode': [mode: AppMode]
  'select-project': [projectId: string]
  'open-projects': []
  'move-to-project': [sessionId: string, projectId: string]
}>()

// Session mode mapping
const { getMode } = useSessionMode()

// User profile
const { profile, brandLogo } = useUserProfile()

// Sections collapse state
const showRecents = ref(true)

// 重命名状态
const renamingSession = ref<Session | null>(null)
const newTitle = ref('')

// 删除确认状态
const deletingSession = ref<Session | null>(null)

// Right-click context menu
const contextMenu = ref<{ x: number; y: number; session: Session } | null>(null)
const showProjectPicker = ref(false)

// Toast notification for errors
const toastMessage = ref('')

// Sessions filtered by current mode
const filteredSessions = computed(() => {
  // Show sessions matching current mode, or untagged (legacy) sessions
  return props.sessions.filter(s => {
    const sessionMode = getMode(s.id)
    return sessionMode === props.mode || sessionMode === undefined
  })
})

function cancelRename() {
  renamingSession.value = null
  newTitle.value = ''
}

function doRename() {
  if (renamingSession.value && newTitle.value.trim()) {
    emit('rename-session', renamingSession.value.id, newTitle.value.trim())
  }
  cancelRename()
}

function cancelDelete() {
  deletingSession.value = null
}

function doDelete() {
  if (deletingSession.value) {
    emit('delete-session', deletingSession.value.id)
  }
  cancelDelete()
}

function getSessionTitle(session: Session): string {
  return session.title || `会话 ${session.id.slice(0, 6)}`
}

// Context menu handlers
function openContextMenu(event: MouseEvent, session: Session) {
  event.preventDefault()
  event.stopPropagation()
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    session
  }
  showProjectPicker.value = false
}

function closeContextMenu() {
  contextMenu.value = null
  showProjectPicker.value = false
}

function contextMenuRename() {
  if (contextMenu.value) {
    renamingSession.value = contextMenu.value.session
    newTitle.value = contextMenu.value.session.title || `会话 ${contextMenu.value.session.id.slice(0, 6)}`
  }
  closeContextMenu()
}

function contextMenuDelete() {
  if (contextMenu.value) {
    deletingSession.value = contextMenu.value.session
  }
  closeContextMenu()
}

// Project logic stubs (will be re-implemented with backend)
function contextMenuMoveToProject(projectId: string) {
  if (!contextMenu.value) return
  emit('move-to-project', contextMenu.value.session.id, projectId)
  closeContextMenu()
}

function contextMenuRemoveFromProject(_sessionId: string, _projectId: string) {
  // stub
  closeContextMenu()
}

function getSessionProjectNames(_sessionId: string): { id: string; name: string }[] {
  return []
}

function getAvailableProjects(_sessionId: string) {
  return props.projects
}
</script>

<template>
  <aside class="sidebar claude-style" :class="{ collapsed }">
    <!-- Header: Brand + Collapse -->
    <div class="sidebar-header">
      <div class="brand-area" v-if="!collapsed">
        <img v-if="brandLogo.logoUrl" :src="brandLogo.logoUrl" alt="Logo" class="brand-logo" />
        <span class="brand-text">Nine1Bot</span>
      </div>
      <button class="collapse-btn" @click="emit('toggle-collapse')" :title="collapsed ? '展开' : '折叠'">
        <PanelLeftClose v-if="!collapsed" :size="18" />
        <PanelLeft v-else :size="18" />
      </button>
    </div>

    <!-- Top Navigation (expanded) - Claude.ai style flat list -->
    <nav class="sidebar-nav" v-if="!collapsed">
      <button class="nav-item new-chat" @click="emit('new-session')">
        <Plus :size="18" />
        <span>New chat</span>
      </button>
      <button class="nav-item" @click="emit('open-search')">
        <Search :size="18" />
        <span>Search</span>
      </button>
      <button class="nav-item" @click="emit('open-projects')">
        <FolderOpen :size="18" />
        <span>Projects</span>
      </button>
    </nav>

    <!-- Top Navigation (collapsed) -->
    <nav class="sidebar-nav sidebar-nav-collapsed" v-if="collapsed">
      <button class="nav-item-icon" @click="emit('new-session')" title="New chat">
        <Plus :size="18" />
      </button>
      <button class="nav-item-icon" @click="emit('open-search')" title="Search">
        <Search :size="18" />
      </button>
      <button class="nav-item-icon" @click="emit('open-projects')" title="Projects">
        <FolderOpen :size="18" />
      </button>
    </nav>

    <!-- Recents Section -->
    <div class="sidebar-section" v-if="!collapsed">
      <div class="section-header" @click="showRecents = !showRecents">
        <span class="section-label">Recents</span>
        <ChevronRight :size="14" class="section-chevron" :class="{ expanded: showRecents }" />
      </div>

      <div v-if="showRecents" class="section-list">
        <!-- Draft Session -->
        <div
          v-if="isDraftSession"
          class="session-item active"
        >
          <Sparkles :size="14" class="session-icon" />
          <span class="session-title">新对话</span>
        </div>

        <!-- Filtered Sessions by Mode -->
        <div
          v-for="session in filteredSessions"
          :key="session.id"
          class="session-item"
          :class="{
            active: !isDraftSession && currentSession?.id === session.id,
            running: isSessionRunning(session.id)
          }"
          @click="emit('select-session', session)"
          @contextmenu="openContextMenu($event, session)"
        >
          <Loader2 v-if="isSessionRunning(session.id)" :size="14" class="session-icon spin" />
          <MessageSquare v-else :size="14" class="session-icon" />
          <span class="session-title">{{ getSessionTitle(session) }}</span>

          <!-- Session Actions (on hover) -->
          <div class="session-actions" @click.stop>
            <button
              v-if="isSessionRunning(session.id)"
              class="mini-btn abort"
              @click="emit('abort-session', session.id)"
              title="停止"
            >
              <Square :size="10" fill="currentColor" />
            </button>
            <button class="mini-btn" @click="openContextMenu($event, session)" title="更多操作">
              <EllipsisVertical :size="14" />
            </button>
          </div>
        </div>

        <!-- Empty state when no sessions match current mode -->
        <div v-if="filteredSessions.length === 0 && !isDraftSession" class="section-empty">
          No conversations yet
        </div>
      </div>
    </div>

    <!-- Spacer to push mode switch + footer to bottom -->
    <div class="sidebar-spacer"></div>

    <!-- Mode Switcher -->
    <div class="mode-switcher" v-if="!collapsed">
      <button
        class="mode-btn"
        :class="{ active: mode === 'chat' }"
        @click="emit('switch-mode', 'chat')"
      >
        <MessageCircle :size="16" />
        <span>Chat</span>
      </button>
      <button
        class="mode-btn"
        :class="{ active: mode === 'agent' }"
        @click="emit('switch-mode', 'agent')"
      >
        <Code2 :size="16" />
        <span>Agent</span>
      </button>
    </div>

    <!-- Collapsed Mode Switcher -->
    <div class="mode-switcher mode-switcher-collapsed" v-if="collapsed">
      <button
        class="nav-item-icon"
        :class="{ active: mode === 'chat' }"
        @click="emit('switch-mode', 'chat')"
        title="Chat mode"
      >
        <MessageCircle :size="18" />
      </button>
      <button
        class="nav-item-icon"
        :class="{ active: mode === 'agent' }"
        @click="emit('switch-mode', 'agent')"
        title="Agent mode"
      >
        <Code2 :size="18" />
      </button>
    </div>

    <!-- User Profile Footer -->
    <div class="sidebar-footer" v-if="!collapsed">
      <div class="user-profile" @click="emit('open-settings')">
        <div class="user-avatar">
          <img v-if="profile.avatarUrl" :src="profile.avatarUrl" alt="Avatar" class="avatar-img" />
          <User v-else :size="16" />
        </div>
        <div class="user-info">
          <span class="user-name">{{ profile.name || '用户' }}</span>
          <span class="user-plan">Nine1Bot</span>
        </div>
      </div>
    </div>

    <!-- Collapsed Footer (avatar only) -->
    <div class="sidebar-footer sidebar-footer-collapsed" v-if="collapsed">
      <button class="nav-item-icon" @click="emit('open-settings')" title="设置">
        <User :size="18" />
      </button>
    </div>
  </aside>

  <!-- 使用 Teleport 将对话框传送到 body，避免被侧边栏样式限制 -->
  <Teleport to="body">
    <!-- 重命名对话框 -->
    <div v-if="renamingSession" class="dialog-overlay" @click="cancelRename">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <span>重命名会话</span>
          <button class="action-btn" @click="cancelRename">
            <X :size="16" />
          </button>
        </div>
        <div class="dialog-body">
          <input
            v-model="newTitle"
            type="text"
            class="dialog-input"
            placeholder="输入新名称"
            @keyup.enter="doRename"
            @keyup.escape="cancelRename"
            autofocus
          />
        </div>
        <div class="dialog-footer">
          <button class="btn btn-ghost btn-sm" @click="cancelRename">取消</button>
          <button class="btn btn-primary btn-sm" @click="doRename" :disabled="!newTitle.trim()">
            <Check :size="14" class="mr-1" />
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认对话框 -->
    <div v-if="deletingSession" class="dialog-overlay" @click="cancelDelete">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <span>删除会话</span>
          <button class="action-btn" @click="cancelDelete">
            <X :size="16" />
          </button>
        </div>
        <div class="dialog-body">
          <p class="dialog-message">确定要删除会话 "{{ getSessionTitle(deletingSession) }}" 吗？</p>
          <p class="dialog-warning">此操作不可撤销，所有消息将被永久删除。</p>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-ghost btn-sm" @click="cancelDelete">取消</button>
          <button class="btn btn-danger btn-sm" @click="doDelete">
            <Trash2 :size="14" class="mr-1" />
            删除
          </button>
        </div>
      </div>
    </div>

    <!-- Right-click Context Menu -->
    <div
      v-if="contextMenu"
      class="context-menu-overlay"
      @click="closeContextMenu"
      @contextmenu.prevent="closeContextMenu"
    >
      <div
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <!-- Current projects (if session belongs to any) -->
        <template v-if="getSessionProjectNames(contextMenu.session.id).length > 0">
          <div class="context-menu-label">已在项目</div>
          <div
            v-for="proj in getSessionProjectNames(contextMenu.session.id)"
            :key="proj.id"
            class="context-menu-item project-tag-item"
          >
            <FolderOpen :size="12" />
            <span class="project-tag-name">{{ proj.name }}</span>
            <button
              class="project-tag-remove"
              @click.stop="contextMenuRemoveFromProject(contextMenu!.session.id, proj.id)"
              title="移出项目"
            >
              <X :size="12" />
            </button>
          </div>
          <div class="context-menu-divider"></div>
        </template>

        <!-- Move to Project -->
        <div class="context-menu-item-wrapper">
          <button class="context-menu-item" @click="showProjectPicker = !showProjectPicker">
            <FolderOpen :size="14" />
            <span>移入项目</span>
            <ChevronRight :size="12" class="context-menu-arrow" />
          </button>
          <!-- Project sub-menu (only shows projects not yet assigned) -->
          <div v-if="showProjectPicker" class="context-submenu">
            <button
              v-for="project in getAvailableProjects(contextMenu.session.id)"
              :key="project.id"
              class="context-menu-item"
              @click="contextMenuMoveToProject(project.id)"
            >
              <span>{{ project.name || project.worktree }}</span>
            </button>
            <div v-if="getAvailableProjects(contextMenu.session.id).length === 0" class="context-menu-empty">
              {{ projects.length === 0 ? '暂无项目' : '已加入所有项目' }}
            </div>
          </div>
        </div>
        <button class="context-menu-item" @click="contextMenuRename">
          <Pencil :size="14" />
          <span>重命名</span>
        </button>
        <div class="context-menu-divider"></div>
        <button class="context-menu-item danger" @click="contextMenuDelete">
          <Trash2 :size="14" />
          <span>删除</span>
        </button>
      </div>
    </div>

    <!-- Toast notification -->
    <Transition name="toast">
      <div v-if="toastMessage" class="sidebar-toast">
        {{ toastMessage }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* === Claude-Style Sidebar === */
.sidebar.claude-style {
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-family: var(--font-sans);
  background: var(--bg-primary);
  border-right: 0.5px solid var(--border-default);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md) var(--space-md) var(--space-sm);
}

.brand-area {
  display: flex;
  align-items: center;
}

.brand-logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
  border-radius: var(--radius-sm);
}

.brand-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.collapse-btn {
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

.collapse-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* === Navigation Menu === */
.sidebar-nav {
  padding: var(--space-xs) var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px var(--space-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: var(--font-weight-normal);
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--transition-fast);
  width: 100%;
}

.nav-item:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--text-primary);
}

.nav-item.new-chat {
  color: var(--text-primary);
  font-weight: 500;
}

.nav-item svg {
  flex-shrink: 0;
  opacity: 0.7;
}

.nav-item:hover svg {
  opacity: 1;
}

/* === Sections === */
.sidebar-section {
  display: flex;
  flex-direction: column;
  padding: var(--space-xs) 0;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-xs) var(--space-md);
  cursor: pointer;
}

.section-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.section-chevron {
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

.section-chevron.expanded {
  transform: rotate(90deg);
}

.section-list {
  overflow-y: auto;
  padding: var(--space-xs) var(--space-sm);
}

.section-empty {
  padding: 6px var(--space-sm);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

/* === Session Items === */
.session-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px var(--space-sm);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  position: relative;
}

.session-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.session-item.active {
  background: var(--accent-subtle);
}

.session-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.session-item.active .session-icon {
  color: var(--accent);
}

.session-title {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item.active .session-title {
  color: var(--accent);
  font-weight: 500;
}

.session-item.running .session-icon {
  color: var(--accent);
}

/* Session action buttons */
.session-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.session-item:hover .session-actions {
  opacity: 1;
}

.mini-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all var(--transition-fast);
}

.mini-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.mini-btn.danger:hover {
  color: var(--error);
}

.mini-btn.abort {
  color: var(--error);
}


/* === Spacer === */
.sidebar-spacer {
  flex: 0;
  min-height: var(--space-sm);
}

/* === Mode Switcher === */
.mode-switcher {
  display: flex;
  gap: 4px;
  padding: var(--space-xs) var(--space-sm);
  margin: 0 var(--space-sm);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
}

.mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.mode-btn:hover {
  color: var(--text-primary);
}

.mode-btn.active {
  background: var(--bg-composer);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.mode-switcher-collapsed {
  flex-direction: column;
  align-items: center;
  background: transparent;
  margin: 0;
  padding: var(--space-xs) 0;
}

/* === User Profile Footer === */
.sidebar-footer {
  padding: var(--space-sm) var(--space-md);
  border-top: 0.5px solid var(--border-subtle);
}

.user-profile {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.user-profile:hover {
  background: rgba(0, 0, 0, 0.04);
}

.user-avatar {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: 50%;
  color: var(--text-muted);
  overflow: hidden;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.user-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.user-plan {
  font-size: 11px;
  color: var(--text-muted);
}

/* === Animations === */
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* === Collapsed State === */
.sidebar.collapsed {
  width: 0px;
  min-width: 0px;
  opacity: 0;
  pointer-events: none;
}

.sidebar.collapsed .sidebar-header {
  justify-content: center;
  padding: var(--space-sm);
}

/* === Collapsed Nav Icons === */
.sidebar-nav-collapsed {
  align-items: center;
  padding: var(--space-xs) 0;
}

.nav-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.nav-item-icon:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--text-primary);
}

.nav-item-icon.active {
  background: var(--accent-subtle);
  color: var(--accent);
}

/* === Collapsed Footer === */
.sidebar-footer-collapsed {
  display: flex;
  justify-content: center;
  padding: var(--space-sm) 0;
  border-top: 0.5px solid var(--border-subtle);
}

</style>

<!-- 非 scoped 样式，用于 Teleport 的对话框 -->
<style>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.dialog {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  width: 320px;
  max-width: 90vw;
  box-shadow: var(--shadow-lg);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  border-bottom: 0.5px solid var(--border-subtle);
  font-weight: 600;
}

.dialog-header .action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.dialog-header .action-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dialog-body {
  padding: var(--space-md);
}

.dialog-input {
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: var(--font-weight-normal);
}

.dialog-input:focus {
  outline: none;
  border-color: var(--accent);
}

.dialog-message {
  color: var(--text-primary);
  margin-bottom: var(--space-sm);
}

.dialog-warning {
  color: var(--text-muted);
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding: var(--space-md);
  border-top: 0.5px solid var(--border-subtle);
}

.dialog-footer .btn-sm {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: var(--space-xs) var(--space-sm);
  font-size: 13px;
  height: 32px;
}

.dialog-footer .btn-danger {
  background: var(--error);
  color: white;
  border: none;
}

.dialog-footer .btn-danger:hover {
  background: #dc2626;
}

.dialog-footer .mr-1 {
  margin-right: 4px;
}

/* === Context Menu === */
.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
}

.context-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 1101;
  animation: contextIn 0.1s ease-out;
}

@keyframes contextIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.context-menu-item-wrapper {
  position: relative;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
  text-align: left;
}

.context-menu-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.context-menu-item.danger {
  color: var(--error);
}

.context-menu-item.danger:hover {
  background: var(--error-subtle);
}

.context-menu-arrow {
  margin-left: auto;
  opacity: 0.5;
}

.context-menu-divider {
  height: 0.5px;
  background: var(--border-subtle);
  margin: 4px 0;
}

.context-submenu {
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 160px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 1102;
}

.context-menu-empty {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

/* Context menu label */
.context-menu-label {
  padding: 4px 12px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Project tag items in context menu */
.project-tag-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.project-tag-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-tag-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.6;
  transition: all var(--transition-fast);
}

.project-tag-remove:hover {
  background: var(--bg-tertiary);
  color: var(--error);
  opacity: 1;
}

/* Toast notification */
.sidebar-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: 13px;
  box-shadow: var(--shadow-lg);
  z-index: 9999;
  white-space: nowrap;
}

.toast-enter-active {
  transition: all 0.25s ease;
}
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
