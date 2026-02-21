import { computed, ref } from 'vue'
import { projectApi, type Project, type Session } from '../api/client'

const MAX_SESSIONS_PER_PROJECT = 20
const MAX_TOTAL_SESSIONS = 300
const MAX_CONCURRENCY = 4
const POLL_INTERVAL_MS = 60000

export type GlobalRecentSessionItem = Session & {
  projectDisplayName?: string
  projectDisplayPath?: string
}

const recentSessionsState = ref<GlobalRecentSessionItem[]>([])
const isLoadingState = ref(false)
const lastLoadedAtState = ref<number | null>(null)
let pollingTimer: ReturnType<typeof setInterval> | null = null

function toProjectDisplayName(project: Project): string {
  const fallbackPath = (project.rootDirectory || project.worktree || '').replace(/\\/g, '/')
  const fallbackName = fallbackPath.split('/').filter(Boolean).pop() || project.id.slice(0, 8)
  return project.name || fallbackName
}

function mapProjectSessions(project: Project, sessions: Session[]): GlobalRecentSessionItem[] {
  const displayName = toProjectDisplayName(project)
  const displayPath = project.rootDirectory || project.worktree
  return sessions.map((session) => ({
    ...session,
    projectDisplayName: displayName,
    projectDisplayPath: displayPath,
  }))
}

async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let cursor = 0

  const worker = async () => {
    while (true) {
      const index = cursor++
      if (index >= tasks.length) return
      results[index] = await tasks[index]()
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

async function loadGlobalRecentSessions(): Promise<GlobalRecentSessionItem[]> {
  isLoadingState.value = true
  try {
    const projects = await projectApi.list()
    const tasks = projects.map(
      (project) => async (): Promise<GlobalRecentSessionItem[]> => {
        try {
          const sessions = await projectApi.sessions(project.id, {
            roots: true,
            limit: MAX_SESSIONS_PER_PROJECT,
          })
          return mapProjectSessions(project, sessions)
        } catch (error) {
          console.error('Failed to load project sessions for global recents:', {
            projectID: project.id,
            error,
          })
          return []
        }
      },
    )

    const grouped = await runWithConcurrencyLimit(tasks, MAX_CONCURRENCY)
    const deduped = new Map<string, GlobalRecentSessionItem>()

    for (const group of grouped) {
      for (const session of group) {
        const previous = deduped.get(session.id)
        if (!previous || previous.time.updated < session.time.updated) {
          deduped.set(session.id, session)
        }
      }
    }

    const sorted = Array.from(deduped.values())
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, MAX_TOTAL_SESSIONS)

    recentSessionsState.value = sorted
    lastLoadedAtState.value = Date.now()
    return sorted
  } finally {
    isLoadingState.value = false
  }
}

async function refreshGlobalRecentSessions(): Promise<GlobalRecentSessionItem[]> {
  return loadGlobalRecentSessions()
}

function startGlobalRecentPolling(intervalMs = POLL_INTERVAL_MS) {
  stopGlobalRecentPolling()
  pollingTimer = setInterval(() => {
    void refreshGlobalRecentSessions()
  }, intervalMs)
}

function stopGlobalRecentPolling() {
  if (!pollingTimer) return
  clearInterval(pollingTimer)
  pollingTimer = null
}

export function useGlobalRecentSessions() {
  return {
    recentSessions: computed(() => recentSessionsState.value),
    isLoading: computed(() => isLoadingState.value),
    lastLoadedAt: computed(() => lastLoadedAtState.value),
    loadGlobalRecentSessions,
    refreshGlobalRecentSessions,
    startGlobalRecentPolling,
    stopGlobalRecentPolling,
  }
}
