import { ref, watch } from 'vue'
import type { AppMode } from './useAppMode'

const STORAGE_KEY = 'nine1bot-session-modes'
const PROJECT_KEY = 'nine1bot-session-projects'

// sessionId → mode mapping
const sessionModes = ref<Record<string, AppMode>>(
  JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
)

// sessionId → projectId[] mapping (multi-project support)
// Migration: old format was Record<string, string>, new is Record<string, string[]>
function loadSessionProjects(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_KEY) || '{}')
    const migrated: Record<string, string[]> = {}
    for (const [key, val] of Object.entries(raw)) {
      if (Array.isArray(val)) {
        migrated[key] = val as string[]
      } else if (typeof val === 'string') {
        // Migrate old single-value format to array
        migrated[key] = [val]
      }
    }
    return migrated
  } catch {
    return {}
  }
}

const sessionProjects = ref<Record<string, string[]>>(loadSessionProjects())

// Persist on change
watch(sessionModes, (val) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
}, { deep: true })

watch(sessionProjects, (val) => {
  localStorage.setItem(PROJECT_KEY, JSON.stringify(val))
}, { deep: true })

export function useSessionMode() {
  function getMode(sessionId: string): AppMode | undefined {
    return sessionModes.value[sessionId]
  }

  function setMode(sessionId: string, mode: AppMode) {
    sessionModes.value = { ...sessionModes.value, [sessionId]: mode }
  }

  function removeMode(sessionId: string) {
    const { [sessionId]: _, ...rest } = sessionModes.value
    sessionModes.value = rest
  }

  // Get all projects for a session (returns array)
  function getSessionProjects(sessionId: string): string[] {
    return sessionProjects.value[sessionId] || []
  }

  // Legacy single-project getter (returns first project or undefined)
  function getSessionProject(sessionId: string): string | undefined {
    const projects = sessionProjects.value[sessionId]
    return projects?.[0]
  }

  // Add session to a project (multi-project: push if not exists)
  function addSessionToProject(sessionId: string, projectId: string) {
    const current = sessionProjects.value[sessionId] || []
    if (!current.includes(projectId)) {
      sessionProjects.value = {
        ...sessionProjects.value,
        [sessionId]: [...current, projectId]
      }
    }
  }

  // Remove session from a specific project
  function removeSessionFromProject(sessionId: string, projectId: string) {
    const current = sessionProjects.value[sessionId] || []
    const filtered = current.filter(id => id !== projectId)
    if (filtered.length === 0) {
      const { [sessionId]: _, ...rest } = sessionProjects.value
      sessionProjects.value = rest
    } else {
      sessionProjects.value = {
        ...sessionProjects.value,
        [sessionId]: filtered
      }
    }
  }

  // Legacy setter (replaces all projects with single project)
  function setSessionProject(sessionId: string, projectId: string) {
    sessionProjects.value = { ...sessionProjects.value, [sessionId]: [projectId] }
  }

  function removeSessionProject(sessionId: string) {
    const { [sessionId]: _, ...rest } = sessionProjects.value
    sessionProjects.value = rest
  }

  function getSessionsForProject(projectId: string): string[] {
    return Object.entries(sessionProjects.value)
      .filter(([_, pids]) => pids.includes(projectId))
      .map(([sid]) => sid)
  }

  // Filter sessions by mode
  function filterByMode(sessionIds: string[], mode: AppMode): string[] {
    return sessionIds.filter(id => {
      const m = sessionModes.value[id]
      // Sessions without a mode tag show in both modes
      return !m || m === mode
    })
  }

  return {
    sessionModes,
    sessionProjects,
    getMode,
    setMode,
    removeMode,
    getSessionProject,
    getSessionProjects,
    setSessionProject,
    addSessionToProject,
    removeSessionFromProject,
    removeSessionProject,
    getSessionsForProject,
    filterByMode,
  }
}
