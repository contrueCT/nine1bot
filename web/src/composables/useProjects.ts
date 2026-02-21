import { computed, ref } from 'vue'
import { projectApi, type Project } from '../api/client'
import type { ProjectInfo } from '../components/Sidebar.vue'

function toProjectInfo(project: Project): ProjectInfo {
  return {
    id: project.id,
    name: project.name,
    worktree: project.worktree,
    rootDirectory: project.rootDirectory,
    projectType: project.projectType,
    icon: project.icon,
    instructions: project.instructions,
    time: project.time,
    sandboxes: project.sandboxes,
  }
}

export function useProjects() {
  const projectList = ref<ProjectInfo[]>([])
  const currentProject = ref<ProjectInfo | null>(null)
  const isLoading = ref(false)

  const projects = computed(() => projectList.value)

  async function loadProjects() {
    isLoading.value = true
    try {
      const items = await projectApi.list()
      projectList.value = items.map(toProjectInfo).sort((a, b) => b.time.updated - a.time.updated)

      if (currentProject.value) {
        const matched = projectList.value.find((p) => p.id === currentProject.value!.id)
        currentProject.value = matched || null
      }
    } finally {
      isLoading.value = false
    }
  }

  async function selectProject(projectId: string) {
    if (!projectId) {
      currentProject.value = null
      return null
    }

    let matched = projectList.value.find((p) => p.id === projectId)
    if (!matched) {
      await loadProjects()
      matched = projectList.value.find((p) => p.id === projectId)
    }

    currentProject.value = matched || null
    return currentProject.value
  }

  async function openDirectory(
    directory: string,
    input?: {
      name?: string
      instructions?: string
    },
  ) {
    const discovered = await projectApi.current(directory)
    let project = discovered

    if (input?.name !== undefined || input?.instructions !== undefined) {
      project = await projectApi.update(discovered.id, {
        name: input.name,
        instructions: input.instructions,
      })
    }

    const mapped = toProjectInfo(project)
    const index = projectList.value.findIndex((p) => p.id === mapped.id)
    if (index >= 0) {
      projectList.value[index] = mapped
    } else {
      projectList.value.unshift(mapped)
    }

    projectList.value = [...projectList.value].sort((a, b) => b.time.updated - a.time.updated)
    currentProject.value = mapped
    return mapped
  }

  async function updateProject(projectId: string, updates: { name?: string; instructions?: string }) {
    const updated = toProjectInfo(await projectApi.update(projectId, updates))
    const index = projectList.value.findIndex((p) => p.id === projectId)
    if (index >= 0) {
      projectList.value[index] = updated
    } else {
      projectList.value.unshift(updated)
    }
    projectList.value = [...projectList.value].sort((a, b) => b.time.updated - a.time.updated)

    if (currentProject.value?.id === projectId) {
      currentProject.value = updated
    }

    return updated
  }

  async function forgetProject(projectId: string) {
    await projectApi.forget(projectId)
    projectList.value = projectList.value.filter((p) => p.id !== projectId)
    if (currentProject.value?.id === projectId) {
      currentProject.value = null
    }
  }

  function clearProject() {
    currentProject.value = null
  }

  function getProject(projectId: string) {
    return projectList.value.find((project) => project.id === projectId) || null
  }

  return {
    projects,
    currentProject,
    isLoading,
    loadProjects,
    selectProject,
    clearProject,
    openDirectory,
    updateProject,
    forgetProject,
    getProject,
  }
}
