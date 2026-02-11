<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Plus, Search, FolderOpen, Clock, ArrowLeft, MessageSquare, Save, Pencil, Check, X, Folder, Trash2, Globe, FolderMinus, EllipsisVertical } from 'lucide-vue-next'
import { api } from '../api/client'
import type { Session } from '../api/client'
import type { ProjectInfo } from './Sidebar.vue'
import { usePreferences } from '../composables/usePreferences'
import { useSessionMode } from '../composables/useSessionMode'
import DirectoryBrowser from './DirectoryBrowser.vue'

const props = defineProps<{
  projects: ProjectInfo[]
  currentProject: ProjectInfo | null
}>()

const emit = defineEmits<{
  selectProject: [projectId: string]
  updateProject: [projectId: string, updates: { name?: string; instructions?: string }]
  selectSession: [sessionId: string]
  newSession: [projectId: string]
  createProject: [name: string, instructions: string, directory?: string]
  deleteProject: [projectId: string]
  renameSession: [sessionId: string, title: string]
  deleteSession: [sessionId: string]
  close: []
}>()

// Search
const searchQuery = ref('')

// Create project dialog
const showCreateDialog = ref(false)
const newProjectName = ref('')
const newProjectInstructions = ref('')
const newProjectDirectory = ref('')
const showDirectoryBrowser = ref(false)

// Preferences for Effective Prompt
const { globalPreferences, loadPreferences: loadPrefs } = usePreferences()
const { removeSessionFromProject, getSessionsForProject } = useSessionMode()

// Delete project confirmation
const showDeleteConfirm = ref(false)

// Session context menu
const sessionContextMenu = ref<{ x: number; y: number; session: Session } | null>(null)
const isRenamingSession = ref<string | null>(null)
const renameSessionTitle = ref('')

// Detail view state
const isEditingName = ref(false)
const editName = ref('')
const instructions = ref('')
const isSaving = ref(false)
const sessions = ref<Session[]>([])
const isLoadingSessions = ref(false)

// Filtered projects
const filteredProjects = computed(() => {
  if (!searchQuery.value.trim()) return props.projects
  const q = searchQuery.value.toLowerCase()
  return props.projects.filter(p => {
    const name = getProjectName(p).toLowerCase()
    const desc = (p.instructions || '').toLowerCase()
    return name.includes(q) || desc.includes(q)
  })
})

// Watch current project changes for detail view
watch(() => props.currentProject, (project) => {
  if (project) {
    instructions.value = project.instructions || ''
    editName.value = project.name || ''
    loadSessions()
  }
}, { immediate: true })

async function loadSessions() {
  if (!props.currentProject) return
  isLoadingSessions.value = true
  try {
    // All projects use localStorage sessionMode mapping as single source of truth
    // (Backend auto-assigns projectID to ALL sessions, making it unreliable)
    const sessionIds = getSessionsForProject(props.currentProject.id)
    if (sessionIds.length === 0) {
      sessions.value = []
    } else {
      const allSessions = await api.getSessions()
      sessions.value = allSessions.filter(s => sessionIds.includes(s.id))
    }
  } catch (e) {
    console.error('Failed to load project sessions:', e)
  } finally {
    isLoadingSessions.value = false
  }
}

function handleCreateProject() {
  if (!newProjectName.value.trim()) return
  emit('createProject', newProjectName.value.trim(), newProjectInstructions.value.trim(), newProjectDirectory.value || undefined)
  newProjectName.value = ''
  newProjectInstructions.value = ''
  newProjectDirectory.value = ''
  showCreateDialog.value = false
}

function pickDirectory() {
  showDirectoryBrowser.value = true
}

function handleDirectorySelect(path: string) {
  showDirectoryBrowser.value = false
  newProjectDirectory.value = path
}

function handleDirectoryCancel() {
  showDirectoryBrowser.value = false
}

function startEditName() {
  editName.value = getProjectName(props.currentProject!)
  isEditingName.value = true
}

function cancelEditName() {
  isEditingName.value = false
}

function saveName() {
  if (editName.value.trim() && props.currentProject) {
    emit('updateProject', props.currentProject.id, { name: editName.value.trim() })
  }
  isEditingName.value = false
}

async function saveInstructions() {
  if (!props.currentProject) return
  isSaving.value = true
  try {
    emit('updateProject', props.currentProject.id, { instructions: instructions.value })
  } finally {
    setTimeout(() => { isSaving.value = false }, 500)
  }
}

