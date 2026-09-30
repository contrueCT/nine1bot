<script setup lang="ts">
import { ref, computed } from 'vue'
import { groupSessionsByProject } from '../utils/session-groups'
import {
  PanelLeftClose, PanelLeft, MessageSquare, Plus, Search,
  FolderOpen, Sparkles, Pencil, Trash2, X, Check,
  Loader2, Square, ChevronRight, User, Settings, EllipsisVertical, BarChart3, Webhook, LogOut
} from 'lucide-vue-next'
import type { Session, FileItem } from '../api/client'
import { useUserProfile } from '../composables/useUserProfile'

export interface ProjectInfo {
  id: string
  name?: string
  worktree: string
  rootDirectory?: string
  projectType?: 'git' | 'directory'
  icon?: { url?: string; override?: string; color?: string }
  instructions?: string
  time: { created: number; updated: number }
  sandboxes: string[]
}

type SidebarSession = Session & {
  projectDisplayName?: string
  projectDisplayPath?: string
}

const props = defineProps<{
  collapsed: boolean
  // 移动端（≤768px）抽屉式展开状态，由 App.vue 持有
  mobileOpen?: boolean
  sessions: SidebarSession[]
  sessionsLoading: boolean
  sessionsLoadError: boolean
  currentSession: Session | null
  isDraftSession: boolean
  files: FileItem[]
  filesLoading: boolean
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
  activePage: 'chat' | 'projects' | 'metrics' | 'automations'
  // WebUI 启用访问密码时才显示退出入口
  canLogout?: boolean
}>()

const emit = defineEmits<{
  'toggle-collapse': []
  'select-session': [session: Session]
  'new-session': []
  'project-new-session': [projectId: string]
  'toggle-directory': [file: FileItem]
  'delete-session': [sessionId: string]
  'rename-session': [sessionId: string, title: string]
  'file-click': [path: string]
  'abort-session': [sessionId: string]
  'open-settings': []
  'open-search': []
  'change-directory': [directory: string]
  'select-project': [projectId: string]
  'open-projects': []
  'open-metrics': []
  'open-automations': []
  'logout': []
}>()

// User profile
const { profile, brandLogo } = useUserProfile()

// Sections collapse state
const showRecents = ref(true)

// 重命名状态
const renamingSession = ref<SidebarSession | null>(null)
const newTitle = ref('')

// 删除确认状态
const deletingSession = ref<SidebarSession | null>(null)

// Right-click context menu
const contextMenu = ref<{ x: number; y: number; session: SidebarSession } | null>(null)
const collapsedProjects = ref<Record<string, boolean>>({})
const sessionGroups = computed(() => groupSessionsByProject(props.sessions, props.projects))

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

function isBrowserExtensionSession(session: SidebarSession): boolean {
  return session.client?.source === 'browser-extension'
}

// Context menu handlers
function openContextMenu(event: MouseEvent, session: SidebarSession) {
  event.preventDefault()
  event.stopPropagation()
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    session
  }
}

