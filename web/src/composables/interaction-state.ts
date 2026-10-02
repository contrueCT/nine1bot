import { ref } from 'vue'

export interface InteractionState {
  status: 'pending' | 'success' | 'error'
  action: string
  error?: string
}

/** One API owner for both Web surfaces; child cards only emit intent. */
export function createInteractionResponder() {
  const states = ref<Record<string, InteractionState>>({})
  async function respond(id: string, action: string, submit: () => Promise<unknown>, onSuccess: () => void) {
    if (states.value[id]?.status === 'pending' || states.value[id]?.status === 'success') return false
    states.value[id] = { status: 'pending', action }
    try {
      await submit()
      states.value[id] = { status: 'success', action }
      onSuccess()
      return true
    } catch (error) {
      states.value[id] = { status: 'error', action, error: error instanceof Error ? error.message : '操作失败，请重试' }
      return false
    }
  }
  return { states, respond }
}
