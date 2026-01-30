import { reactive, computed } from 'vue'
import type { SSEEvent } from '../api/client'

// Maximum parallel agents (configurable)
export const MAX_PARALLEL_AGENTS = 10

// Reactive object for session running states (shared state)
const runningStates = reactive<Record<string, boolean>>({})

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

  // Initialize from backend status endpoint
  async function syncSessionStatus() {
    try {
      const res = await fetch('/session/status')
      const data = await res.json()

      // Clear existing states
      for (const key of Object.keys(runningStates)) {
        delete runningStates[key]
      }

      // data format: { sessionID: { type: 'idle' | 'busy' | 'retry', ... }, ... }
      for (const [sessionId, info] of Object.entries(data)) {
        const status = info as { type: string }
        runningStates[sessionId] = status.type === 'busy'
      }
    } catch (error) {
      console.error('Failed to sync session status:', error)
    }
  }

  // Handle SSE events for ALL sessions (not just current)
  function handleGlobalSSEEvent(event: SSEEvent) {
    const sessionID = extractSessionID(event)
    if (!sessionID) return

    switch (event.type) {
      case 'session.status':
        // status event: { sessionID, status: { type: 'busy' | 'idle' | 'retry' } }
        const status = event.properties?.status
        if (status) {
          runningStates[sessionID] = status.type === 'busy'
        }
        break

      case 'session.idle':
        // Session finished
        runningStates[sessionID] = false
        break

      case 'session.error':
        // Session error - also stopped
        runningStates[sessionID] = false
        break
    }
  }

  // Check if a specific session is running
  function isSessionRunning(sessionId: string): boolean {
    return runningStates[sessionId] ?? false
  }

  // Set session running state
  function setSessionRunning(sessionId: string, running: boolean) {
    runningStates[sessionId] = running
  }

  // Get list of running session IDs
  function getRunningSessionIds(): string[] {
    return Object.entries(runningStates)
      .filter(([_, isRunning]) => isRunning)
      .map(([sessionId]) => sessionId)
  }

  // Clear session from tracking (e.g., when deleted)
  function clearSession(sessionId: string) {
    delete runningStates[sessionId]
  }

  return {
    runningStates,
    runningCount,
    canStartNewAgent,
    MAX_PARALLEL_AGENTS,
    syncSessionStatus,
    handleGlobalSSEEvent,
    isSessionRunning,
    setSessionRunning,
    getRunningSessionIds,
    clearSession
  }
}