function closeContextMenu() {
  contextMenu.value = null
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

</script>

<template>
  <aside class="sidebar" :class="{ collapsed, open: mobileOpen }">
    <!-- Header: Brand + Collapse -->
    <div class="sidebar-header">
      <div class="brand-area" v-if="!collapsed">
        <img v-if="brandLogo.logoUrl" :src="brandLogo.logoUrl" alt="Nine1Bot" class="brand-logo" />
        <span class="brand-text">Nine1Bot</span>
      </div>
      <button class="collapse-btn" @click="emit('toggle-collapse')" :title="mobileOpen ? '关闭侧边栏' : collapsed ? '展开' : '折叠'" :aria-label="mobileOpen ? '关闭侧边栏' : collapsed ? '展开侧边栏' : '折叠侧边栏'">
        <PanelLeftClose v-if="!collapsed" :size="18" />
        <PanelLeft v-else :size="18" />
      </button>
    </div>

    <!-- Top Navigation (expanded) -->
    <nav class="sidebar-nav" v-if="!collapsed">
      <button class="nav-item new-chat" @click="emit('new-session')">
        <Plus :size="18" />
        <span>新会话</span>
      </button>
      <button class="nav-item" @click="emit('open-search')">
        <Search :size="18" />
        <span>搜索</span>
      </button>
      <button class="nav-item" :class="{ active: activePage === 'projects' }" @click="emit('open-projects')">
        <FolderOpen :size="18" />
        <span>项目</span>
      </button>
      <button class="nav-item" :class="{ active: activePage === 'metrics' }" @click="emit('open-metrics')">
        <BarChart3 :size="18" />
        <span>统计</span>
      </button>
      <button class="nav-item" :class="{ active: activePage === 'automations' }" @click="emit('open-automations')">
        <Webhook :size="18" />
        <span>自动化</span>
      </button>
    </nav>

    <!-- Top Navigation (collapsed) -->
    <nav class="sidebar-nav sidebar-nav-collapsed" v-if="collapsed">
      <button class="nav-item-icon" @click="emit('new-session')" title="新会话" aria-label="新会话">
        <Plus :size="18" />
      </button>
      <button class="nav-item-icon" @click="emit('open-search')" title="搜索" aria-label="搜索">
        <Search :size="18" />
      </button>
      <button class="nav-item-icon" :class="{ active: activePage === 'projects' }" @click="emit('open-projects')" title="项目" aria-label="项目">
        <FolderOpen :size="18" />
      </button>
      <button class="nav-item-icon" :class="{ active: activePage === 'metrics' }" @click="emit('open-metrics')" title="统计" aria-label="统计">
        <BarChart3 :size="18" />
      </button>
      <button class="nav-item-icon" :class="{ active: activePage === 'automations' }" @click="emit('open-automations')" title="自动化" aria-label="自动化">
        <Webhook :size="18" />
      </button>
    </nav>

    <!-- Recents Section -->
    <div class="sidebar-section" v-if="!collapsed">
      <button type="button" class="section-header" :aria-expanded="showRecents" @click="showRecents = !showRecents">
        <span class="section-label">会话</span>
        <ChevronRight :size="14" class="section-chevron" :class="{ expanded: showRecents }" />
      </button>

      <div v-if="showRecents" class="section-list">
        <!-- Draft Session -->
        <div
          v-if="isDraftSession"
          class="session-item active"
        >
          <Sparkles :size="14" class="session-icon" />
          <span class="session-title">新会话</span>
        </div>

        <section v-for="group in sessionGroups" :key="group.id" class="project-session-group">
          <div class="project-group-heading">
            <button class="project-group-toggle" :aria-expanded="!collapsedProjects[group.id]" :title="group.directory" @click="collapsedProjects[group.id] = !collapsedProjects[group.id]">
              <ChevronRight :size="12" :class="{ expanded: !collapsedProjects[group.id] }" />
              <FolderOpen :size="16" />
              <span>{{ group.name }}</span>
              <span class="project-session-count">{{ group.sessions.length }}</span>
            </button>
            <button v-if="group.projectId" class="mini-btn project-new" :title="'在 ' + group.name + ' 中新建会话'" :aria-label="'在 ' + group.name + ' 中新建会话'" @click="emit('project-new-session', group.projectId)"><Plus :size="14" /></button>
          </div>
          <div v-show="!collapsedProjects[group.id]" class="project-session-children">
        <!-- Sessions in this project -->
        <div
          v-for="session in group.sessions"
          :key="session.id"
          class="session-item"
          :class="{
            active: !isDraftSession && currentSession?.id === session.id,
            running: isSessionRunning(session.id)
          }"
          role="button" tabindex="0"
          @keydown.enter.self="emit('select-session', session)"
          @keydown.space.self.prevent="emit('select-session', session)"
          @click="emit('select-session', session)"
          @contextmenu="openContextMenu($event, session)"
        >
          <Loader2 v-if="isSessionRunning(session.id)" :size="14" class="session-icon spin" />
          <MessageSquare v-else :size="14" class="session-icon" />
          <span class="session-title">{{ getSessionTitle(session) }}</span>
          <span v-if="isBrowserExtensionSession(session)" class="session-source-badge">浏览器</span>


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
            <button class="mini-btn" @click="openContextMenu($event, session)" title="更多操作" aria-label="更多操作">
              <EllipsisVertical :size="14" />
            </button>
          </div>
        </div>

          <div v-if="!group.sessions.length" class="project-empty">暂无会话</div>
          </div>
        </section>
        <!-- Empty session list -->
        <div v-if="sessions.length === 0 && (sessionsLoading || sessionsLoadError || !isDraftSession)" class="empty-state section-empty">
          {{ sessionsLoading ? '正在加载会话...' : sessionsLoadError ? '加载失败，正在重试...' : '暂无会话' }}
        </div>
      </div>
    </div>

    <div class="sidebar-spacer"></div>

    <!-- User Profile Footer -->
    <div class="sidebar-footer" v-if="!collapsed">
      <button class="user-profile" @click="emit('open-settings')" aria-label="打开设置" title="设置">
        <div class="user-avatar">
          <img v-if="profile.avatarUrl" :src="profile.avatarUrl" alt="头像" class="avatar-img" />
          <User v-else :size="16" />
        </div>
        <div class="user-info">
          <span class="user-name">{{ profile.name || '用户' }}</span>
          <span class="user-plan">设置与偏好</span>
        </div>
        <Settings :size="16" class="settings-icon" />
      </button>
      <!-- 原来是悬浮在页面右下角的按钮，会压住输入框和「回到最新」 -->
      <button v-if="canLogout" class="footer-logout" type="button" title="退出登录" aria-label="退出登录" @click="emit('logout')">
        <LogOut :size="15" />
      </button>
    </div>

    <!-- Collapsed Footer (avatar only) -->
    <div class="sidebar-footer sidebar-footer-collapsed" v-if="collapsed">
      <button class="nav-item-icon" @click="emit('open-settings')" title="设置" aria-label="设置">
        <User :size="18" />
      </button>
      <button v-if="canLogout" class="nav-item-icon" @click="emit('logout')" title="退出登录" aria-label="退出登录">
        <LogOut :size="16" />
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

  </Teleport>
</template>

