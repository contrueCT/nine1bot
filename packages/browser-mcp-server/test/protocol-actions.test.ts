import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeServer } from '../src/bridge/server'
import { captureScreenshot, createCdpTarget, navigateToUrl } from '../src/core/cdp'

type Command = { path: string; method: string; params?: any }
let server: ReturnType<typeof Bun.serve>
let bridge: BridgeServer
let commands: Command[]
let requests: Array<{ path: string; query: string; method: string }>
let results: Record<string, any>
let errors: Record<string, string>
let newTarget: any
let newTargetStatus: number
let targets: any[]
let directory: string
let file: string
let cdpUrl: string
let pageWsUrl: string

beforeEach(async () => {
  commands = []
  requests = []
  errors = {}
  results = {
    'Page.navigate': { frameId: 'frame-1' },
    'Page.getLayoutMetrics': { cssContentSize: { width: 1280, height: 5000 } },
    'Page.captureScreenshot': { data: Buffer.from('fixture image').toString('base64') },
    'DOM.getDocument': { root: { nodeId: 42 } },
    'DOM.querySelector': { nodeId: 81 },
  }
  newTarget = { id: 'new-page', type: 'page', title: '', url: 'about:blank' }
  newTargetStatus = 200
  server = Bun.serve<{ path: string }>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      requests.push({ path: url.pathname, query: url.search, method: req.method })
      if (url.pathname === '/json/version') return Response.json({ Browser: 'Chrome/fixture', webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/browser-1` })
      if (url.pathname === '/json/list') return Response.json(targets)
      if (url.pathname === '/json/new') return Response.json(newTarget, { status: newTargetStatus })
      if (url.pathname.startsWith('/devtools/') && server.upgrade(req, { data: { path: url.pathname } })) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        commands.push({ path: ws.data.path, method: message.method, params: message.params })
        const error = errors[message.method] ?? (ws.data.path.includes('/browser/') && message.method.startsWith('Page.') ? 'Page command sent to browser target' : undefined)
        ws.send(JSON.stringify({ id: message.id, ...(error ? { error: { message: error } } : { result: results[message.method] ?? {} }) }))
      },
    },
  })
  cdpUrl = `http://127.0.0.1:${server.port}`
  pageWsUrl = `ws://127.0.0.1:${server.port}/devtools/page/page-1`
  targets = [{ id: 'page-1', type: 'page', webSocketDebuggerUrl: pageWsUrl }]
  bridge = new BridgeServer({ autoLaunch: false, cdpPort: server.port })
  directory = await mkdtemp(join(tmpdir(), 'browser-protocol-'))
  file = join(directory, 'upload.txt')
  await writeFile(file, 'non-sensitive test fixture')
})
afterEach(async () => {
  server?.stop(true)
  if (directory) await rm(directory, { recursive: true, force: true })
})

function userRelay(response: any = {}) {
  const calls: Array<{ method: string; params: any; targetId?: string }> = []
  ;(bridge as any).relay = {
    extensionConnected: () => true,
    getTools: () => [],
    sendCommand: async (method: string, params: any, targetId?: string) => {
      calls.push({ method, params, targetId })
      if (response instanceof Error) throw response
      return response
    },
  }
  return calls
}

const post = (path: string, body: unknown) => bridge.getRoutes().request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

describe('bot CDP protocol and actions', () => {
  test('creates targets using PUT with an escaped raw URL query, preserving query/fragment characters', async () => {
    const url = 'https://example.test/path?a=x%20y&b=two#section=1'
    expect((await createCdpTarget(cdpUrl, url)).id).toBe('new-page')
    const request = requests.find(r => r.path === '/json/new')!
    expect(request.method).toBe('PUT')
    expect(request.query).toBe(`?${encodeURIComponent(url)}`)
    expect(decodeURIComponent(request.query.slice(1))).toBe(url)
    expect(await bridge.navigate('', { action: 'new_tab', url }, 'bot')).toEqual({ tabId: 'new-page' })
  })

  test('does not report new-tab success for HTTP or malformed-target failures', async () => {
    await expect(createCdpTarget(cdpUrl, 'not a URL')).rejects.toThrow('invalid URL')
    expect(requests.some(r => r.path === '/json/new')).toBe(false)
    newTargetStatus = 500
    await expect(bridge.navigate('', { action: 'new_tab' }, 'bot')).rejects.toThrow('500')
    newTargetStatus = 200
    for (const value of [{}, { id: '', type: 'page' }, { id: 123, type: 'page' }, { id: 'x', type: 'service_worker' }]) {
      newTarget = value
      await expect(createCdpTarget(cdpUrl, 'about:blank')).rejects.toThrow('invalid page target')
    }
  })

  test('propagates navigation errorText and protocol errors from core and bridge', async () => {
    results['Page.navigate'] = { frameId: 'frame-1', errorText: 'net::ERR_NAME_NOT_RESOLVED' }
    await expect(navigateToUrl(pageWsUrl, 'https://invalid.test')).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED')
    await expect(bridge.navigate('page-1', { url: 'https://invalid.test' }, 'bot')).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED')
    errors['Page.navigate'] = 'Invalid URL'
    await expect(bridge.navigate('page-1', { url: 'bad-url' }, 'bot')).rejects.toThrow('Invalid URL')
    delete errors['Page.navigate']
    results['Page.navigate'] = { frameId: 'frame-1' }
    expect(await bridge.navigate('page-1', { url: 'https://example.test' }, 'bot')).toEqual({})
  })

  test('handles dialogs on the selected page websocket and propagates no-dialog errors', async () => {
    await bridge.handleDialog('page-1', 'accept', 'answer', 'bot')
    expect(commands).toEqual([
      { path: '/devtools/page/page-1', method: 'Page.enable' },
      { path: '/devtools/page/page-1', method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'answer' } },
    ])
    errors['Page.handleJavaScriptDialog'] = 'No dialog is showing'
    await expect(bridge.handleDialog('page-1', 'dismiss', undefined, 'bot')).rejects.toThrow('No dialog is showing')
  })

  test('rejects missing, unknown and non-page dialog targets without sending a command', async () => {
    await expect(bridge.handleDialog('', 'accept', undefined, 'bot')).rejects.toThrow('tabId is required')
    await expect(bridge.handleDialog('missing', 'accept', undefined, 'bot')).rejects.toThrow('Target not found')
    targets = [{ id: 'worker', type: 'service_worker', webSocketDebuggerUrl: pageWsUrl }]
    await expect(bridge.handleDialog('worker', 'accept', undefined, 'bot')).rejects.toThrow('not a browser page')
    expect(commands).toHaveLength(0)
  })

  test('uploads only a readable regular host file using real DOM node IDs', async () => {
    await bridge.uploadFile('page-1', 'ref_abc123', file, 'bot')
    expect(commands.map(c => c.method)).toEqual(['DOM.enable', 'DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles'])
    expect(commands[2].params).toEqual({ nodeId: 42, selector: '[data-mcp-ref="ref_abc123"]' })
    expect(commands[3].params).toEqual({ nodeId: 81, files: [file] })
    expect(commands.every(c => c.path === '/devtools/page/page-1')).toBe(true)
  })

  test('rejects invalid upload paths, refs and unavailable targets before changing an input', async () => {
    await expect(bridge.uploadFile('page-1', 'ref_abc', 'relative.txt', 'bot')).rejects.toThrow('absolute path')
    await expect(bridge.uploadFile('page-1', 'ref_abc', join(directory, 'missing'), 'bot')).rejects.toThrow()
    await expect(bridge.uploadFile('page-1', 'ref_abc', directory, 'bot')).rejects.toThrow('regular file')
    await expect(bridge.uploadFile('page-1', 'bad"] input', file, 'bot')).rejects.toThrow('Invalid file input ref')
    await expect(bridge.uploadFile('missing', 'ref_abc', file, 'bot')).rejects.toThrow('Target not found')
    expect(commands).toHaveLength(0)
  })

  test('propagates missing element and CDP upload failure instead of claiming success', async () => {
    results['DOM.querySelector'] = { nodeId: 0 }
    await expect(bridge.uploadFile('page-1', 'ref_abc', file, 'bot')).rejects.toThrow('not found in DOM')
    expect(commands.some(c => c.method === 'DOM.setFileInputFiles')).toBe(false)
    results['DOM.querySelector'] = { nodeId: 81 }
    errors['DOM.setFileInputFiles'] = 'Node is not a file input element'
    await expect(bridge.uploadFile('page-1', 'ref_abc', file, 'bot')).rejects.toThrow('not a file input')
  })

  test('captures full-page images with layout bounds and rejects unavailable bounds', async () => {
    const image = await bridge.screenshot('page-1', { fullPage: true, format: 'jpeg', quality: 60 }, 'bot')
    expect(image.mimeType).toBe('image/jpeg')
    expect(commands.find(c => c.method === 'Page.captureScreenshot')?.params).toEqual({
      format: 'jpeg', quality: 60, fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: 5000, scale: 1 },
    })
    commands = []
    results['Page.getLayoutMetrics'] = {}
    await expect(captureScreenshot(pageWsUrl, { fullPage: true })).rejects.toThrow('invalid page layout metrics')
    expect(commands.some(c => c.method === 'Page.captureScreenshot')).toBe(false)
    results['Page.captureScreenshot'] = {}
    await expect(captureScreenshot(pageWsUrl)).rejects.toThrow('missing data')
  })
})

