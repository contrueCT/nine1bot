import { afterEach, describe, expect, it } from 'bun:test'
import { fetchJsonResponse } from '../src/api/request-lifetime'

const nativeFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = nativeFetch })

describe('finite JSON request lifetime', () => {
  it('times out and cancels a stalled body after headers have arrived', async () => {
    let cancelled = false
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = async (_, options) => {
      requestSignal = options?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')) },
        cancel() { cancelled = true },
      }))
    }
    await expect(fetchJsonResponse('/slow-body', {}, 10)).rejects.toThrow('Request timed out')
    expect(requestSignal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('preserves caller cancellation while reading a response body', async () => {
    const controller = new AbortController()
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({
      cancel() { cancelled = true },
    }))
    const loading = fetchJsonResponse('/cancel-body', { signal: controller.signal }, 1000)
    await Promise.resolve()
    controller.abort(new DOMException('Navigation changed', 'AbortError'))
    await expect(loading).rejects.toThrow('Navigation changed')
    expect(cancelled).toBe(true)
  })

  it('does not start an already cancelled request', async () => {
    let called = false
    globalThis.fetch = async () => { called = true; return Response.json({}) }
    const controller = new AbortController()
    controller.abort()
    await expect(fetchJsonResponse('/cancelled', { signal: controller.signal })).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('reports a parse that exceeds the total deadline and clears timers after success', async () => {
    const nativeParse = JSON.parse
    const nativeNow = Date.now
    let now = nativeNow()
    globalThis.fetch = async () => Response.json({ ok: true })
    Date.now = () => now
    JSON.parse = ((text: string) => { now += 100; return nativeParse(text) }) as typeof JSON.parse
    try {
      await expect(fetchJsonResponse('/slow-parse', {}, 50)).rejects.toThrow('Request timed out')
    } finally {
      JSON.parse = nativeParse
      Date.now = nativeNow
    }

    let requestSignal: AbortSignal | undefined
    globalThis.fetch = async (_, options) => {
      requestSignal = options?.signal ?? undefined
      return Response.json({ ok: true })
    }
    expect(await (await fetchJsonResponse('/complete', {}, 10)).json()).toEqual({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requestSignal?.aborted).toBe(false)
  })

  it('retains HTTP metadata and defers malformed JSON errors to json consumers', async () => {
    globalThis.fetch = async () => new Response('invalid', { status: 503 })
    const response = await fetchJsonResponse('/unavailable')
    expect(response.ok).toBe(false)
    expect(response.status).toBe(503)
    await expect(response.json()).rejects.toThrow()
    globalThis.fetch = async () => new Response(null, { status: 204 })
    expect((await fetchJsonResponse('/no-content')).status).toBe(204)
  })
})
