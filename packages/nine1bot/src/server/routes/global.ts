import { Hono } from 'hono'
import type { EngineManager } from '../../engine'
import type { ShellGlobalEventEnvelope } from '../events'
import { ShellGlobalEvents } from '../events'

interface GlobalRoutesOptions {
  engineManager: EngineManager
  globalEvents: ShellGlobalEvents
}

function formatSse(event: ShellGlobalEventEnvelope) {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function createGlobalRoutes(options: GlobalRoutesOptions) {
  return new Hono().get('/event', async (c) => {
    const response = await fetch(`${options.engineManager.currentBaseUrl()}/global/event`, {
      headers: c.req.raw.headers,
      signal: c.req.raw.signal,
    }).catch((error) => {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    if (!response.ok || !response.body) {
      return response
    }

    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-cache, no-transform')
    headers.set('Connection', 'keep-alive')

    const encoder = new TextEncoder()
    const reader = response.body.getReader()

    return new Response(new ReadableStream({
      start(controller) {
        let closed = false
        const unsubscribe = options.globalEvents.subscribe((event) => {
          if (closed) return
          controller.enqueue(encoder.encode(formatSse(event)))
        })

        const abort = () => {
          if (closed) return
          closed = true
          unsubscribe()
          void reader.cancel().catch(() => {})
          controller.close()
        }

        c.req.raw.signal.addEventListener('abort', abort)

        void (async () => {
          try {
            while (!closed) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                controller.enqueue(value)
              }
            }
          } finally {
            if (closed) return
            closed = true
            unsubscribe()
            c.req.raw.signal.removeEventListener('abort', abort)
            controller.close()
          }
        })()
      },
      cancel() {
        void reader.cancel().catch(() => {})
      },
    }), {
      headers,
      status: response.status,
      statusText: response.statusText,
    })
  })
}