describe('user browser bridge errors and routing', () => {
  test('propagates extension isError and navigation errorText', async () => {
    userRelay({ frameId: 'main', errorText: 'net::ERR_ABORTED' })
    await expect(bridge.navigate('17', { url: 'https://example.test' }, 'user')).rejects.toThrow('net::ERR_ABORTED')
    userRelay({ isError: true, content: [{ type: 'text', text: 'Navigation rejected by Chrome' }] })
    await expect(bridge.navigate('17', { url: 'https://example.test' }, 'user')).rejects.toThrow('Navigation rejected by Chrome')
    userRelay({ isError: true, content: [{ type: 'text', text: 'Tabs are not editable right now' }] })
    await expect(bridge.navigate('17', { action: 'new_tab' }, 'user')).rejects.toThrow('Tabs are not editable')
  })

  test('rejects malformed new-tab responses and returns only a valid tab ID', async () => {
    for (const text of ['not json', '{}', 'null', '{"id":-1}', '{"id":"17"}', '{"id":1.2}']) {
      userRelay({ content: [{ type: 'text', text }] })
      await expect(bridge.navigate('17', { action: 'new_tab' }, 'user')).rejects.toThrow('New tab failed')
    }
    userRelay({ content: [{ type: 'text', text: '{"id":18}' }] })
    expect(await bridge.navigate('17', { action: 'new_tab' }, 'user')).toEqual({ tabId: '18' })
  })

  test('routes dialog and reload to the requested tab and preserves screenshot options', async () => {
    const calls = userRelay({ data: 'fixture-image' })
    await bridge.handleDialog('17', 'dismiss', undefined, 'user')
    await bridge.navigate('17', { action: 'reload' }, 'user')
    expect(await bridge.screenshot('17', { fullPage: true, format: 'jpeg', quality: 70 }, 'user')).toEqual({ data: 'fixture-image', mimeType: 'image/jpeg' })
    expect(calls).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: false }, targetId: '17' },
      { method: 'Page.reload', params: {}, targetId: '17' },
      { method: 'Page.captureScreenshot', params: { fullPage: true, format: 'jpeg', quality: 70 }, targetId: '17' },
    ])
  })

  test('explicitly rejects user-browser upload without transmitting server paths', async () => {
    const calls = userRelay()
    await expect(bridge.uploadFile('17', 'ref_abc', file, 'user')).rejects.toThrow('not supported in the user browser')
    expect(calls).toHaveLength(0)
  })

  test('propagates missing user targets and disconnected channels', async () => {
    await expect(bridge.handleDialog('17', 'accept', undefined, 'user')).rejects.toThrow('not connected')
    userRelay(new Error('Browser target not found: 99'))
    await expect(bridge.handleDialog('99', 'accept', undefined, 'user')).rejects.toThrow('Browser target not found')
    await expect(bridge.screenshot('99', {}, 'user')).rejects.toThrow('Browser target not found')
  })

  test('HTTP dialog requires a tab and valid action; command errors produce ok:false', async () => {
    const calls = userRelay(new Error('No dialog is showing'))
    expect((await post('/dialog?browser=user', { action: 'accept' })).status).toBe(400)
    expect((await post('/dialog?browser=user', { tabId: '17', action: 'other' })).status).toBe(400)
    expect(calls).toHaveLength(0)
    const response = await post('/dialog?browser=user', { tabId: '17', action: 'accept' })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: 'Error: No dialog is showing' })
    const botResponse = await post('/dialog?browser=bot', { tabId: 'page-1', action: 'dismiss' })
    expect(await botResponse.json()).toEqual({ ok: true })
  })
})
