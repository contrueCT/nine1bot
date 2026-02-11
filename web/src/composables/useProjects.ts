import { ref, computed } from 'vue'
import type { ProjectInfo } from '../components/Sidebar.vue'

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

export function useProjects() {
  const currentProject = ref<ProjectInfo | null>(null)
  const isLoading = ref(false)

  // Stub: returns empty list (will be re-implemented with backend)
  const projects = computed<ProjectInfo[]>(() => [])

  async function loadProjects() {
    // stub
  }

  async function selectProject(_projectId: string) {
    // stub
  }

  function clearProject() {
    currentProject.value = null
  }

  function createProject(_name: string, _instructions: string, _directory: string): LocalProject {
    // stub — return placeholder
    return {
      id: '',
      name: _name,
      instructions: _instructions,
      directory: _directory,
      sessionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }

  async function updateProject(_projectId: string, _updates: { name?: string; instructions?: string }) {
    // stub
  }

  function deleteLocalProject(_projectId: string) {
    // stub
  }

  function getProjectSessions(_projectId: string): string[] {
    return []
  }

  function addSessionToProject(_projectId: string, _sessionId: string) {
    // stub
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
