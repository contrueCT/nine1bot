import { expect, test } from 'bun:test'
import WebSocket from 'ws'
import { cleanupResources, within } from './harness'

// This is a runtime regression, not a browser test. Ordinary CI remains on Bun
// 1.3.14, which has upstream bug oven-sh/bun#36223; the real-Chrome job enables
// this check explicitly on its fixed, pinned runtime before launching Chrome.
const enabled = process.env.RUN_BROWSER_RUNTIME_CHECKS === '1'
if (!enabled) console.info('[browser-runtime] SKIPPED: set RUN_BROWSER_RUNTIME_CHECKS=1; requires the real-Chrome fixture runtime')

test.skipIf(!enabled)('fixture runtime awaits server shutdown after a server-initiated WebSocket close', async () => {
  let socket: Bun.ServerWebSocket<unknown> | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request, owner) => owner.upgrade(request) ? undefined : new Response('fixture'),
    websocket: { open: ws => { socket = ws }, message() {} },
  })
  const client = new WebSocket(`ws://127.0.0.1:${server.port}`)
  const failures: unknown[] = []
  try {
    await within('fixture WebSocket open', new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve(), { once: true })
      client.addEventListener('error', () => reject(new Error('Fixture WebSocket failed to open')), { once: true })
    }), 1000)
    expect(socket).toBeDefined()
    const closed = new Promise<void>(resolve => client.addEventListener('close', () => resolve(), { once: true }))
    // The real relay-disconnect assertion also closes the socket from the server.
    socket!.close(1001, 'fixture disconnect')
    await within('client observes server close', closed, 1000)
    expect(client.readyState).toBe(WebSocket.CLOSED)
  } catch (error) {
    failures.push(error)
  } finally {
    client.terminate()
    const results = await cleanupResources([{ name: 'fixture server shutdown', dispose: async () => {
      await server.stop(true)
      expect(server.pendingRequests).toBe(0)
      expect(server.pendingWebSockets).toBe(0)
    } }], 1000)
    // A broken runtime must fail promptly without retaining the test process.
    // unref does not turn a timeout into success; every failure is thrown below.
    server.unref()
    for (const result of results) if (result.status === 'failed') failures.push(result.error)
  }
  if (failures.length) throw new AggregateError(failures, `Fixture cleanup failed on Bun ${Bun.version}`)
}, 5000)
