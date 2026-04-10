export interface ToolExecutionContext {
  signal?: AbortSignal
  commandId?: number
  tabId?: number
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (!(error instanceof Error)) return false

  return error.name === 'AbortError'
    || error.message === 'The operation was aborted.'
    || /abort(ed)?/i.test(error.message)
}