function getProjectName(project: ProjectInfo): string {
  return project.name || project.worktree.split('/').pop() || project.id.slice(0, 8)
}

function getSessionTitle(session: Session): string {
  return session.title || `会话 ${session.id.slice(0, 6)}`
}

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  const months = Math.floor(days / 30)

  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  if (months < 1) return `${Math.floor(days / 7)}w ago`
  return `Updated ${months} month${months > 1 ? 's' : ''} ago`
}

function isLocalProject(project: ProjectInfo): boolean {
  return project.id.startsWith('local-')
}

function confirmDeleteProject() {
  if (props.currentProject) {
    emit('deleteProject', props.currentProject.id)
    showDeleteConfirm.value = false
  }
}

function getProjectDescription(project: ProjectInfo): string {
  return project.instructions
    ? project.instructions.length > 100 ? project.instructions.slice(0, 100) + '...' : project.instructions
    : ''
}

// Session context menu
function openSessionContextMenu(e: MouseEvent, session: Session) {
  e.preventDefault()
  sessionContextMenu.value = { x: e.clientX, y: e.clientY, session }
}

function closeSessionContextMenu() {
  sessionContextMenu.value = null
}

function contextMenuRenameSession() {
  if (!sessionContextMenu.value) return
  const session = sessionContextMenu.value.session
  isRenamingSession.value = session.id
  renameSessionTitle.value = session.title || ''
  closeSessionContextMenu()
}

function saveSessionRename(sessionId: string) {
  if (renameSessionTitle.value.trim()) {
    emit('renameSession', sessionId, renameSessionTitle.value.trim())
    // Update local state
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.title = renameSessionTitle.value.trim()
  }
  isRenamingSession.value = null
  renameSessionTitle.value = ''
}

function cancelSessionRename() {
  isRenamingSession.value = null
  renameSessionTitle.value = ''
}

function contextMenuRemoveFromProject() {
  if (!sessionContextMenu.value || !props.currentProject) return
  const sessionId = sessionContextMenu.value.session.id
  removeSessionFromProject(sessionId, props.currentProject.id)
  // Remove from local list
  sessions.value = sessions.value.filter(s => s.id !== sessionId)
  closeSessionContextMenu()
}

function contextMenuDeleteSession() {
  if (!sessionContextMenu.value) return
  const sessionId = sessionContextMenu.value.session.id
  emit('deleteSession', sessionId)
  sessions.value = sessions.value.filter(s => s.id !== sessionId)
  closeSessionContextMenu()
}

// Effective Prompt — combined global preferences + project instructions
const effectivePrompt = computed(() => {
  const parts: string[] = []

  // Global preferences
  if (globalPreferences.value.length > 0) {
    parts.push('## Global Preferences')
    globalPreferences.value.forEach(p => {
      parts.push(`- ${p.content}`)
    })
  }

  // Project instructions
  if (props.currentProject?.instructions) {
    if (parts.length > 0) parts.push('')
    parts.push('## Project Instructions')
    parts.push(props.currentProject.instructions)
  }

  return parts.join('\n')
})

// Load preferences when project detail view opens
watch(() => props.currentProject, (project) => {
  if (project) {
    loadPrefs()
  }
})
</script>

