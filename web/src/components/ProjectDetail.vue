<script setup lang="ts">
import { ref, watch } from 'vue'
import { FolderOpen, Plus, MessageSquare, Save, Pencil, Check, X, Clock } from 'lucide-vue-next'
import { api } from '../api/client'
import type { Session } from '../api/client'
import type { ProjectInfo } from './Sidebar.vue'
import { useSessionMode } from '../composables/useSessionMode'

const { getSessionsForProject } = useSessionMode()

const props = defineProps<{
  project: ProjectInfo
}>()

const emit = defineEmits<{
  updateProject: [projectId: string, updates: { name?: string; instructions?: string }]
  selectSession: [sessionId: string]
  newSession: [projectId: string]
  close: []
}>()

const isEditingName = ref(false)
const editName = ref('')
const instructions = ref('')
const isSaving = ref(false)
const sessions = ref<Session[]>([])
const isLoadingSessions = ref(false)

// Initialize from props
watch(() => props.project, (project) => {
  instructions.value = project.instructions || ''
  editName.value = project.name || ''
  loadSessions()
}, { immediate: true })

async function loadSessions() {
  isLoadingSessions.value = true
  try {
    // Use localStorage sessionMode mapping as single source of truth
    const sessionIds = getSessionsForProject(props.project.id)
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

function startEditName() {
  editName.value = getProjectName()
  isEditingName.value = true
}

function cancelEditName() {
  isEditingName.value = false
}

function saveName() {
  if (editName.value.trim()) {
    emit('updateProject', props.project.id, { name: editName.value.trim() })
  }
  isEditingName.value = false
}

async function saveInstructions() {
  isSaving.value = true
  try {
    emit('updateProject', props.project.id, { instructions: instructions.value })
  } finally {
    setTimeout(() => { isSaving.value = false }, 500)
  }
}

function getProjectName(): string {
  return props.project.name || props.project.worktree.split('/').pop() || props.project.id.slice(0, 8)
}

function getSessionTitle(session: Session): string {
  return session.title || `会话 ${session.id.slice(0, 6)}`
}

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}
</script>

<template>
  <div class="project-detail">
    <div class="project-detail-content">
      <!-- Project Header -->
      <div class="project-header">
        <div class="project-header-icon">
          <FolderOpen :size="24" />
        </div>
        <div class="project-header-info">
          <!-- Name (editable) -->
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
            <h2 class="project-name-text">{{ getProjectName() }}</h2>
            <button class="icon-btn" @click="startEditName"><Pencil :size="14" /></button>
          </div>
          <span class="project-path">{{ project.worktree }}</span>
        </div>
      </div>

      <!-- Instructions Section -->
      <div class="project-section">
        <div class="project-section-header">
          <h3 class="project-section-title">Project Instructions</h3>
          <span class="project-section-desc">These instructions will be shared across all sessions in this project.</span>
        </div>
        <textarea
          v-model="instructions"
          class="project-instructions-input"
          placeholder="Enter instructions for this project... (e.g., 'You are a helpful assistant for the Nine1Bot project. Always respond in Chinese.')"
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
          <button class="btn btn-ghost btn-sm" @click="emit('newSession', project.id)">
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
          <button
            v-for="session in sessions"
            :key="session.id"
            class="session-row"
            @click="emit('selectSession', session.id)"
          >
            <MessageSquare :size="14" class="session-row-icon" />
            <span class="session-row-title">{{ getSessionTitle(session) }}</span>
            <span class="session-row-time">
              <Clock :size="12" />
              {{ formatTime(session.time.updated) }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-detail {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.project-detail-content {
  max-width: var(--input-max-width);
  margin: 0 auto;
  padding: 48px var(--space-md) 24px;
  display: flex;
  flex-direction: column;
  gap: var(--space-xl);
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
</style>
