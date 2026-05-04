import type { PlatformControllerBridge } from '@nine1bot/platform-protocol'
import {
  FEISHU_CONTROLLER_CAPABILITIES,
  feishuControllerEntry,
  type FeishuControllerBridge,
  type FeishuControllerAbortSessionInput,
  type FeishuControllerCreateSessionInput,
  type FeishuControllerCreateSessionResult,
  type FeishuControllerMessageResult,
  type FeishuControllerProject,
  type FeishuControllerSendMessageInput,
  type FeishuControllerSession,
  type FeishuInteractionAnswerInput,
  type FeishuRuntimeEventEnvelope,
  type FeishuRuntimeEventSubscription,
} from '../controller-bridge'

export type FeishuHttpControllerBridgeOptions = {
  localUrl: string
  authHeader?: string
  requestTimeoutMs?: number
  platformController?: PlatformControllerBridge
}

export function createHttpFeishuControllerBridge(options: FeishuHttpControllerBridgeOptions): FeishuControllerBridge {
  const request = async <T>(path: string, init: {
    method?: string
    directory?: string
    body?: unknown
    timeoutMs?: number
    signal?: AbortSignal
    acceptSse?: boolean
    allowStatus?: number[]
  } = {}): Promise<{ status: number; ok: boolean; body: T; response: Response }> => {
    const url = new URL(path, options.localUrl)
    const headers = new Headers()
    if (options.authHeader) headers.set('authorization', options.authHeader)
    if (init.directory) {
      headers.set('x-opencode-directory', init.directory)
      if (!url.searchParams.has('directory')) url.searchParams.set('directory', init.directory)
    }
    if (init.acceptSse) {
      headers.set('accept', 'text/event-stream')
    } else if (init.body !== undefined) {
      headers.set('content-type', 'application/json')
    }

    if (options.platformController?.requestJson && !init.acceptSse && !init.allowStatus?.length) {
      const body = await options.platformController.requestJson<T>(`${url.pathname}${url.search}`, {
        method: init.method ?? 'GET',
        headers: headersToRecord(headers),
        body: init.body,
      })
      return {
        status: 200,
        ok: true,
        body,
        response: new Response(JSON.stringify(body), { status: 200 }),
      }
    }

    const timeoutMs = init.timeoutMs ?? options.requestTimeoutMs ?? 30_000
    const controller = new AbortController()
    const timeout = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
      : undefined
    const linkedAbort = () => controller.abort()
    init.signal?.addEventListener('abort', linkedAbort, { once: true })

    try {
      const response = await fetch(url.toString(), {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      })
      const text = await response.text()
      const body = text ? JSON.parse(text) as T : true as T
      if (!response.ok && !init.allowStatus?.includes(response.status)) {
        throw new Error(text || `Request failed: ${response.status} ${response.statusText}`)
      }
      return {
        status: response.status,
        ok: response.ok,
        body,
        response,
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      init.signal?.removeEventListener('abort', linkedAbort)
    }
  }

  return {
    async createSession(input: FeishuControllerCreateSessionInput) {
      const result = await request<FeishuControllerCreateSessionResult>('/nine1bot/agent/sessions', {
        method: 'POST',
        directory: input.directory,
        body: {
          title: input.title,
          directory: input.directory,
          entry: input.entry ?? feishuControllerEntry(),
          context: input.contextBlocks?.length ? { blocks: input.contextBlocks } : undefined,
          clientCapabilities: FEISHU_CONTROLLER_CAPABILITIES,
        },
      })
      return result.body
    },
    async getSession(input) {
      const result = await request<FeishuControllerSession>(`/session/${encodeURIComponent(input.sessionId)}`, {
        directory: input.directory,
        allowStatus: [404],
      }).catch(() => undefined)
      return result?.ok ? result.body : undefined
    },
    async sendMessage(input: FeishuControllerSendMessageInput): Promise<FeishuControllerMessageResult> {
      const result = await request<FeishuControllerMessageResult>(
        `/nine1bot/agent/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          method: 'POST',
          directory: input.directory,
          allowStatus: [409],
          body: {
            messageID: input.messageId,
            parts: input.parts,
            system: input.system,
            context: input.contextBlocks?.length ? { blocks: input.contextBlocks } : undefined,
            entry: input.entry ?? feishuControllerEntry(input.messageId),
            clientCapabilities: FEISHU_CONTROLLER_CAPABILITIES,
          },
        },
      )
      return {
        ...result.body,
        status: result.status,
      }
    },
    async abortSession(input: FeishuControllerAbortSessionInput): Promise<boolean> {
      const result = await request<boolean>(`/session/${encodeURIComponent(input.sessionId)}/abort`, {
        method: 'POST',
        directory: input.directory,
      })
      return Boolean(result.body)
    },
    async answerInteraction(input: FeishuInteractionAnswerInput) {
      const result = await request<boolean>(`/nine1bot/agent/interactions/${encodeURIComponent(input.requestId)}/answer`, {
        method: 'POST',
        body: {
          kind: input.kind,
          answer: input.answer,
          message: input.message,
        },
      })
      return Boolean(result.body)
    },
    async listProjects() {
      const result = await request<FeishuControllerProject[]>('/project')
      return [...result.body].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    },
    async getProject(projectId) {
      const result = await request<FeishuControllerProject>(`/project/${encodeURIComponent(projectId)}`, {
        allowStatus: [404],
      }).catch(() => undefined)
      return result?.ok ? result.body : undefined
    },
    subscribeEvents(input): FeishuRuntimeEventSubscription {
      const abort = new AbortController()
      consumeSse({
        localUrl: options.localUrl,
        authHeader: options.authHeader,
        sessionId: input.sessionId,
        signal: abort.signal,
        onEvent: input.onEvent,
        onError: input.onError,
      }).catch((error) => {
        if (!abort.signal.aborted) {
          void input.onError?.(error instanceof Error ? error : new Error(String(error)))
        }
      })
      return {
        stop() {
          abort.abort()
        },
      }
    },
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

async function consumeSse(input: {
  localUrl: string
  authHeader?: string
  sessionId: string
  signal: AbortSignal
  onEvent: (event: FeishuRuntimeEventEnvelope) => void | Promise<void>
  onError?: (error: Error) => void | Promise<void>
}) {
  const url = new URL(`/nine1bot/agent/sessions/${encodeURIComponent(input.sessionId)}/events`, input.localUrl)
  const headers = new Headers({ accept: 'text/event-stream' })
  if (input.authHeader) headers.set('authorization', input.authHeader)
  const response = await fetch(url.toString(), {
    headers,
    signal: input.signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`Event subscription failed: ${response.status} ${response.statusText}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  const dispatch = async () => {
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n').trimEnd()
    dataLines = []
    if (!payload) return
    const parsed = JSON.parse(payload) as FeishuRuntimeEventEnvelope
    await input.onEvent(parsed)
  }
  const processLine = async (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      await dispatch()
      return
    }
    if (!line.startsWith('data:')) return
    const value = line.slice(5)
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  try {
    while (!input.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        await processLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer) await processLine(buffer)
    await dispatch()
  } finally {
    reader.releaseLock()
  }
}