<template>
  <div class="projects-page">
    <!-- Project Detail View -->
    <template v-if="currentProject">
      <div class="projects-detail-content">
        <!-- Back button -->
        <button class="back-btn" @click="emit('selectProject', '')">
          <ArrowLeft :size="16" />
          <span>Back to Projects</span>
        </button>

        <!-- Project Header -->
        <div class="project-header">
          <div class="project-header-icon">
            <FolderOpen :size="24" />
          </div>
          <div class="project-header-info">
            <div v-if="isEditingName" class="project-name-edit">
              <input
                v-model="editName"
                type="text"
                class="project-name-input"
                @keyup.enter="saveName"
                @keyup.escape="cancelEditName"
                autofocus
              />
              <button class="icon-btn" @click="saveName"><Check :size="14" /></button>
              <button class="icon-btn" @click="cancelEditName"><X :size="14" /></button>
            </div>
            <div v-else class="project-name-display">
              <h2 class="project-name-text">{{ getProjectName(currentProject) }}</h2>
              <button class="icon-btn" @click="startEditName"><Pencil :size="14" /></button>
              <button v-if="isLocalProject(currentProject)" class="icon-btn danger-icon" @click="showDeleteConfirm = true" title="删除项目">
                <Trash2 :size="14" />
              </button>
            </div>
            <span class="project-path">{{ currentProject.worktree }}</span>
          </div>
        </div>

        <!-- Instructions Section -->
        <div class="project-section">
          <div class="project-section-header">
            <h3 class="project-section-title">Project Instructions</h3>
          </div>
          <p class="project-section-desc">These instructions will be shared across all sessions in this project.</p>
          <textarea
            v-model="instructions"
            class="project-instructions-input"
            placeholder="Enter instructions for this project... (e.g., 'You are a helpful assistant. Always respond in Chinese.')"
            rows="6"
          ></textarea>
          <div class="project-section-actions">
            <button class="btn btn-primary btn-sm" @click="saveInstructions" :disabled="isSaving">
              <Save :size="14" />
              <span>{{ isSaving ? 'Saving...' : 'Save' }}</span>
            </button>
          </div>
        </div>

        <!-- Sessions Section -->
        <div class="project-section">
          <div class="project-section-header">
            <h3 class="project-section-title">Sessions</h3>
            <button class="btn btn-ghost btn-sm" @click="emit('newSession', currentProject.id)">
              <Plus :size="14" />
              <span>New Session</span>
            </button>
          </div>

          <div v-if="isLoadingSessions" class="sessions-loading">
            Loading sessions...
          </div>

          <div v-else-if="sessions.length === 0" class="sessions-empty">
            No sessions in this project yet. Create one to get started.
          </div>

          <div v-else class="sessions-list">
            <div
              v-for="session in sessions"
              :key="session.id"
              class="session-row"
              @click="isRenamingSession !== session.id && emit('selectSession', session.id)"
              @contextmenu.prevent="openSessionContextMenu($event, session)"
            >
              <MessageSquare :size="14" class="session-row-icon" />
              <!-- Rename inline -->
              <template v-if="isRenamingSession === session.id">
                <input
                  v-model="renameSessionTitle"
                  class="session-rename-input"
                  @click.stop
                  @keyup.enter="saveSessionRename(session.id)"
                  @keyup.escape="cancelSessionRename"
                  autofocus
                />
                <button class="icon-btn" @click.stop="saveSessionRename(session.id)"><Check :size="12" /></button>
                <button class="icon-btn" @click.stop="cancelSessionRename"><X :size="12" /></button>
              </template>
              <template v-else>
                <span class="session-row-title">{{ getSessionTitle(session) }}</span>
                <span class="session-row-time">
                  <Clock :size="12" />
                  {{ formatTime(session.time.updated) }}
                </span>
                <div class="session-row-actions" @click.stop>
                  <button class="session-action-btn" @click="openSessionContextMenu($event, session)" title="更多操作">
                    <EllipsisVertical :size="14" />
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
        <!-- Effective Prompt Section -->
        <div v-if="effectivePrompt" class="project-section">
          <div class="project-section-header">
            <h3 class="project-section-title">
              <Globe :size="14" style="vertical-align: -2px; margin-right: 4px;" />
              Effective Prompt
            </h3>
          </div>
          <p class="project-section-desc">
            Combined view of global preferences and project instructions that will be applied to all sessions.
          </p>
          <div class="effective-prompt-preview">
            <pre class="effective-prompt-text">{{ effectivePrompt }}</pre>
          </div>
        </div>
      </div>
    </template>

    <!-- Projects List View -->
    <template v-else>
      <div class="projects-list-content">
        <!-- Header -->
        <div class="projects-list-header">
          <h1 class="projects-title">Projects</h1>
          <button class="btn btn-primary create-project-btn" @click="showCreateDialog = true">
            <Plus :size="16" />
            <span>New project</span>
          </button>
        </div>

        <!-- Search -->
        <div class="projects-search-wrapper">
          <Search :size="16" class="projects-search-icon" />
          <input
            v-model="searchQuery"
            type="text"
            class="projects-search-input"
            placeholder="Search projects..."
          />
        </div>

        <!-- Projects Grid -->
        <div v-if="filteredProjects.length > 0" class="projects-grid">
          <div
            v-for="project in filteredProjects"
            :key="project.id"
            class="project-card"
            @click="emit('selectProject', project.id)"
          >
            <h3 class="project-card-name">{{ getProjectName(project) }}</h3>
            <p v-if="getProjectDescription(project)" class="project-card-desc">
              {{ getProjectDescription(project) }}
            </p>
            <span class="project-card-time">{{ formatTime(project.time.updated) }}</span>
          </div>
        </div>

        <div v-else-if="searchQuery" class="projects-empty">
          <p>No projects matching "{{ searchQuery }}"</p>
        </div>

        <div v-else class="projects-empty">
          <FolderOpen :size="48" class="empty-icon" />
          <p class="empty-title">No projects yet</p>
          <p class="empty-desc">Projects let you organize conversations with shared instructions and context.</p>
          <button class="btn btn-primary" @click="showCreateDialog = true">
            <Plus :size="16" />
            <span>Create your first project</span>
          </button>
        </div>
      </div>
    </template>

    <!-- Create Project Dialog -->
    <Teleport to="body">
      <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
        <div class="create-project-dialog" @click.stop>
          <div class="dialog-header">
            <span>Create new project</span>
            <button class="action-btn" @click="showCreateDialog = false">
              <X :size="16" />
            </button>
          </div>
          <div class="dialog-body">
            <div class="form-group">
              <label class="form-label">Project name</label>
              <input
                v-model="newProjectName"
                type="text"
                class="dialog-input"
                placeholder="My Project"
                @keyup.enter="handleCreateProject"
                autofocus
              />
            </div>
            <div class="form-group">
              <label class="form-label">Working directory (optional)</label>
              <div class="directory-picker-row">
                <button class="directory-pick-btn" @click="pickDirectory">
                  <Folder :size="14" />
                  <span>{{ newProjectDirectory || 'Choose directory' }}</span>
                </button>
                <button v-if="newProjectDirectory" class="icon-btn" @click="newProjectDirectory = ''">
                  <X :size="14" />
                </button>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Instructions (optional)</label>
              <textarea
                v-model="newProjectInstructions"
                class="dialog-textarea"
                placeholder="Add custom instructions for this project..."
                rows="4"
              ></textarea>
            </div>
          </div>
          <div class="dialog-footer">
            <button class="btn btn-ghost btn-sm" @click="showCreateDialog = false">Cancel</button>
            <button class="btn btn-primary btn-sm" @click="handleCreateProject" :disabled="!newProjectName.trim()">
              Create project
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Project Confirmation Dialog -->
    <Teleport to="body">
      <div v-if="showDeleteConfirm" class="dialog-overlay" @click="showDeleteConfirm = false">
        <div class="dialog" @click.stop>
          <div class="dialog-header">
            <span>删除项目</span>
            <button class="action-btn" @click="showDeleteConfirm = false">
              <X :size="16" />
            </button>
          </div>
          <div class="dialog-body">
            <p class="dialog-message">确定要删除项目 "{{ currentProject ? getProjectName(currentProject) : '' }}" 吗？</p>
            <p class="dialog-warning">项目下的会话不会被删除，但会解除与项目的关联。</p>
          </div>
          <div class="dialog-footer">
            <button class="btn btn-ghost btn-sm" @click="showDeleteConfirm = false">取消</button>
            <button class="btn btn-danger btn-sm" @click="confirmDeleteProject">
              <Trash2 :size="14" />
              删除
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Session Context Menu -->
    <Teleport to="body">
      <div
        v-if="sessionContextMenu"
        class="context-menu-overlay"
        @click="closeSessionContextMenu"
        @contextmenu.prevent="closeSessionContextMenu"
      >
        <div
          class="context-menu"
          :style="{ left: sessionContextMenu.x + 'px', top: sessionContextMenu.y + 'px' }"
          @click.stop
        >
          <button class="context-menu-item" @click="contextMenuRenameSession">
            <Pencil :size="14" />
            <span>重命名</span>
          </button>
          <button class="context-menu-item" @click="contextMenuRemoveFromProject">
            <FolderMinus :size="14" />
            <span>移出项目</span>
          </button>
          <div class="context-menu-divider"></div>
          <button class="context-menu-item danger" @click="contextMenuDeleteSession">
            <Trash2 :size="14" />
            <span>删除</span>
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Directory Browser -->
    <DirectoryBrowser
      :visible="showDirectoryBrowser"
      @select="handleDirectorySelect"
      @cancel="handleDirectoryCancel"
    />
  </div>
