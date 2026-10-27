import { describe, expect, it } from 'bun:test'
import { createFrameDeltaBuffer } from '../src/composables/streaming-render-buffer'

describe('createFrameDeltaBuffer', () => {
  it('applies coalesced deltas at most once per animation frame', () => {
    const frames: Array<() => void> = []
    const applied: Array<{ messageID: string; partID: string; field: string; delta: string }> = []
    const buffer = createFrameDeltaBuffer({
      schedule(callback) {
        frames.push(callback)
        return frames.length
      },
      cancel() {},
      apply(delta) {
        applied.push(delta)
      },
    })

    buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'hel' })
    buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'lo' })

    expect(frames).toHaveLength(1)
    expect(applied).toHaveLength(0)
    frames[0]()
    expect(applied).toEqual([
      { messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'hello' },
    ])
  })

  it('flushes a part synchronously before a full checkpoint replaces it', () => {
    const frames: Array<() => void> = []
    const applied: string[] = []
    const buffer = createFrameDeltaBuffer({
      schedule(callback) {
        frames.push(callback)
        return frames.length
      },
      cancel() {},
      apply(delta) {
        applied.push(delta.delta)
      },
    })

    buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'hello' })
    buffer.flush('part_1')

    expect(applied).toEqual(['hello'])
    frames[0]()
    expect(applied).toEqual(['hello'])
  })

  it('falls back to setTimeout when the document is hidden (background tab)', async () => {
    const applied: string[] = []
    const globalRef = globalThis as Record<string, unknown>
    const originalDocument = globalRef.document
    const originalRaf = globalRef.requestAnimationFrame
    const originalCancelRaf = globalRef.cancelAnimationFrame
    globalRef.document = { hidden: true }
    globalRef.requestAnimationFrame = () => {
      throw new Error('requestAnimationFrame must not be used while the tab is hidden')
    }
    globalRef.cancelAnimationFrame = () => {
      throw new Error('cancelAnimationFrame must not be used while the tab is hidden')
    }
    try {
      const buffer = createFrameDeltaBuffer({
        apply(delta) {
          applied.push(delta.delta)
        },
      })
      buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'x' })
      // 默认调度在后台标签页改走 setTimeout(100ms)，delta 不应一直积压
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(applied).toEqual(['x'])
    } finally {
      globalRef.document = originalDocument
      globalRef.requestAnimationFrame = originalRaf
      globalRef.cancelAnimationFrame = originalCancelRaf
    }
  })

  it('drains a foreground frame even when the tab becomes hidden before it fires', async () => {
    const original = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
    const frames: Array<() => void> = []
    const applied: string[] = []
    Object.assign(globalThis, { document: { hidden: false }, requestAnimationFrame: (callback: () => void) => frames.push(callback), cancelAnimationFrame() {} })
    const buffer = createFrameDeltaBuffer({ apply: delta => applied.push(delta.delta) })
    try {
      buffer.push({ messageID: 'm', partID: 'p', field: 'text', delta: '前台' })
      ;(document as unknown as { hidden: boolean }).hidden = true
      buffer.push({ messageID: 'm', partID: 'p', field: 'text', delta: '后台' })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(applied).toEqual(['前台后台'])
      frames[0]()
      expect(applied).toEqual(['前台后台'])
    } finally {
      buffer.clear()
      Object.assign(globalThis, original)
    }
  })

  it('bounds queued characters without dropping or reordering output', () => {
    const frames: Array<() => void> = []
    const applied: string[] = []
    const buffer = createFrameDeltaBuffer({ maxPendingCharacters: 5, schedule: callback => frames.push(callback), cancel() {}, apply: delta => applied.push(delta.delta) })
    for (const text of ['abc', 'def', 'large delta', 'z']) buffer.push({ messageID: 'm', partID: 'p', field: 'text', delta: text })
    expect(applied).toEqual(['abc', 'def', 'large delta'])
    buffer.flush()
    expect(applied.join('')).toBe('abcdeflarge deltaz')
    frames.forEach(callback => callback())
    expect(applied.join('')).toBe('abcdeflarge deltaz')
  })

  it('ignores canceled callbacks after clearing and reusing the buffer', () => {
    const frames: Array<() => void> = []
    const applied: string[] = []
    const buffer = createFrameDeltaBuffer({ schedule: callback => frames.push(callback), cancel() {}, apply: delta => applied.push(delta.delta) })
    buffer.push({ messageID: 'old', partID: 'p', field: 'text', delta: 'old' })
    buffer.clear()
    buffer.push({ messageID: 'new', partID: 'p', field: 'text', delta: 'new' })
    frames[0]()
    expect(applied).toEqual([])
    frames[1]()
    expect(applied).toEqual(['new'])
  })
})
