export interface ToolExecutionContext {
  signal?: AbortSignal
  commandId?: number
  tabId?: number
  assertActive?: () => Promise<void>
  dispatchInput?: (method: string, params: Record<string, unknown>) => Promise<unknown>
  releaseOwnedInput?: (method: string, params: Record<string, unknown>) => Promise<void>
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (!(error instanceof Error)) return false

  return error.name === 'AbortError'
    || error.message === 'The operation was aborted.'
    || /abort(ed)?/i.test(error.message)
}

/** Revalidate cancellation and relay/target ownership immediately before work. */
export async function assertExecutionActive(context?: ToolExecutionContext): Promise<void> {
  context?.signal?.throwIfAborted()
  await context?.assertActive?.()
  context?.signal?.throwIfAborted()
}

export async function executionDelay(milliseconds: number, context?: ToolExecutionContext): Promise<void> {
  await assertExecutionActive(context)
  await new Promise<void>((resolve, reject) => {
    const signal = context?.signal
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Command aborted')) }
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  await assertExecutionActive(context)
}
