// Finite JSON APIs share one deadline for headers, body consumption and parsing.
// SSE and file transfers have separate streaming lifecycles.
export type JsonResponse = Pick<Response, 'ok' | 'status' | 'statusText' | 'headers'> & {
  json(): Promise<any>
}

export async function fetchJsonResponse(
  url: string,
  options: RequestInit = {},
  timeout = 30_000,
): Promise<JsonResponse> {
  const controller = new AbortController()
  const deadline = Date.now() + timeout
  const timeoutError = () => new Error(`Request timed out after ${Math.round(timeout / 1000)}s: ${url}`)
  const abort = () => controller.abort(options.signal?.reason ?? new DOMException('Request cancelled', 'AbortError'))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let rejectAborted!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const onAbort = () => {
    rejectAborted(controller.signal.reason)
    // Explicit cancellation also releases mock/custom streams that do not observe fetch's signal.
    void reader?.cancel(controller.signal.reason).catch(() => {})
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(timeoutError()), timeout)
  if (options.signal?.aborted) abort()
  const checkDeadline = () => {
    if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(timeoutError())
    controller.signal.throwIfAborted()
  }

  const read = async (): Promise<JsonResponse> => {
    checkDeadline()
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (controller.signal.aborted) {
      void response.body?.cancel(controller.signal.reason).catch(() => {})
      controller.signal.throwIfAborted()
    }
    let text = ''
    if (response.body) {
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { value, done } = await reader.read()
          checkDeadline()
          text += decoder.decode(value, { stream: !done })
          if (done) break
        }
      } finally {
        reader.releaseLock()
        reader = undefined
      }
    }
    let value: unknown
    let parseError: unknown
    try { value = JSON.parse(text) } catch (error) { parseError = error }
    // JSON.parse is synchronous: reject an over-budget parse as soon as it returns.
    checkDeadline()
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      async json() {
        if (parseError) throw parseError
        return value
      },
    }
  }

  try {
    return await Promise.race([read(), aborted])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
