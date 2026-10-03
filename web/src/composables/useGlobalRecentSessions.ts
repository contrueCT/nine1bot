import { beginSessionRead, ensureSessionSnapshot, copySessionSnapshot } from '../api/session-snapshot-authority'
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
const loadErrorState = ref(false)
const lastLoadedAtState = ref<number | null>(null)
let pollingTimer: ReturnType<typeof setInterval> | null = null
let loadGeneration = 0

type RecentSessionProject = Pick<Project, 'id' | 'worktree' | 'name'> & {
  rootDirectory?: string
}

function toProjectDisplayName(project: RecentSessionProject): string {
  const fallbackPath = (project.rootDirectory || project.worktree || '').replace(/\\/g, '/')
  const fallbackName = fallbackPath.split('/').filter(Boolean).pop() || project.id.slice(0, 8)
  return project.name || fallbackName
}

function mapProjectSessions(project: RecentSessionProject, sessions: Session[], readStarted: number): GlobalRecentSessionItem[] {
  const displayName = toProjectDisplayName(project)
  const displayPath = project.rootDirectory || project.worktree
  return sessions.map((session) => copySessionSnapshot(ensureSessionSnapshot(session, readStarted), {
    ...session,
    projectID: session.projectID || project.id,
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

function mergeRecentSessions(groups: Array<GlobalRecentSessionItem[] | undefined>): GlobalRecentSessionItem[] {
  const deduped = new Map<string, GlobalRecentSessionItem>()
  for (const group of groups) {
    if (!group) continue
    for (const session of group) {
      const previous = deduped.get(session.id)
      if (!previous || previous.time.updated < session.time.updated) {
        deduped.set(session.id, session)
      }
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, MAX_TOTAL_SESSIONS)
}

async function loadGlobalRecentSessions(knownProjects?: RecentSessionProject[]): Promise<GlobalRecentSessionItem[]> {
  const generation = ++loadGeneration
  isLoadingState.value = true
  try {
    const projects = knownProjects ?? await projectApi.list()
    const partialGroups: Array<GlobalRecentSessionItem[] | undefined> = []
    const publishIncrementally = recentSessionsState.value.length === 0
    let failedProjects = 0
    const tasks = projects.map(
      (project, index) => async (): Promise<GlobalRecentSessionItem[]> => {
        let group: GlobalRecentSessionItem[] = []
        try {
          const readStarted = beginSessionRead()
          const sessions = await projectApi.sessions(project.id, {
            roots: true,
            limit: MAX_SESSIONS_PER_PROJECT,
          })
          group = mapProjectSessions(project, sessions, readStarted)
        } catch (error) {
          failedProjects++
          group = recentSessionsState.value.filter((session) => session.projectID === project.id)
          console.error('Failed to load project sessions for global recents:', {
            projectID: project.id,
            error,
          })
        }
        partialGroups[index] = group
        if (publishIncrementally && generation === loadGeneration) {
          recentSessionsState.value = mergeRecentSessions(partialGroups)
        }
        return group
      },
    )

    const grouped = await runWithConcurrencyLimit(tasks, MAX_CONCURRENCY)
    const sorted = mergeRecentSessions(grouped)
    if (generation !== loadGeneration) return recentSessionsState.value
    if (projects.length > 0 && failedProjects === projects.length) {
      loadErrorState.value = true
      return recentSessionsState.value
    }
    recentSessionsState.value = sorted
    loadErrorState.value = failedProjects > 0
    lastLoadedAtState.value = Date.now()
    return sorted
  } catch (error) {
    if (generation === loadGeneration) loadErrorState.value = true
    throw error
  } finally {
    if (generation === loadGeneration) isLoadingState.value = false
  }
}

async function refreshGlobalRecentSessions(): Promise<GlobalRecentSessionItem[]> {
  return loadGlobalRecentSessions()
}

function startGlobalRecentPolling(intervalMs = POLL_INTERVAL_MS) {
  stopGlobalRecentPolling()
  pollingTimer = setInterval(() => {
    if (isLoadingState.value) return
    void refreshGlobalRecentSessions().catch((error) => {
      console.error('Failed to poll global recent sessions:', error)
    })
  }, intervalMs)
}

function stopGlobalRecentPolling() {
  if (!pollingTimer) return
  clearInterval(pollingTimer)
  pollingTimer = null
}

function resetGlobalRecentSessions() {
  loadGeneration++
  recentSessionsState.value = []
  isLoadingState.value = false
  loadErrorState.value = false
  lastLoadedAtState.value = null
}

function applyRecentSessionTitle(updated: Pick<Session, 'id' | 'title'>) {
  if (!updated || typeof updated.id !== 'string' || typeof updated.title !== 'string') return
  const session = recentSessionsState.value.find(session => session.id === updated.id)
  if (session) session.title = updated.title
}

export function useGlobalRecentSessions() {
  return {
    recentSessions: computed(() => recentSessionsState.value),
    isLoading: computed(() => isLoadingState.value),
    loadError: computed(() => loadErrorState.value),
    lastLoadedAt: computed(() => lastLoadedAtState.value),
    loadGlobalRecentSessions,
    refreshGlobalRecentSessions,
    startGlobalRecentPolling,
    stopGlobalRecentPolling,
    resetGlobalRecentSessions,
    applyRecentSessionTitle,
  }
}
