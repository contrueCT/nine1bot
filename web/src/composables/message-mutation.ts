import { reactive } from 'vue'

export type MessageMutationDone = (error?: string) => void

// A completion belongs to one rendered message and one request. Late or repeated
// completions must not dismiss a newer edit or another session's confirmation.
export function createMessageMutation() {
  const state = reactive({ pending: false, error: '' })
  let generation = 0
  function reset() {
    generation++
    state.pending = false
    state.error = ''
  }
  function begin(success: () => void): MessageMutationDone | undefined {
    if (state.pending) return
    const current = ++generation
    state.pending = true
    state.error = ''
    return (error) => {
      if (generation !== current || !state.pending) return
      state.pending = false
      if (error) state.error = error
      else success()
    }
  }
  return { state, begin, reset }
}
