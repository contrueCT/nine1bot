import { ref, computed } from 'vue'
import { api } from '../api/client'
import type { ProjectInfo } from '../components/Sidebar.vue'
import { useSessionMode } from './useSessionMode'

// LocalProject stored in localStorage
export interface LocalProject {
  id: string
  name: string
  instructions: string
  directory: string
  sessionIds: string[]
  createdAt: number
  updatedAt: number
}

const LOCAL_PROJECTS_KEY = 'nine1bot-local-projects'

// Load local projects from localStorage
function loadLocalProjects(): LocalProject[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_PROJECTS_KEY) || '[]')
  } catch {
    return []
  }
}

function saveLocalProjects(projects: LocalProject[]) {
  localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects))
}

export function useProjects() {
  const backendProjects = ref<ProjectInfo[]>([])
  const localProjects = ref<LocalProject[]>(loadLocalProjects())
  const currentProject = ref<ProjectInfo | null>(null)
  const isLoading = ref(false)

  // Combined projects: backend + local
  const projects = computed<ProjectInfo[]>(() => {
    const local = localProjects.value.map(lp => ({
      id: lp.id,
      name: lp.name,
      worktree: lp.directory,
      instructions: lp.instructions,
      time: { created: lp.createdAt, updated: lp.updatedAt },
      sandboxes: [],
      isLocal: true
    }))
    return [...backendProjects.value, ...local]
  })

  async function loadProjects() {
    isLoading.value = true
    try {
      const data = await api.getProjects()
      backendProjects.value = data
        .filter((p: any) => p.id !== 'global')  // Filter out "global" fallback project
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          worktree: p.worktree,
          icon: p.icon,
          instructions: p.instructions,
          time: p.time,
          sandboxes: p.sandboxes || []
        }))
    } catch (e) {
      console.error('Failed to load projects:', e)
    } finally {
      isLoading.value = false
    }
    // Also refresh local projects
    localProjects.value = loadLocalProjects()
  }

  async function selectProject(projectId: string) {
    // Check combined list first
    const project = projects.value.find(p => p.id === projectId)
    if (project) {
      currentProject.value = project
      return
    }

    // Try fetching from API (backend project)
    try {
      const data = await api.getProject(projectId)
      currentProject.value = {
        id: data.id,
        name: data.name,
        worktree: data.worktree,
        icon: data.icon,
        instructions: data.instructions,
        time: data.time,
        sandboxes: data.sandboxes || []
      }
    } catch (e) {
      console.error('Failed to select project:', e)
    }
  }

  function clearProject() {
    currentProject.value = null
  }

  // Create a new local project
  function createProject(name: string, instructions: string, directory: string): LocalProject {
    const now = Date.now()
    const newProject: LocalProject = {
      id: `local-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      instructions,
      directory,
      sessionIds: [],
      createdAt: now,
      updatedAt: now
    }
    const all = loadLocalProjects()
    all.push(newProject)
    saveLocalProjects(all)
    localProjects.value = all
    return newProject
  }

  async function updateProject(projectId: string, updates: { name?: string; instructions?: string }) {
    // Check if it's a local project
    const localIdx = localProjects.value.findIndex(p => p.id === projectId)
    if (localIdx >= 0) {
      const all = loadLocalProjects()
      const idx = all.findIndex(p => p.id === projectId)
      if (idx >= 0) {
        if (updates.name !== undefined) all[idx].name = updates.name
        if (updates.instructions !== undefined) all[idx].instructions = updates.instructions
        all[idx].updatedAt = Date.now()
        saveLocalProjects(all)
        localProjects.value = all
      }
      if (currentProject.value?.id === projectId) {
        currentProject.value = {
          ...currentProject.value,
          ...updates,
          time: { ...currentProject.value.time, updated: Date.now() }
        }
      }
      return
    }

    // Backend project update
    try {
      const data = await api.updateProject(projectId, updates)
      const idx = backendProjects.value.findIndex(p => p.id === projectId)
      if (idx >= 0) {
        backendProjects.value[idx] = {
          ...backendProjects.value[idx],
          ...updates,
          time: data.time || backendProjects.value[idx].time
        }
      }
      if (currentProject.value?.id === projectId) {
        currentProject.value = {
          ...currentProject.value,
          ...updates,
          time: data.time || currentProject.value.time
        }
      }
      return data
    } catch (e) {
      console.error('Failed to update project:', e)
      throw e
    }
  }

  // Delete a local project
  function deleteLocalProject(projectId: string) {
    const all = loadLocalProjects().filter(p => p.id !== projectId)
    saveLocalProjects(all)
    localProjects.value = all
    if (currentProject.value?.id === projectId) {
      currentProject.value = null
    }
  }

  function getProjectSessions(projectId: string): string[] {
    // Use localStorage sessionProjects mapping as the single source of truth
    // (Backend auto-assigns projectID to all sessions, which is unreliable)
    const { getSessionsForProject } = useSessionMode()
    return getSessionsForProject(projectId)
  }

  // Add a session to a local project (updates both project and session-project mapping)
  function addSessionToProject(projectId: string, sessionId: string) {
    const all = loadLocalProjects()
    const idx = all.findIndex(p => p.id === projectId)
    if (idx >= 0 && !all[idx].sessionIds.includes(sessionId)) {
      all[idx].sessionIds.push(sessionId)
      all[idx].updatedAt = Date.now()
      saveLocalProjects(all)
      localProjects.value = all
    }
    // Also update session → project mapping (supports multi-project)
    const { addSessionToProject: addToSessionMode } = useSessionMode()
    addToSessionMode(sessionId, projectId)
  }

  return {
    projects,
    currentProject,
    isLoading,
    loadProjects,
    selectProject,
    clearProject,
    createProject,
    updateProject,
    deleteLocalProject,
    getProjectSessions,
    addSessionToProject
  }
}