</template>

<style scoped>
.projects-page {
  flex: 1;
  overflow-y: auto;
  height: 100%;
}

/* === List View === */
.projects-list-content {
  max-width: 900px;
  margin: 0 auto;
  padding: 48px var(--space-lg) 24px;
}

.projects-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-lg);
}

.projects-title {
  font-family: var(--font-serif);
  font-size: 2rem;
  font-weight: 400;
  color: var(--text-primary);
  margin: 0;
}

.create-project-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 14px;
}

/* Search */
.projects-search-wrapper {
  position: relative;
  margin-bottom: var(--space-lg);
}

.projects-search-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.projects-search-input {
  width: 100%;
  padding: 10px 14px 10px 40px;
  background: var(--bg-composer);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s ease;
}

.projects-search-input:focus {
  border-color: var(--accent);
}

.projects-search-input::placeholder {
  color: var(--text-muted);
}

/* Grid */
.projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-md);
}

.project-card {
  background: var(--bg-composer);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  min-height: 140px;
}

.project-card:hover {
  border-color: var(--border-hover);
  box-shadow: var(--shadow-md);
}

.project-card-name {
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--space-sm) 0;
}

.project-card-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
  flex: 1;
}

.project-card-time {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: var(--space-md);
}

/* Empty */
.projects-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px var(--space-lg);
  text-align: center;
  color: var(--text-muted);
}

