import type { FilePreviewInfo } from '../composables/useFilePreview'
import { decodeBase64Utf8 } from './encoding'

type WindowHost = Pick<Window, 'open' | 'setInterval' | 'clearInterval' | 'addEventListener' | 'removeEventListener'>
type PendingWindow = { url: string; target: Window; expiresAt: number; loaded: boolean }
export const PREVIEW_WINDOW_NAVIGATION_TIMEOUT_MS = 60_000

// Ownership follows the opened window, so changing/closing a Vue preview cannot
// revoke a URL while that window is still navigating to it. No component or
// preview payload is retained here. A loaded window keeps its URL usable for
// reload/save and late reads until it closes or navigates away. One poller owns
// all windows; only a navigation that never loads has a fixed deadline.
export function createPreviewWindowOpener(
  host: WindowHost,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
  now: () => number = () => performance.now(),
) {
  const pending = new Set<PendingWindow>()
  let timer: number | undefined

  function stopWhenIdle() {
    if (pending.size || timer === undefined) return
    host.clearInterval(timer)
    timer = undefined
    host.removeEventListener('pagehide', dispose)
  }

  function release(item: PendingWindow) {
    pending.delete(item)
    urls.revokeObjectURL(item.url)
  }

  function sweep() {
    for (const item of pending) {
      try {
        const target = item.target
        // Check the actual document URL as well as readyState: the initial
        // about:blank document can be complete before blob navigation starts.
        if (target.closed) { release(item); continue }
        const documentURL = target.document.URL.split('#')[0]
        if (documentURL !== item.url && (item.loaded || documentURL !== 'about:blank')) { release(item); continue }
        if (documentURL === item.url && target.document.readyState !== 'loading') item.loaded = true
        if (!item.loaded && now() >= item.expiresAt) release(item)
      } catch {
        // A navigation to another origin has already consumed or left the blob.
        release(item)
      }
    }
    stopWhenIdle()
  }

  function dispose() {
    for (const item of pending) release(item)
    stopWhenIdle()
  }

  function open(preview: Pick<FilePreviewInfo, 'id' | 'mime' | 'content'>): boolean {
    // Locally reopened previews have generated IDs that do not exist in the
    // server registry. Inline content must remain available through a blob.
    if (preview.content === undefined) return Boolean(host.open(`/file/preview/${encodeURIComponent(preview.id)}`, '_blank'))
    const blob = new Blob([decodeBase64Utf8(preview.content)], { type: `${preview.mime};charset=utf-8` })
    const url = urls.createObjectURL(blob)
    let target: Window | null
    try {
      target = host.open(url, '_blank')
    } catch (error) {
      urls.revokeObjectURL(url)
      throw error
    }
    if (!target || target.closed) {
      urls.revokeObjectURL(url)
      return false
    }
    pending.add({ url, target, expiresAt: now() + PREVIEW_WINDOW_NAVIGATION_TIMEOUT_MS, loaded: false })
    if (timer === undefined) {
      timer = host.setInterval(sweep, 500)
      host.addEventListener('pagehide', dispose)
    }
    return true
  }

  return { open, dispose }
}

let opener: ReturnType<typeof createPreviewWindowOpener> | undefined
export function openPreviewInNewTab(preview: Pick<FilePreviewInfo, 'id' | 'mime' | 'content'>) {
  opener ||= createPreviewWindowOpener(window)
  return opener.open(preview)
}
