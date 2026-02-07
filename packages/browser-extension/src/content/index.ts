/**
 * Nine1Bot Browser Control Extension - Content Script
 *
 * This script is injected into web pages and handles DOM-related operations
 * that need to run in the context of the page.
 */

console.log('[Nine1Bot Content Script] Loaded on:', window.location.href)

// Listen for messages from the background service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nine1bot-content-request') {
    handleContentRequest(message.action, message.params)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => sendResponse({ success: false, error: String(error) }))
    return true // Will respond asynchronously
  }
})

// Handle content script specific requests
async function handleContentRequest(action: string, params: unknown): Promise<unknown> {
  switch (action) {
    case 'getPageInfo':
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
      }

    case 'scrollTo':
      const { x = 0, y = 0 } = params as { x?: number; y?: number }
      window.scrollTo(x, y)
      return { scrolledTo: { x, y } }

    case 'getScrollPosition':
      return {
        x: window.scrollX,
        y: window.scrollY,
        maxX: document.documentElement.scrollWidth - window.innerWidth,
        maxY: document.documentElement.scrollHeight - window.innerHeight,
      }

    case 'getViewportSize':
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }

    case 'highlightElement':
      const { ref, duration = 2000 } = params as { ref: string; duration?: number }
      const element = document.querySelector(`[data-mcp-ref="${ref}"]`)
      if (element) {
        const originalOutline = (element as HTMLElement).style.outline
        ;(element as HTMLElement).style.outline = '3px solid red'
        setTimeout(() => {
          ;(element as HTMLElement).style.outline = originalOutline
        }, duration)
        return { highlighted: true }
      }
      return { highlighted: false, error: 'Element not found' }

    case 'clickElement':
      const { ref: clickRef } = params as { ref: string }
      const clickElement = document.querySelector(`[data-mcp-ref="${clickRef}"]`) as HTMLElement
      if (clickElement) {
        clickElement.click()
        return { clicked: true }
      }
      return { clicked: false, error: 'Element not found' }

    case 'focusElement':
      const { ref: focusRef } = params as { ref: string }
      const focusElement = document.querySelector(`[data-mcp-ref="${focusRef}"]`) as HTMLElement
      if (focusElement) {
        focusElement.focus()
        return { focused: true }
      }
      return { focused: false, error: 'Element not found' }

    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: 'nine1bot-content-ready', url: window.location.href }).catch(() => {
  // Extension context may not be available on some pages
})