.projects-empty .empty-icon {
  margin-bottom: var(--space-md);
  opacity: 0.4;
}

.projects-empty .empty-title {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0 0 var(--space-xs) 0;
}

.projects-empty .empty-desc {
  font-size: 14px;
  margin: 0 0 var(--space-lg) 0;
  max-width: 400px;
}

/* === Detail View === */
.projects-detail-content {
  max-width: var(--input-max-width);
  margin: 0 auto;
  padding: 24px var(--space-md) 24px;
  display: flex;
  flex-direction: column;
  gap: var(--space-xl);
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
  align-self: flex-start;
}

.back-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Header */
.project-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
}

.project-header-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-subtle);
  color: var(--accent);
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.project-header-info {
  flex: 1;
  min-width: 0;
}

.project-name-display {
  display: flex;
  align-items: center;
  gap: 8px;
}

.project-name-text {
  font-family: var(--font-serif);
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
}

.project-name-edit {
  display: flex;
  align-items: center;
  gap: 6px;
}

.project-name-input {
  font-family: var(--font-serif);
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-bottom: 2px solid var(--accent);
  outline: none;
  padding: 0 0 2px;
  width: 100%;
  max-width: 400px;
}

.project-path {
  font-size: 13px;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.icon-btn.danger-icon:hover {
  background: var(--error-subtle);
  color: var(--error);
}

/* Sections */
.project-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.project-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.project-section-title {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.project-section-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
}

.project-instructions-input {
  width: 100%;
  padding: 12px 14px;
  background: var(--bg-composer);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-serif);
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s ease;
}

.project-instructions-input:focus {
  border-color: var(--accent);
}

.project-instructions-input::placeholder {
  color: var(--text-muted);
}

.project-section-actions {
  display: flex;
  justify-content: flex-end;
}

.project-section-actions .btn {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Sessions */
.sessions-loading,
.sessions-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
}

.sessions-list {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.session-row:not(:last-child) {
  border-bottom: 0.5px solid var(--border-subtle);
}

.session-row:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.session-row-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.session-row-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row-time {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.session-row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
  flex-shrink: 0;
}

.session-row:hover .session-row-actions {
  opacity: 1;
}

.session-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.session-action-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.session-action-btn.danger:hover {
  background: var(--error-subtle);
  color: var(--error);
}

/* === Create Project Dialog === */
.create-project-dialog {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-xl);
  width: 480px;
  max-width: 90vw;
  box-shadow: var(--shadow-lg);
}

.form-group {
  margin-bottom: var(--space-md);
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: var(--space-xs);
}

.dialog-textarea {
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-serif);
  font-size: 14px;
  line-height: 1.5;
  resize: vertical;
  min-height: 80px;
}

.dialog-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.dialog-textarea::placeholder {
  color: var(--text-muted);
}

/* Directory Picker */
.directory-picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.directory-pick-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  width: 100%;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition-fast);
  text-align: left;
}

.directory-pick-btn:hover:not(:disabled) {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.directory-pick-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.directory-pick-btn span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Session Rename Input */
.session-rename-input {
  flex: 1;
  min-width: 0;
  padding: 2px 8px;
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  outline: none;
}

/* Effective Prompt */
.effective-prompt-preview {
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  max-height: 300px;
  overflow-y: auto;
}

.effective-prompt-text {
  font-family: var(--font-serif);
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* === Session Context Menu === */
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
  animation: menuIn 0.1s ease-out;
}

@keyframes menuIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
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

.context-menu-divider {
  height: 0.5px;
  background: var(--border-subtle);
  margin: 4px 0;
}
</style>