<style scoped>
.project-group-heading { display: flex; align-items: center; gap: 4px; margin: 12px 0 4px; }
.project-group-toggle { min-width: 0; flex: 1; display: flex; align-items: center; gap: 7px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); padding: 6px 4px; cursor: pointer; text-align: left; font-family: var(--font-sans); font-size: var(--text-13); font-weight: 500; }
.project-group-toggle:hover { background: var(--hover-overlay); color: var(--text-primary); }
.project-group-toggle > span:first-of-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-group-toggle svg { flex-shrink: 0; }
.project-group-toggle .expanded { transform: rotate(90deg); }
.project-session-count { margin-left: auto; font-size: var(--text-xs); font-weight: 400; color: var(--text-muted); }
/* 会话挂在项目下的一条细轨上，和对话区「过程」的左轨是同一种层级语言 */
.project-session-children { margin-left: 10px; padding-left: 8px; border-left: 1px solid var(--border-default); }
.project-session-children .session-item { padding-left: 10px; }
.project-session-children .session-icon:not(.spin) { display: none; }
.project-empty { color: var(--text-muted); padding: 8px 12px; font-size: var(--text-sm); }
.project-new { flex-shrink: 0; }
.session-item:focus-within .session-actions { opacity: 1; transform: none; }

/* === Sidebar (base layout lives in global style.css) === */
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
  font-size: var(--text-md);
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
  font-size: var(--text-base);
  font-weight: var(--font-weight-normal);
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--transition-fast);
  width: 100%;
}

.nav-item:hover {
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.nav-item:active {
  background: var(--active-overlay);
}

.nav-item.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.nav-item.active svg {
  opacity: 1;
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
  width: 100%;
  margin-top: var(--space-sm);
  padding: var(--space-xs) var(--space-md);
  border: 0;
  background: transparent;
  font-family: var(--font-sans);
  cursor: pointer;
}

.section-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
}

.section-header:hover .section-label {
  color: var(--text-secondary);
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

/* Compact variant of the global .empty-state for the session list */
.section-empty {
  padding: var(--space-md) var(--space-sm);
  font-size: var(--text-sm);
}

/* === Session Items (base .session-item lives in global style.css) === */
.session-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.session-item.active .session-icon {
  color: var(--text-primary);
}

.session-title {
  flex: 1;
  font-size: var(--text-13);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.session-project-label {
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  padding: 0 8px;
  line-height: 18px;
  opacity: 0;
  transform: translateX(6px);
  transition: opacity var(--transition-fast), transform var(--transition-fast), filter var(--transition-fast);
  margin-left: 6px;
  filter: saturate(80%);
  pointer-events: none;
}

.session-source-badge {
  flex-shrink: 0;
  max-width: 70px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--info);
  background: var(--info-subtle);
  border: 1px solid color-mix(in srgb, var(--info) 18%, transparent);
  border-radius: var(--radius-full);
  padding: 0 7px;
  line-height: 17px;
}

.session-item:hover .session-project-label {
  opacity: 1;
  transform: translateX(0);
  filter: saturate(100%);
}

.session-item.active .session-title {
  color: var(--text-primary);
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
  transform: translateX(4px);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.session-item:hover .session-actions {
  opacity: 1;
  transform: translateX(0);
}

/* 触屏设备没有 hover，会话操作按钮始终可见 */
@media (hover: none) {
  .session-actions {
    opacity: 1;
    transform: none;
  }
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
  background: var(--active-overlay);
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

/* === User Profile Footer (base .sidebar-footer lives in global style.css) === */
.sidebar-footer:not(.sidebar-footer-collapsed) {
  display: flex;
  align-items: center;
  gap: 2px;
}

.footer-logout {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.footer-logout:hover {
  background: var(--hover-overlay);
  color: var(--error);
}

.user-profile {
  flex: 1;
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.settings-icon { margin-left: auto; color: var(--text-muted); }

.user-profile:hover {
  background: var(--hover-overlay);
}

.user-avatar {
  flex-shrink: 0;
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
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.user-name {
  font-size: var(--text-13);
  font-weight: 500;
  color: var(--text-primary);
}

.user-plan {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

/* === Animations === */
.spin {
  animation: spin 1s linear infinite;
}

/* === Collapsed State (base rules live in global style.css) === */
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
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.nav-item-icon.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

/* === Collapsed Footer === */
.sidebar-footer-collapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  justify-content: center;
  padding: var(--space-sm) 0;
  border-top: 1px solid var(--border-subtle);
}

</style>

<!-- 非 scoped 样式，用于 Teleport 的对话框 -->
<style>
/* === Context Menu === */
.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-context-overlay);
}

.context-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: var(--z-context-menu);
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
  font-size: var(--text-13);
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
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

.context-submenu {
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 160px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: var(--z-context-submenu);
}

.context-menu-empty {
  padding: 8px 12px;
  font-size: var(--text-sm);
  color: var(--text-muted);
  text-align: center;
}

/* Context menu label */
.context-menu-label {
  padding: 4px 12px 2px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
}

/* Project tag items in context menu */
.project-tag-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: var(--text-sm);
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

</style>
