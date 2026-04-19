export interface ToolExecutionContext {
  signal?: AbortSignal
  commandId?: number
  tabId?: number
}
export class ToolAbortError extends Error {
  readonly code = 'TOOL_ABORTED'

  constructor(message = 'Tool execution cancelled') {
    super(message)
    this.name = 'ToolAbortError'
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ToolAbortError()
  }
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return
  }
  if (signal.aborted) {
    throw new ToolAbortError()
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new ToolAbortError())
    }
    signal.addEventListener('abort', onAbort)
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof ToolAbortError || (error instanceof Error && error.name === 'ToolAbortError')
}
