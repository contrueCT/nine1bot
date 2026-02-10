import { ref } from 'vue'
import { api } from '../api/client'
import type { ProjectInfo } from '../components/Sidebar.vue'

export function useProjects() {
  const projects = ref<ProjectInfo[]>([])
  const currentProject = ref<ProjectInfo | null>(null)
  const isLoading = ref(false)

  async function loadProjects() {
    isLoading.value = true
    try {
      const data = await api.getProjects()
      projects.value = data.map((p: any) => ({
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
  }

  async function selectProject(projectId: string) {
    const project = projects.value.find(p => p.id === projectId)
    if (project) {
      currentProject.value = project
    } else {
      // Try fetching from API
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
  }

  function clearProject() {
    currentProject.value = null
  }

  async function updateProject(projectId: string, updates: { name?: string; instructions?: string }) {
    try {
      const data = await api.updateProject(projectId, updates)
      // Update local state
      const idx = projects.value.findIndex(p => p.id === projectId)
      if (idx >= 0) {
        projects.value[idx] = {
          ...projects.value[idx],
          ...updates,
          time: data.time || projects.value[idx].time
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

  async function getProjectSessions(projectId: string) {
    try {
      return await api.getProjectSessions(projectId)
    } catch (e) {
      console.error('Failed to get project sessions:', e)
      return []
    }
  }

  return {
    projects,
    currentProject,
    isLoading,
    loadProjects,
    selectProject,
    clearProject,
    updateProject,
    getProjectSessions
  }
}
