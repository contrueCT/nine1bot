const DEFAULT_RELAY_URL = 'ws://127.0.0.1:4096/browser/extension'
const DEFAULT_WEB_UI_URL = 'http://127.0.0.1:4096'

function relayUrlToWebUrl(relayUrl: string): string {
  try {
    const parsed = new URL(relayUrl)
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    return `${scheme}//${parsed.host}`
  } catch {
    return DEFAULT_WEB_UI_URL
  }
}

async function getWebUiUrl(): Promise<string> {
  try {
    const { webUiUrl, relayUrl } = await chrome.storage.sync.get({
      webUiUrl: '',
      relayUrl: DEFAULT_RELAY_URL,
    })
    if (typeof webUiUrl === 'string' && webUiUrl.trim()) return webUiUrl.trim()
    if (typeof relayUrl === 'string' && relayUrl.trim()) return relayUrlToWebUrl(relayUrl)
  } catch {
    // ignore
  }
  return DEFAULT_WEB_UI_URL
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

async function init(): Promise<void> {
  const connected = await checkExtensionHealth()
  setStatus(connected)
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

