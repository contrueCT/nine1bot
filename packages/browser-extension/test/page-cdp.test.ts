import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { executePageCdpCommand } from '../src/background/page-cdp'

const originalChrome = (globalThis as any).chrome
let calls: Array<{ target: { tabId: number }; method: string; params: any }>
let attachments: number[]
let results: Record<string, any>
let failure: string | undefined
const attach = async (tabId: number) => { attachments.push(tabId) }
const send = (method: string, params?: Record<string, unknown>, tabId: number | undefined = 17) =>
  executePageCdpCommand(tabId, method, params, attach)

beforeEach(() => {
  calls = []
  attachments = []
  results = {}
  failure = undefined
  ;(globalThis as any).chrome = {
    debugger: {
      sendCommand: async (target: { tabId: number }, method: string, params: any) => {
        calls.push({ target, method, params })
        if (failure) throw new Error(failure)
        return results[method] ?? {}
      },
    },
  }
})
afterEach(() => { (globalThis as any).chrome = originalChrome })

describe('extension page CDP dispatch', () => {
  test('preserves wheel deltas, modifiers, and protocol fields without inventing click fields', async () => {
    const params = { type: 'mouseWheel', x: 4, y: 5, deltaX: -120, deltaY: 650, modifiers: 8 }
    await send('Input.dispatchMouseEvent', params)
    expect(calls).toEqual([{ target: { tabId: 17 }, method: 'Input.dispatchMouseEvent', params }])
    expect(attachments).toEqual([17])
  })

  test('executes reload and dialog commands on the resolved page', async () => {
    await send('Page.reload', { ignoreCache: true })
    await send('Page.handleJavaScriptDialog', { accept: true, promptText: 'hello' })
    expect(calls.map(c => [c.target.tabId, c.method, c.params])).toEqual([
      [17, 'Page.reload', { ignoreCache: true }],
      [17, 'Page.handleJavaScriptDialog', { accept: true, promptText: 'hello' }],
    ])
  })

  test('uses real document and query node IDs from the same debugger target', async () => {
    results['DOM.getDocument'] = { root: { nodeId: 42 } }
    results['DOM.querySelector'] = { nodeId: 81 }
    const doc = await send('DOM.getDocument') as any
    const query = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
    expect(query).toEqual({ nodeId: 81 })
    expect(calls[1]).toEqual({ target: { tabId: 17 }, method: 'DOM.querySelector', params: { nodeId: 42, selector: 'input[type=file]' } })
  })

  test('rejects host-path uploads and unsupported commands before debugger attachment', async () => {
    await expect(send('DOM.setFileInputFiles', { files: ['/server/file.txt'], nodeId: 42 })).rejects.toThrow('not supported in the user browser')
    await expect(send('Unknown.command')).rejects.toThrow('Unsupported CDP method')
    await expect(send('Target.getTargetInfo')).rejects.toThrow('Unsupported CDP method')
    expect(calls).toHaveLength(0)
    expect(attachments).toHaveLength(0)
  })

  test('rejects missing or invalid tab IDs instead of targeting an arbitrary page', async () => {
    for (const id of [undefined, 0, -1, NaN, Infinity, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(executePageCdpCommand(id, 'Page.reload', {}, attach)).rejects.toThrow('valid managed browser tab')
    }
    expect(calls).toHaveLength(0)
    expect(attachments).toHaveLength(0)
  })

  test('propagates browser attachment, unavailable target and native command errors', async () => {
    await expect(executePageCdpCommand(17, 'Page.reload', {}, async () => { throw new Error('No tab with id 17') })).rejects.toThrow('No tab with id 17')
    failure = 'No dialog is showing'
    await expect(send('Page.handleJavaScriptDialog', { accept: false })).rejects.toThrow('No dialog is showing')
  })

  test('propagates Page.navigate failures and returns the native frame on success', async () => {
    results['Page.navigate'] = { frameId: 'f', errorText: 'net::ERR_NAME_NOT_RESOLVED' }
    await expect(send('Page.navigate', { url: 'https://invalid.test' })).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED')
    results['Page.navigate'] = { frameId: 'native-frame' }
    expect(await send('Page.navigate', { url: 'https://example.test' })).toEqual({ frameId: 'native-frame' })
    failure = 'Navigation rejected'
    await expect(send('Page.navigate', { url: 'https://example.test' })).rejects.toThrow('Navigation rejected')
  })

  test('captures full-page JPEG with real CSS bounds and requested quality', async () => {
    results['Page.getLayoutMetrics'] = { cssContentSize: { x: 0, y: 0, width: 1280, height: 4000 }, contentSize: { width: 2560, height: 8000 } }
    results['Page.captureScreenshot'] = { data: 'fixture-image' }
    expect(await send('Page.captureScreenshot', { fullPage: true, format: 'jpeg', quality: 71 })).toEqual({ data: 'fixture-image' })
    expect(calls.map(c => c.method)).toEqual(['Page.getLayoutMetrics', 'Page.captureScreenshot'])
    expect(calls[1].params).toEqual({
      format: 'jpeg', quality: 71, fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: 4000, scale: 1 },
    })
  })

  test('keeps viewport capture scoped and supports legacy layout metrics', async () => {
    results['Page.captureScreenshot'] = { data: 'fixture-image' }
    await send('Page.captureScreenshot', { fullPage: false })
    expect(calls[0].params).toEqual({ format: 'png' })
    results['Page.getLayoutMetrics'] = { contentSize: { width: 1000, height: 2000 } }
    await send('Page.captureScreenshot', { fullPage: true })
    expect(calls.at(-1)?.params.clip.height).toBe(2000)
  })

  test('does not silently return a viewport screenshot for invalid full-page bounds', async () => {
    for (const size of [undefined, { width: 0, height: 5 }, { width: 100, height: NaN }, { width: Infinity, height: 100 }]) {
      results['Page.getLayoutMetrics'] = { cssContentSize: size }
      await expect(send('Page.captureScreenshot', { fullPage: true })).rejects.toThrow('invalid page layout metrics')
    }
    expect(calls.every(c => c.method === 'Page.getLayoutMetrics')).toBe(true)
    await expect(send('Page.captureScreenshot')).rejects.toThrow('no data returned')
  })
})
