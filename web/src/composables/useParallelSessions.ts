import { reactive, computed } from 'vue'
import { getApiDirectory, type Session, type SessionStatus, type SSEEvent } from '../api/client'

// Maximum parallel agents (configurable)
export const MAX_PARALLEL_AGENTS = 10

// Reactive object for session running states (shared state)
const runningStates = reactive<Record<string, boolean>>({})
const sessionDirectories = new Map<string, string>()
const stateRevisions = new Map<string, number>()
const syncVersions = new Map<string, number>()
let revision = 0

// Helper to extract sessionID from SSE event
function extractSessionID(event: SSEEvent): string | undefined {
  return event.properties?.sessionID
    || event.properties?.message?.info?.sessionID
    || event.properties?.part?.sessionID
    || event.properties?.info?.sessionID
    || event.properties?.status?.sessionID
}

export function useParallelSessions() {
  // Count of currently running agents
  const runningCount = computed(() => {
    return Object.values(runningStates).filter(v => v).length
  })

  // Check if we can start a new agent
  const canStartNewAgent = computed(() => runningCount.value < MAX_PARALLEL_AGENTS)

  function rememberSessionDirectory(sessionId: string, directory: string) {
    if (sessionDirectories.get(sessionId) === directory) return
    sessionDirectories.set(sessionId, directory)
    stateRevisions.set(sessionId, ++revision)
  }

  // The status endpoint is project-scoped. Reconnect each known directory and
  // only clear that directory's entries; a different project's idle is unrelated.
  async function syncSessionStatus(
    sessions: readonly Pick<Session, 'id' | 'directory'>[] = [],
    isCurrent: () => boolean = () => true,
    shouldApply: (sessionId: string) => boolean = () => true,
  ) {
    for (const session of sessions) rememberSessionDirectory(session.id, session.directory)
    const directories = new Set([getApiDirectory()])
    for (const session of sessions) directories.add(session.directory)
    for (const id of Object.keys(runningStates)) {
      const directory = sessionDirectories.get(id)
      if (directory !== undefined) directories.add(directory)
    }
    const pending = [...directories]
    const synchronize = async (directory: string) => {
      const cutoff = revision
      const version = (syncVersions.get(directory) ?? 0) + 1
      syncVersions.set(directory, version)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      try {
        const query = directory ? `?${new URLSearchParams({ directory })}` : ''
        const res = await fetch(`/session/status${query}`, {
          headers: directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {},
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Session status failed: ${res.status}`)
        const data: Record<string, SessionStatus> = await res.json()
        if (!data || typeof data !== 'object' || Array.isArray(data)
          || Object.values(data).some(status => !status || !['idle', 'busy', 'retry'].includes(status.type))) {
          throw new Error('Invalid session status response')
        }
        if (!isCurrent() || version !== syncVersions.get(directory)) return
        const ids = new Set([
          ...Object.keys(data),
          ...[...sessionDirectories].filter(([, owner]) => owner === directory).map(([id]) => id),
        ])
        for (const id of ids) {
          if (!shouldApply(id)) continue
          const owner = sessionDirectories.get(id)
          if (owner !== undefined && owner !== directory) continue
          // SSE and local sends observed while this request was in flight win.
          if ((stateRevisions.get(id) ?? 0) > cutoff) continue
          const status = data[id]
          if (status && !sessionDirectories.has(id)) sessionDirectories.set(id, directory)
          setSessionRunning(id, status?.type === 'busy' || status?.type === 'retry')
        }
      } catch (error) {
        if (isCurrent()) console.error('Failed to sync session status:', error)
      } finally {
        clearTimeout(timeout)
      }
    }
    // A large recent-session list must not create an unbounded request burst.
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length && isCurrent()) await synchronize(pending.shift()!)
    }))
  }

  // Handle SSE events for ALL sessions (not just current)
  function handleGlobalSSEEvent(event: SSEEvent, directory?: string) {
    const sessionID = extractSessionID(event)
    if (!sessionID) return
    if (directory !== undefined) rememberSessionDirectory(sessionID, directory)

    switch (event.type) {
      case 'session.status':
        // status event: { sessionID, status: { type: 'busy' | 'idle' | 'retry' } }
        const status = event.properties?.status
        if (status) {
          setSessionRunning(sessionID, status.type === 'busy' || status.type === 'retry')
        }
        break

      case 'session.idle':
        // Session finished
        setSessionRunning(sessionID, false)
        break

      case 'session.error':
        // Session error - also stopped
        setSessionRunning(sessionID, false)
        break
    }
  }

  // Check if a specific session is running
  function isSessionRunning(sessionId: string): boolean {
    return runningStates[sessionId] ?? false
  }

  // Set session running state（false 直接删除条目，避免状态表只增不减）
  function setSessionRunning(sessionId: string, running: boolean) {
    stateRevisions.set(sessionId, ++revision)
    if (running) {
      runningStates[sessionId] = true
    } else {
      delete runningStates[sessionId]
    }
  }

  // Get list of running session IDs
  function getRunningSessionIds(): string[] {
    return Object.entries(runningStates)
      .filter(([_, isRunning]) => isRunning)
      .map(([sessionId]) => sessionId)
  }

  // Clear session from tracking (e.g., when deleted)
  function clearSession(sessionId: string) {
    setSessionRunning(sessionId, false)
    sessionDirectories.delete(sessionId)
  }

  return {
    runningStates,
    runningCount,
    canStartNewAgent,
    MAX_PARALLEL_AGENTS,
    syncSessionStatus,
    handleGlobalSSEEvent,
    rememberSessionDirectory,
    isSessionRunning,
    setSessionRunning,
    getRunningSessionIds,
    clearSession
  }
}
