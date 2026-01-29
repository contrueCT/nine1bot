<script setup lang="ts">
import { ref } from 'vue'
import { ChevronsLeft, ChevronsRight, MessageSquare, Plus, Folder, MessagesSquare, Pencil, Trash2, X, Check } from 'lucide-vue-next'
import type { Session, FileItem } from '../api/client'
import FileTree from './FileTree.vue'

defineProps<{
  collapsed: boolean
  sessions: Session[]
  currentSession: Session | null
  files: FileItem[]
  filesLoading: boolean
  activeTab: 'sessions' | 'files'
}>()

const emit = defineEmits<{
  'toggle-collapse': []
  'select-session': [session: Session]
  'new-session': []
  'toggle-directory': [file: FileItem]
  'change-tab': [tab: 'sessions' | 'files']
  'delete-session': [sessionId: string]
  'rename-session': [sessionId: string, title: string]
}>()

// 重命名状态
const renamingSession = ref<Session | null>(null)
const newTitle = ref('')

// 删除确认状态
const deletingSession = ref<Session | null>(null)

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

function formatTime(session: Session): string {
  // 优先使用 createdAt，否则使用 time.created
  const timestamp = session.createdAt
    ? new Date(session.createdAt).getTime()
    : session.time?.created

  if (!timestamp) return ''

  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`
  return date.toLocaleDateString()
}

function getSessionTitle(session: Session): string {
  return session.title || `会话 ${session.id.slice(0, 6)}`
}
</script>

<template>
  <aside class="sidebar glass" :class="{ collapsed }">
    <div class="sidebar-header">
      <div class="brand-area" v-if="!collapsed">
        <div class="brand-logo">91</div>
        <span class="sidebar-logo">Nine1Bot</span>
      </div>
      <button class="btn btn-ghost btn-icon sm toggle-btn" @click="emit('toggle-collapse')" :title="collapsed ? '展开侧边栏' : '折叠侧边栏'">
        <ChevronsLeft v-if="!collapsed" :size="18" />
        <ChevronsRight v-else :size="18" />
      </button>
    </div>

    <div class="sidebar-tabs" v-if="!collapsed">
      <div class="tabs glass-tabs">
        <button
          class="tab"
          :class="{ active: activeTab === 'sessions' }"
          @click="emit('change-tab', 'sessions')"
        >
          <MessagesSquare :size="14" class="mr-1" /> 会话
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'files' }"
          @click="emit('change-tab', 'files')"
        >
          <Folder :size="14" class="mr-1" /> 文件
        </button>
      </div>
    </div>

    <div class="sidebar-content" v-if="!collapsed">
      <!-- Sessions Tab -->
      <div v-if="activeTab === 'sessions'" class="session-list">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="session-item"
          :class="{ active: currentSession?.id === session.id }"
          @click="emit('select-session', session)"
        >
          <div class="session-icon">
            <MessageSquare :size="16" />
          </div>
          <div class="session-item-content">
            <span class="session-item-title">{{ getSessionTitle(session) }}</span>
            <span class="session-item-time">{{ formatTime(session) }}</span>
          </div>
          <div class="session-actions" @click.stop>
            <button class="action-btn" @click="startRename(session, $event)" title="重命名">
              <Pencil :size="14" />
            </button>
            <button class="action-btn danger" @click="confirmDelete(session, $event)" title="删除">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <div v-if="sessions.length === 0" class="empty-state">
          <p class="text-muted text-sm">暂无会话</p>
        </div>
      </div>

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

      <!-- Files Tab -->
      <div v-if="activeTab === 'files'" class="files-container">
        <FileTree
          :files="files"
          :isLoading="filesLoading"
          @toggle="emit('toggle-directory', $event)"
        />
      </div>
    </div>

    <div class="sidebar-footer" v-if="!collapsed">
      <button class="btn btn-primary w-full new-chat-btn" @click="emit('new-session')">
        <Plus :size="18" class="mr-1" />
        <span>新建会话</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  /* Overriding general styles for specifics */
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-glass-strong);
}

.brand-area {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.brand-logo {
  width: 24px;
  height: 24px;
  background: var(--accent);
  color: white;
  border-radius: 6px;
  font-weight: bold;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 10px var(--accent-glow);
}

.sidebar-logo {
  font-weight: 600;
  letter-spacing: -0.5px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  height: var(--header-height);
}

.sidebar.collapsed .sidebar-header {
  justify-content: center;
  padding: var(--space-sm);
}

.glass-tabs {
  background: var(--bg-tertiary);
  padding: 4px;
  border-radius: var(--radius-md);
  display: flex;
  gap: 4px;
  border: none; /* Override global .tabs border */
  margin: 0;    /* Override global .tabs margin */
}

.tab {
  flex: 1;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  margin: 0; /* Override global .tab margin */
}

.tab.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.tab:hover:not(.active) {
  color: var(--text-primary);
}

.mr-1 { margin-right: 4px; }

.sidebar-tabs {
  padding: 0 var(--space-md) var(--space-sm);
}

.session-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin: 2px var(--space-sm);
  padding: var(--space-sm);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
  border: 1px solid transparent;
  cursor: pointer;
}

.session-item:hover {
  background: var(--bg-tertiary);
}

.session-item.active {
  background: var(--accent-subtle);
  border-color: var(--accent-subtle);
}

.session-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  flex-shrink: 0;
  transition: all var(--transition-fast);
}

.session-item:hover .session-icon {
  color: var(--text-secondary);
}

.session-item.active .session-icon {
  background: var(--accent);
  color: white;
  box-shadow: 0 2px 8px var(--accent-glow);
}

.session-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-item-title {
  font-weight: 500;
  font-size: 14px;
}

.files-container {
  padding: var(--space-xs);
}

.new-chat-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  font-weight: 600;
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  border: none;
  box-shadow: 0 4px 12px var(--accent-glow);
}

.new-chat-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px var(--accent-glow);
}

/* Session actions */
.session-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.session-item:hover .session-actions {
  opacity: 1;
}

.action-btn {
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

.action-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.action-btn.danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--error, #ef4444);
}

/* Dialog styles */
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
  background: var(--bg-primary);
  border: 1px solid var(--border);
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
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

.dialog-body {
  padding: var(--space-md);
}

.dialog-input {
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
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
  border-top: 1px solid var(--border);
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 13px;
  height: 32px;
}

.btn-danger {
  background: var(--error, #ef4444);
  color: white;
  border: none;
}

.btn-danger:hover {
  background: #dc2626;
}
</style>

