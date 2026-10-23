import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { useFilePreview } from '../src/composables/useFilePreview'

// useFilePreview 使用模块级共享状态，每个用例前清空
function mockFetch() {
  const original = globalThis.fetch
  globalThis.fetch = mock(async (input: any) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.searchParams.get('path') || '/tmp/file.txt'
    return new Response(
      JSON.stringify({
        path,
        filename: path.split('/').pop(),
        mime: 'text/plain',
        content: 'aGk=',
        size: 2,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe('useFilePreview', () => {
  beforeEach(() => {
    useFilePreview().closeAllPreviews()
  })

  it('generates unique preview ids even within the same millisecond', async () => {
    const restore = mockFetch()
    try {
      const { openPreviewByPath, previews } = useFilePreview()
      await openPreviewByPath('/tmp/a.txt')
      await openPreviewByPath('/tmp/a.txt')
      const ids = previews.value.map((preview) => preview.id)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
    } finally {
      restore()
    }
  })

  it('evicts the oldest previews once the 50-entry limit is exceeded', async () => {
    const restore = mockFetch()
    try {
      const { openPreviewByPath, previews, activePreviewId } = useFilePreview()
      for (let i = 0; i < 55; i++) {
        await openPreviewByPath(`/tmp/f${i}.txt`)
      }
      expect(previews.value).toHaveLength(50)
      const paths = previews.value.map((preview) => preview.path)
      // 最早的 5 条被淘汰，保留最新 50 条
      expect(paths).not.toContain('/tmp/f0.txt')
      expect(paths).not.toContain('/tmp/f4.txt')
      expect(paths[0]).toBe('/tmp/f5.txt')
      expect(paths[paths.length - 1]).toBe('/tmp/f54.txt')
      // active 指向最新打开的预览，被淘汰时不悬空
      expect(previews.value.some((preview) => preview.id === activePreviewId.value)).toBe(true)
    } finally {
      restore()
    }
  })

  it('aborts pending opens and ignores late responses when previews are cleared', async () => {
    const original = globalThis.fetch
    let resolve!: (response: Response) => void
    let signal: AbortSignal | undefined
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      signal = init?.signal || undefined
      return new Promise<Response>(done => { resolve = done })
    }) as typeof fetch
    try {
      const preview = useFilePreview()
      const opening = preview.openPreviewByPath('/tmp/late.html')
      preview.closeAllPreviews()
      expect(signal?.aborted).toBe(true)
      resolve(new Response(JSON.stringify({ path: '/tmp/late.html', filename: 'late.html', mime: 'text/html', content: 'aGk=', size: 2 })))
      expect(await opening).toBe(false)
      expect(preview.previews.value).toEqual([])
      expect(preview.activePreviewId.value).toBeNull()
      expect(preview.isPanelOpen.value).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })


  it('times out a preview open that stalls while reading its response body', async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = globalThis.setTimeout
    let deadline!: () => void
    let configuredDeadline: number | undefined
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      deadline = callback
      configuredDeadline = delay
      return 123
    }) as typeof setTimeout
    globalThis.fetch = (async (_input: any, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    }))) as typeof fetch
    try {
      const preview = useFilePreview()
      const opening = preview.openPreviewByPath('/tmp/stalled.html')
      globalThis.setTimeout = originalTimeout
      expect(configuredDeadline).toBe(30_000)
      deadline()
      expect(await opening).toBe(false)
      expect(preview.previews.value).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalTimeout
    }
  })

})
