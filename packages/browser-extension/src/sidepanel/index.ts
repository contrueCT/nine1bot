const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:4096'
let currentFrameOrigin = DEFAULT_SERVER_ORIGIN

function normalizeServerOrigin(serverOrigin: string): string {
  try {
    const parsed = new URL(serverOrigin)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return DEFAULT_SERVER_ORIGIN
  }
}

function relayUrlToWebUrl(relayUrl: string): string {
  try {
    const parsed = new URL(relayUrl)
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    return `${scheme}//${parsed.host}`
  } catch {
    return DEFAULT_SERVER_ORIGIN
  }
}

async function getWebUiUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.sync.get({
      serverOrigin: '',
      webUiUrl: '',
      relayUrl: '',
    })

    const serverOrigin = typeof stored.serverOrigin === 'string' && stored.serverOrigin.trim()
      ? normalizeServerOrigin(stored.serverOrigin)
      : typeof stored.webUiUrl === 'string' && stored.webUiUrl.trim()
        ? normalizeServerOrigin(stored.webUiUrl)
        : typeof stored.relayUrl === 'string' && stored.relayUrl.trim()
          ? relayUrlToWebUrl(stored.relayUrl)
          : DEFAULT_SERVER_ORIGIN

    await chrome.storage.sync.set({ serverOrigin })
    await chrome.storage.sync.remove(['webUiUrl', 'relayUrl'])
    return serverOrigin
  } catch {
    // ignore
  }
  return DEFAULT_SERVER_ORIGIN
}

async function checkExtensionHealth(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'nine1bot-sidepanel-health-check' })
    return Boolean(response?.connected)
  } catch {
    return false
  }
}

function setStatus(connected: boolean): void {
  const status = document.getElementById('status')
  if (!status) return
  status.textContent = connected ? 'relay connected' : 'relay disconnected'
  status.classList.toggle('connected', connected)
}

function showFallback(targetUrl: string, visible: boolean): void {
  const fallback = document.getElementById('fallback')
  const target = document.getElementById('target-url')
  const frame = document.getElementById('app-frame') as HTMLIFrameElement | null
  if (!fallback || !target || !frame) return

  target.textContent = targetUrl
  fallback.classList.toggle('visible', visible)
  frame.style.display = visible ? 'none' : 'block'
}

async function mountFrame(): Promise<void> {
  const targetUrl = await getWebUiUrl()
  const frame = document.getElementById('app-frame') as HTMLIFrameElement | null
  if (!frame) return

  currentFrameOrigin = normalizeServerOrigin(targetUrl)
  showFallback(targetUrl, false)
  frame.src = targetUrl

  let loaded = false
  const fallbackTimer = setTimeout(() => {
    if (!loaded) {
      showFallback(targetUrl, true)
    }
  }, 3000)

  frame.onload = () => {
    loaded = true
    clearTimeout(fallbackTimer)
    showFallback(targetUrl, false)
  }
}

async function handleFrameMessage(event: MessageEvent): Promise<void> {
  const frame = document.getElementById('app-frame') as HTMLIFrameElement | null
  if (!frame || event.source !== frame.contentWindow) return
  if (event.origin !== currentFrameOrigin) return

  const message = event.data as { type?: string; requestId?: unknown } | undefined
  if (message?.type !== 'nine1bot.requestPageContext' || typeof message.requestId !== 'string') return

  const payload = await collectActiveTabPageContext().catch((error) => {
    console.warn('[SidePanel] Failed to collect page context:', error)
    return undefined
  })

  frame.contentWindow?.postMessage(
    {
      type: 'nine1bot.pageContext',
      requestId: message.requestId,
      payload,
    },
    currentFrameOrigin,
  )
}

async function collectActiveTabPageContext(): Promise<unknown | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return undefined

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'nine1bot-content-request',
    action: 'collectPageContext',
    params: {},
  }).catch(() => undefined)

  if (!response?.success) return undefined
  return response.result
}

async function init(): Promise<void> {
  const connected = await checkExtensionHealth()
  setStatus(connected)
  window.addEventListener('message', (event) => {
    handleFrameMessage(event).catch((error) => {
      console.warn('[SidePanel] Failed to handle frame message:', error)
    })
  })
  await mountFrame()

  const reloadButton = document.getElementById('reload')
  reloadButton?.addEventListener('click', () => {
    mountFrame().catch((error) => {
      console.warn('[SidePanel] Failed to reload frame:', error)
    })
  })
}

init().catch((error) => {
  console.error('[SidePanel] Failed to initialize:', error)
})
