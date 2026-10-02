import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { computerTool } from '../src/tools/interaction'

const saved = { chrome: (globalThis as any).chrome, document: globalThis.document, window: globalThis.window, CSS: globalThis.CSS }
let element: any, calls: any[], scrolls: number, present: boolean, onScroll: () => void
beforeEach(() => {
  calls = []; scrolls = 0; present = true
  element = {
    rect: { x: 10, y: 1500, width: 100, height: 30 },
    getBoundingClientRect() { return this.rect },
    scrollIntoView(options: any) { expect(options.behavior).toBe('instant'); scrolls++; onScroll() },
    style: { display: 'block', visibility: 'visible', opacity: '1' },
  }
  onScroll = () => { element.rect = { x: 30, y: 100, width: 80, height: 40 } }
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value },
    document: { querySelector: () => present ? element : null },
    window: { innerWidth: 1280, innerHeight: 720, getComputedStyle: () => element.style },
    chrome: {
      scripting: { executeScript: async ({ func, args }: any) => [{ result: func(...args) }] },
      debugger: { attach: async () => {}, onDetach: { addListener() {} }, sendCommand: async (_tab: any, method: string, params: any) => { calls.push({ method, params }); return {} } },
    },
  })
})
afterEach(() => Object.assign(globalThis, saved))
const click = () => computerTool.execute({ action: 'left_click', ref: 'ref_1', tabId: 1 })

describe('extension computer tool reference geometry', () => {
  test('scrolls and re-resolves before sending mouse events', async () => {
    expect((await click()).isError).toBeUndefined()
    expect(scrolls).toBe(1)
    expect(calls.map(call => [call.params.x, call.params.y])).toEqual([[70, 120], [70, 120], [70, 120]])
  })
  test('clicks inside the visible part of an oversized element', async () => {
    element.rect = { x: -500, y: 690, width: 600, height: 100 }
    expect((await click()).isError).toBeUndefined()
    expect(scrolls).toBe(0)
    expect(calls[0].params).toMatchObject({ x: 50, y: 705 })
  })
  for (const kind of ['hidden', 'zero-sized', 'removed', 'unscrollable', 'missing']) {
    test(`does not click ${kind} elements`, async () => {
      if (kind === 'hidden') element.style.visibility = 'hidden'
      if (kind === 'zero-sized') element.rect.width = 0
      if (kind === 'removed') onScroll = () => { present = false }
      if (kind === 'unscrollable') onScroll = () => {}
      if (kind === 'missing') present = false
      expect((await click()).isError).toBe(true)
      expect(calls).toHaveLength(0)
    })
  }
})
