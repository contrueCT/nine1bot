import { describe, expect, test } from 'bun:test'
import { BridgeServer } from '../src/bridge/server'
import { buildResolveRefExpression } from '../src/core/page-scripts/resolve-ref'

function fixture() {
  let present = true
  let scrolls = 0
  const element = {
    tagName: 'BUTTON',
    rect: { x: 20, y: 1500, width: 100, height: 30 },
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect() { return this.rect },
    scrollIntoView(options: any) {
      expect(options.behavior).toBe('instant')
      scrolls++
      onScroll()
    },
  }
  let onScroll = () => { element.rect = { x: 40, y: 200, width: 120, height: 40 } }
  const document = { querySelector: () => present ? element : null }
  const window = { innerHeight: 720, innerWidth: 1280, getComputedStyle: () => element.style }
  const evaluate = (expression: string) => new Function('document', 'window', 'CSS', `return ${expression}`)(document, window, { escape: (value: string) => value })
  return { element, evaluate, get scrolls() { return scrolls }, setScroll(fn: () => void) { onScroll = fn }, remove() { present = false } }
}

async function bridgeFixture(channel: 'user' | 'bot') {
  const dom = fixture()
  const mouse: any[] = []
  const execute = (method: string, params: any) => {
    if (method === 'Runtime.evaluate') return { result: { value: dom.evaluate(params.expression) } }
    if (method === 'Input.dispatchMouseEvent') mouse.push(params)
    return {}
  }
  if (channel === 'user') {
    const bridge = new BridgeServer()
    ;(bridge as any).relay = { extensionConnected: () => true, getTools: () => [], sendCommand: async (method: string, params: any) => execute(method, params) }
    return { dom, mouse, bridge, stop: () => {} }
  }
  // A synthetic CDP transport, never an installed or real browser.
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname
      if (path === '/json/version') return Response.json({ Browser: 'Chrome/fixture' })
      if (path === '/json/list') return Response.json([{ id: '123', type: 'page', title: 'Fixture', url: 'https://fixture.test', webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/123` }])
      if (server.upgrade(request)) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(socket, data) {
        const { id, method, params } = JSON.parse(String(data))
        try { socket.send(JSON.stringify({ id, result: execute(method, params) })) }
        catch (error) { socket.send(JSON.stringify({ id, error: { message: String(error) } })) }
      },
    },
  })
  return { dom, mouse, bridge: new BridgeServer({ cdpPort: server.port, autoLaunch: false }), stop: () => server.stop(true) }
}

test('reference geometry distinguishes CSS visibility from viewport presence', () => {
  const dom = fixture()
  const resolved = JSON.parse(dom.evaluate(buildResolveRefExpression('ref_below_fold')))
  expect(resolved.visible).toBe(true)
  expect(resolved.inViewport).toBe(false)
})
for (const channel of ['user', 'bot'] as const) {
  describe(`${channel} browser snapshot-ref interaction`, () => {
    test('scrolls an offscreen element and clicks newly resolved coordinates', async () => {
      const f = await bridgeFixture(channel)
      try {
        await f.bridge.clickElement('123', { ref: 'ref_below_fold' }, channel)
        expect(f.dom.scrolls).toBe(1)
        expect(f.mouse.map(({ x, y }) => [x, y])).toEqual([[100, 220], [100, 220], [100, 220]])
      } finally { f.stop() }
    })
    test('uses the visible intersection for partially clipped and oversized elements', async () => {
      const f = await bridgeFixture(channel)
      try {
        f.dom.element.rect = { x: -500, y: 690, width: 600, height: 100 }
        await f.bridge.clickElement('123', { ref: 'ref_partial' }, channel)
        expect(f.dom.scrolls).toBe(0)
        expect(f.mouse[0]).toMatchObject({ x: 50, y: 705 })
      } finally { f.stop() }
    })
    for (const kind of ['hidden', 'zero-sized', 'removed', 'unscrollable'] as const) {
      test(`does not send mouse input for a ${kind} reference`, async () => {
        const f = await bridgeFixture(channel)
        try {
          if (kind === 'hidden') f.dom.element.style.display = 'none'
          if (kind === 'zero-sized') f.dom.element.rect.width = 0
          if (kind === 'removed') f.dom.setScroll(() => f.dom.remove())
          if (kind === 'unscrollable') f.dom.setScroll(() => {})
          await expect(f.bridge.clickElement('123', { ref: 'ref_unusable' }, channel)).rejects.toThrow(/visible|interactable/)
          expect(f.mouse).toHaveLength(0)
        } finally { f.stop() }
      })
    }
  })
}
