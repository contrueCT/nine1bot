<script setup lang="ts">
import { ref, computed } from 'vue'
import { 
  PanelLeftClose, PanelLeft, MessageSquare, Plus, Search, 
  FolderOpen, Code2, Sparkles, Pencil, Trash2, X, Check, 
  Loader2, Square, ChevronRight, User
} from 'lucide-vue-next'
import type { Session, FileItem } from '../api/client'

const props = defineProps<{
  collapsed: boolean
  sessions: Session[]
  currentSession: Session | null
  isDraftSession: boolean
  files: FileItem[]
  filesLoading: boolean
  activeNav: 'chats' | 'projects' | 'code'
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
  'change-nav': [nav: 'chats' | 'projects' | 'code']
  'delete-session': [sessionId: string]
  'rename-session': [sessionId: string, title: string]
  'file-click': [path: string]
  'abort-session': [sessionId: string]
  'open-settings': []
  'open-search': []
  'change-directory': [directory: string]
}>()

// 当前展开的 Recents 区域
const showRecents = ref(true)

// 重命名状态
const renamingSession = ref<Session | null>(null)
const newTitle = ref('')

// 删除确认状态
const deletingSession = ref<Session | null>(null)

// 最近的会话（只显示前5个）
const recentSessions = computed(() => {
  return props.sessions.slice(0, 8)
})

function startRename(session: Session, event: Event) {
  event.stopPropagation()
  renamingSession.value = session
  newTitle.value = session.title || `会话 ${session.id.slice(0, 6)}`
}

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

function confirmDelete(session: Session, event: Event) {
  event.stopPropagation()
  deletingSession.value = session
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
</script>

<template>
  <aside class="sidebar claude-style" :class="{ collapsed }">
    <!-- Header: Brand + Collapse -->
    <div class="sidebar-header">
      <div class="brand-area" v-if="!collapsed">
        <span class="brand-text">Nine1Bot</span>
      </div>
      <button class="collapse-btn" @click="emit('toggle-collapse')" :title="collapsed ? '展开' : '折叠'">
        <PanelLeftClose v-if="!collapsed" :size="18" />
        <PanelLeft v-else :size="18" />
      </button>
    </div>

    <!-- Navigation Menu (Claude style) -->
    <nav class="sidebar-nav" v-if="!collapsed">
      <!-- New Chat -->
      <button class="nav-item new-chat" @click="emit('new-session')">
        <Plus :size="18" />
        <span>New chat</span>
      </button>

      <!-- Search -->
      <button class="nav-item" @click="emit('open-search')">
        <Search :size="18" />
        <span>Search</span>
      </button>

      <!-- Chats -->
      <button
        class="nav-item"
        :class="{ active: activeNav === 'chats' }"
        @click="emit('change-nav', 'chats')"
      >
        <MessageSquare :size="18" />
        <span>Chats</span>
      </button>

      <!-- Projects -->
      <button
        class="nav-item"
        :class="{ active: activeNav === 'projects' }"
        @click="emit('change-nav', 'projects')"
      >
        <FolderOpen :size="18" />
        <span>Projects</span>
      </button>

      <!-- Code -->
      <button
        class="nav-item"
        :class="{ active: activeNav === 'code' }"
        @click="emit('change-nav', 'code')"
      >
        <Code2 :size="18" />
        <span>Code</span>
      </button>
    </nav>

    <!-- Recents Section -->
    <div class="sidebar-recents" v-if="!collapsed">
      <div class="recents-header" @click="showRecents = !showRecents">
        <span class="recents-label">Recents</span>
        <ChevronRight :size="14" class="recents-chevron" :class="{ expanded: showRecents }" />
      </div>

      <div v-if="showRecents" class="recents-list">
        <!-- Draft Session -->
        <div
          v-if="isDraftSession"
          class="recent-item active"
        >
          <Sparkles :size="14" class="recent-icon" />
          <span class="recent-title">新对话</span>
        </div>

        <!-- Recent Sessions -->
        <div
          v-for="session in recentSessions"
          :key="session.id"
          class="recent-item"
          :class="{ 
            active: !isDraftSession && currentSession?.id === session.id,
            running: isSessionRunning(session.id)
          }"
          @click="emit('select-session', session)"
        >
          <Loader2 v-if="isSessionRunning(session.id)" :size="14" class="recent-icon spin" />
          <MessageSquare v-else :size="14" class="recent-icon" />
          <span class="recent-title">{{ getSessionTitle(session) }}</span>
          
          <!-- Session Actions (on hover) -->
          <div class="recent-actions" @click.stop>
            <button
              v-if="isSessionRunning(session.id)"
              class="mini-btn abort"
              @click="emit('abort-session', session.id)"
              title="停止"
            >
              <Square :size="10" fill="currentColor" />
            </button>
            <button class="mini-btn" @click="startRename(session, $event)" title="重命名">
              <Pencil :size="10" />
            </button>
            <button class="mini-btn danger" @click="confirmDelete(session, $event)" title="删除">
              <Trash2 :size="10" />
            </button>
          </div>
        </div>

        <!-- View All Link -->
        <button 
          v-if="sessions.length > 8" 
          class="view-all-btn"
          @click="emit('change-nav', 'chats')"
        >
          查看全部 {{ sessions.length }} 个会话
        </button>
      </div>
    </div>

    <!-- User Profile Footer (Claude style) -->
    <div class="sidebar-footer" v-if="!collapsed">
      <div class="user-profile" @click="emit('open-settings')">
        <div class="user-avatar">
          <User :size="16" />
        </div>
        <div class="user-info">
          <span class="user-name">用户</span>
          <span class="user-plan">Nine1Bot</span>
        </div>
      </div>
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
  </Teleport>
</template>

<style scoped>
/* === Claude-Style Sidebar === */
.sidebar.claude-style {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-secondary);
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

.nav-item.active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.nav-item.new-chat {
  color: var(--text-primary);
  font-weight: 500;
}

.nav-item svg {
  flex-shrink: 0;
  opacity: 0.7;
}

.nav-item:hover svg,
.nav-item.active svg {
  opacity: 1;
}

/* === Recents Section === */
.sidebar-recents {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: var(--space-sm) 0;
}

.recents-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-xs) var(--space-md);
  cursor: pointer;
}

.recents-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.recents-chevron {
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

.recents-chevron.expanded {
  transform: rotate(90deg);
}

.recents-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-xs) var(--space-sm);
}

.recent-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px var(--space-sm);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  position: relative;
}

.recent-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.recent-item.active {
  background: var(--accent-subtle);
}

.recent-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.recent-item.active .recent-icon {
  color: var(--accent);
}

.recent-title {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-item.active .recent-title {
  color: var(--accent);
  font-weight: 500;
}

.recent-item.running .recent-icon {
  color: var(--accent);
}

/* Mini action buttons */
.recent-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.recent-item:hover .recent-actions {
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

.view-all-btn {
  width: 100%;
  padding: 6px;
  margin-top: var(--space-xs);
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  text-align: center;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.view-all-btn:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--text-primary);
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
  width: var(--sidebar-collapsed-width);
}

.sidebar.collapsed .sidebar-header {
  justify-content: center;
  padding: var(--space-sm);
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
</style>

