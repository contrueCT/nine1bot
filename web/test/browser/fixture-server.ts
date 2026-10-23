import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { ScreenBuffer } from '../../../opencode/packages/opencode/src/pty/screen-buffer'
import { captureBufferSnapshot } from '../../../opencode/packages/opencode/src/pty/buffer-snapshot'

// Only the HTTP API is a fixture. Vue SFCs, xterm, DOMPurify and the Markdown
// Worker are imported by Vite unchanged and run in the browser.
export async function startBrowserFixture(port = 0) {
  let result!: (value: any) => void
  const completed = new Promise<any>(resolve => { result = resolve })
  let pauseBuffer = false
  let pauseScreen = false
  let bufferCalls = 0
  let buffer: { buffer: string; latestSeq: number; screen?: { screenAnsi: string; cursor: { row: number; col: number } } } = { buffer: 'history\r\n', latestSeq: 1 }
  const pendingBuffers: Array<() => void> = []
  const pendingScreens: Array<() => void> = []
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const server = await createServer({
    root, configFile: `${root}/vite.config.ts`,
    resolve: { dedupe: ['vue'] },
    server: { host: '127.0.0.1', port, strictPort: port !== 0 },
    plugins: [{ name: 'web-lifecycle-fixture', configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url!, 'http://localhost').pathname
        const json = (data: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)) }
        if (path === '/__fixture/result' && request.method === 'POST') {
          let body = ''
          for await (const chunk of request) body += chunk
          result(JSON.parse(body)); json({ ok: true }); return
        }
        if (path === '/__fixture/control' && request.method === 'POST') {
          let body = ''
          for await (const chunk of request) body += chunk
          const settings = JSON.parse(body)
          pauseBuffer = Boolean(settings.pauseBuffer)
          pauseScreen = Boolean(settings.pauseScreen)
          if (settings.buffer) buffer = settings.buffer
          if (settings.truncated) {
            const parsed = new ScreenBuffer.Buffer({ rows: 24, cols: 80 })
            try {
              const raw = 'HEADER\r\n' + '\rSTATUS 50%'.repeat(220000) + (settings.tail || '')
              void parsed.write(raw)
              buffer = await captureBufferSnapshot({ buffer: parsed, rawBuffer: raw.slice(-2 * 1024 * 1024), outputSeq: settings.latestSeq ?? 10, outputChunks: [] })
            } finally { parsed.dispose() }
          }
          if (settings.clearCounts) bufferCalls = 0
          json({ ok: true }); return
        }
        if (path === '/__fixture/state') { json({ bufferCalls, pendingBuffers: pendingBuffers.length, pendingScreens: pendingScreens.length }); return }
        if (path === '/__fixture/release-buffer') { pauseBuffer = false; pendingBuffers.splice(0).forEach(reply => reply()); json({ ok: true }); return }
        if (path === '/__fixture/release-screen') { pauseScreen = false; pendingScreens.splice(0).forEach(reply => reply()); json({ ok: true }); return }
        if (path === '/agent-terminal') {
          json([{ id: 'term', sessionID: 'fixture', name: 'Fixture terminal', status: 'running', rows: 24, cols: 80, createdAt: 1, lastActivity: 1 }]); return
        }
        if (path === '/agent-terminal/term/screen') {
          const reply = () => json({ sessionID: 'fixture', screen: 'old screen', screenAnsi: 'old screen', cursor: { row: 0, col: 3 } })
          if (pauseScreen) pendingScreens.push(reply); else reply()
          return
        }
        if (path === '/agent-terminal/term/buffer') {
          bufferCalls++
          const snapshot = { ...buffer, chunks: [], firstSeq: 1, reset: true }
          const reply = () => json(snapshot)
          if (pauseBuffer) pendingBuffers.push(reply); else reply()
          return
        }
        if (path.startsWith('/agent-terminal/term/')) { json({ ok: true }); return }
        next()
      })
    } }],
  })
  await server.listen()
  return { url: `${server.resolvedUrls!.local[0]}test/browser/index.html`, completed, close: () => server.close() }
}

if (import.meta.main) {
  const fixture = await startBrowserFixture(Number(process.env.PORT || 41874))
  console.log(fixture.url)
  console.log(JSON.stringify(await fixture.completed, null, 2))
  // Keep the visible report available until the developer stops this process.
}
