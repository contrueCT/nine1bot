import { ref } from 'vue'
import { isCurrentSessionDiff } from '../utils/session-diff-event'

/** Global SSE has no replay: reconcile after initial connection and every reconnect. */
export function createSessionChangesLiveUpdates(options: {
  sessionId: () => string | undefined
  refresh: () => void
}) {
  const connected = ref(false)
  let generation = 0
  function begin() {
    const owner = ++generation
    connected.value = false
    const current = () => owner === generation
    return {
      ready() {
        if (!current()) return
        connected.value = true
        if (options.sessionId()) options.refresh()
      },
      disconnected() {
        if (current()) connected.value = false
      },
      received(event: { type?: string; properties?: { sessionID?: string } } | undefined) {
        if (current() && isCurrentSessionDiff(event, options.sessionId())) options.refresh()
      },
    }
  }
  function stop() {
    generation += 1
    connected.value = false
  }
  return { connected, begin, stop }
}
