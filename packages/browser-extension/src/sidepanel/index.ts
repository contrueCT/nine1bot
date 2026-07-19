import {
  SERVER_ORIGIN_STORAGE_KEY,
  SIDE_PANEL_OPEN_NONCE_STORAGE_KEY,
  browserRelayOriginToBootstrapUrl,
  browserRelayOriginToExtensionUrl,
  buildWebUiUrl,
  isAllowedLocalServerOrigin,
  normalizeServerOrigin,
  readStoredServerOrigin,
  writeStoredServerOrigin,
} from '../shared/server-config'
import {
  ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY,
  ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY,
} from '../shared/tab-group'
import { getDefaultNine1Tab, refreshBindingsFromStorage } from '../background/tab-group-manager'

let currentFrameOrigin = ''
let currentServerOrigin = ''
let currentOpenNonce = ''
let serverReachable = false
let relayConnected = false
let settingsOpen = false
let activeSettingsTab = 'relay'
let healthTimer: ReturnType<typeof setInterval> | null = null
let pageChangeTimer: ReturnType<typeof setTimeout> | null = null

function qs<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function parseRelayOriginInput(input: string): { ok: true; origin: string } | { ok: false; message: string } {
  try {
    const parsed = new URL(input.trim())
    if (!isAllowedLocalServerOrigin(parsed)) {
      return { ok: false, message: '请使用 http(s)://127.0.0.1:<port> 或 http(s)://localhost:<port>。' }
    }
    return { ok: true, origin: `${parsed.protocol}//${parsed.host}` }
  } catch {
    return { ok: false, message: '请输入有效的本地 Browser relay origin，例如 http://127.0.0.1:4096。' }
  }
}

async function readOpenNonce(): Promise<string> {
  try {
    const stored = await chrome.storage.sync.get({ [SIDE_PANEL_OPEN_NONCE_STORAGE_KEY]: '' })
    const nonce = stored[SIDE_PANEL_OPEN_NONCE_STORAGE_KEY]
    if (typeof nonce === 'string' && nonce.trim()) return nonce
  } catch {
    // ignore storage failures
  }

  const nonce = createNonce()
  await chrome.storage.sync.set({ [SIDE_PANEL_OPEN_NONCE_STORAGE_KEY]: nonce }).catch(() => {})
  return nonce
}

async function fetchBootstrap(origin: string, timeoutMs = 3000): Promise<{ instanceId?: string; serverOrigin?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(browserRelayOriginToBootstrapUrl(origin), {
      signal: controller.signal,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`
      throw new Error(message)
    }
    return body as { instanceId?: string; serverOrigin?: string }
  } finally {
    clearTimeout(timer)
  }
}

async function testRelayOrigin(origin: string): Promise<{ ok: true; message: string; instanceId?: string } | { ok: false; message: string }> {
  try {
    const body = await fetchBootstrap(origin, 2500)
    const instanceId = typeof body?.instanceId === 'string' ? body.instanceId : 'unknown instance'
    return { ok: true, message: `已连接到 ${instanceId}。`, instanceId }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { ok: false, message: aborted ? '连接超时。' : '无法访问该 Browser relay origin。' }
  }
}

async function checkExtensionHealth(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'nine1bot-sidepanel-health-check' })
    return Boolean(response?.connected)
  } catch {
    return false
  }
}

function relaySettingsPayload(message = '') {
  return {
    origin: currentServerOrigin,
    bootstrapUrl: browserRelayOriginToBootstrapUrl(currentServerOrigin),
    extensionUrl: browserRelayOriginToExtensionUrl(currentServerOrigin),
    serverReachable,
    relayConnected,
    message,
  }
}

function postFrameMessage(type: string, payload: Record<string, unknown> = {}): void {
  const frame = qs<HTMLIFrameElement>('app-frame')
  if (!frame?.contentWindow || !currentFrameOrigin || !serverReachable) return
  frame.contentWindow.postMessage({ type, ...payload }, currentFrameOrigin)
}

function broadcastRelayStatus(message = ''): void {
  postFrameMessage('nine1bot.relayStatus', {
    settings: relaySettingsPayload(message),
  })
}

function setStatus(): void {
  const status = qs<HTMLDivElement>('status')
  if (!status) return

  status.classList.toggle('connected', serverReachable && relayConnected)
  status.classList.toggle('error', !serverReachable)

  if (!serverReachable) {
    status.textContent = '未连接到 Nine1Bot 主进程'
  } else if (!relayConnected) {
    status.textContent = 'Nine1Bot 可访问，浏览器 relay 正在重连'
  } else {
    status.textContent = '浏览器 relay 已连接'
  }
}

function setMessage(id: string, message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  const el = qs<HTMLDivElement>(id)
  if (!el) return
  el.textContent = message
  el.className = `message ${tone}`
}

function setRelayFormValue(origin: string): void {
  const input = qs<HTMLInputElement>('server-origin')
  const bootstrap = qs<HTMLElement>('bootstrap-url')
  const extension = qs<HTMLElement>('extension-url')
  if (input) input.value = origin
  if (bootstrap) bootstrap.textContent = browserRelayOriginToBootstrapUrl(origin)
  if (extension) extension.textContent = browserRelayOriginToExtensionUrl(origin)
}

function renderSettingsTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]').forEach((button) => {
    const tab = button.dataset.tab || ''
    button.classList.toggle('active', tab === activeSettingsTab)
  })
  document.querySelectorAll<HTMLElement>('.settings-section').forEach((section) => {
    section.classList.toggle('active', section.id === `section-${activeSettingsTab}`)
  })
}

function renderPanels(): void {
  const frame = qs<HTMLIFrameElement>('app-frame')
  const fallback = qs<HTMLElement>('fallback-app')
  const settingsPanel = qs<HTMLElement>('settings-panel')
  if (!frame || !fallback || !settingsPanel) return

  frame.classList.toggle('hidden', !serverReachable)
  fallback.classList.toggle('hidden', serverReachable)
  settingsPanel.classList.toggle('visible', settingsOpen)
  renderSettingsTabs()
}

async function mountFrame(): Promise<void> {
  if (!serverReachable) return
  if (!currentOpenNonce) currentOpenNonce = await readOpenNonce()

  const frame = qs<HTMLIFrameElement>('app-frame')
  if (!frame) return

  currentFrameOrigin = normalizeServerOrigin(currentServerOrigin)
  const targetUrl = buildWebUiUrl(currentServerOrigin, currentOpenNonce)
  if (frame.src !== targetUrl) {
    frame.src = targetUrl
  } else {
    broadcastRelayStatus()
  }
}

async function refreshConnection(options: { mount?: boolean } = {}): Promise<void> {
  const wasReachable = serverReachable
  setRelayFormValue(currentServerOrigin)
  const result = await testRelayOrigin(currentServerOrigin)
  serverReachable = result.ok
  relayConnected = await checkExtensionHealth()
  setStatus()
  renderPanels()

  if (!serverReachable) {
    setMessage('settings-message', result.message, 'error')
  }

  if (options.mount || (!wasReachable && serverReachable)) {
    await mountFrame()
  }
  broadcastRelayStatus(result.message)
}

async function saveRelayOrigin(
  origin: string,
  options: { mount?: boolean } = { mount: true },
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const parsed = parseRelayOriginInput(origin)
  if (!parsed.ok) return { ok: false, message: parsed.message }

  currentServerOrigin = await writeStoredServerOrigin(parsed.origin)
  setRelayFormValue(currentServerOrigin)
  await refreshConnection({ mount: options.mount !== false })
  return {
    ok: serverReachable,
    message: serverReachable ? '已保存并重新连接。' : '已保存，但暂时无法连接到 Nine1Bot。',
  }
}

async function handleSaveRelaySettings(): Promise<void> {
  const input = qs<HTMLInputElement>('server-origin')
  if (!input) return

  setMessage('settings-message', '正在保存并重连...')
  const result = await saveRelayOrigin(input.value)
  setMessage('settings-message', result.message, result.ok ? 'success' : 'error')
}

async function handleTestRelaySettings(): Promise<void> {
  const input = qs<HTMLInputElement>('server-origin')
  if (!input) return

  const parsed = parseRelayOriginInput(input.value)
  if (!parsed.ok) {
    setMessage('settings-message', parsed.message, 'error')
    return
  }

  setRelayFormValue(parsed.origin)
  setMessage('settings-message', '正在测试连接...')
  const result = await testRelayOrigin(parsed.origin)
  setMessage('settings-message', result.message, result.ok ? 'success' : 'error')
}

async function handleFrameMessage(event: MessageEvent): Promise<void> {
  const frame = qs<HTMLIFrameElement>('app-frame')
  if (!frame || event.source !== frame.contentWindow) return
  if (event.origin !== currentFrameOrigin) return

  const message = event.data as { type?: string; requestId?: unknown; origin?: unknown; sessionID?: unknown } | undefined
  if (!message?.type) return

  if (message.type === 'nine1bot.requestPageContext' && typeof message.requestId === 'string') {
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
    return
  }

  if (message.type === 'nine1bot.getBrowserRelaySettings' && typeof message.requestId === 'string') {
    frame.contentWindow?.postMessage(
      {
        type: 'nine1bot.browserRelaySettings',
        requestId: message.requestId,
        settings: relaySettingsPayload(),
      },
      currentFrameOrigin,
    )
    return
  }

  if (message.type === 'nine1bot.testBrowserRelayOrigin' && typeof message.requestId === 'string') {
    const parsed = typeof message.origin === 'string' ? parseRelayOriginInput(message.origin) : undefined
    const result = parsed?.ok ? await testRelayOrigin(parsed.origin) : { ok: false, message: parsed?.message || 'Browser relay origin 无效。' }
    frame.contentWindow?.postMessage(
      {
        type: 'nine1bot.browserRelayTestResult',
        requestId: message.requestId,
        ...result,
        settings: relaySettingsPayload(result.message),
      },
      currentFrameOrigin,
    )
    return
  }

  if (message.type === 'nine1bot.saveBrowserRelayOrigin' && typeof message.requestId === 'string') {
    const result = typeof message.origin === 'string'
      ? await saveRelayOrigin(message.origin, { mount: false })
      : { ok: false, message: 'Browser relay origin 无效。' }
    frame.contentWindow?.postMessage(
      {
        type: 'nine1bot.browserRelaySaveResult',
        requestId: message.requestId,
        ...result,
        settings: relaySettingsPayload(result.message),
      },
      currentFrameOrigin,
    )
    if (result.ok) {
      setTimeout(() => {
        mountFrame().catch((error) => {
          console.warn('[SidePanel] Failed to reload after browser relay save:', error)
        })
      }, 150)
    }
    return
  }

  if (message.type === 'nine1bot.openMainSession' && typeof message.sessionID === 'string') {
    await openMainSession(message.sessionID)
  }
}

async function openMainSession(sessionID: string): Promise<void> {
  const url = new URL(normalizeServerOrigin(currentServerOrigin))
  url.searchParams.set('session', sessionID)
  await chrome.tabs.create({ url: url.toString() })
}

async function collectActiveTabPageContext(): Promise<unknown | undefined> {
  const tab = await getActiveNine1GroupTab()
  if (!tab?.id) return undefined

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'nine1bot-content-request',
    action: 'collectPageContext',
    params: {},
  }).catch(() => undefined)

  if (!response?.success) return undefined
  return response.result
}

async function getActiveNine1GroupTab(): Promise<chrome.tabs.Tab | undefined> {
  await refreshBindingsFromStorage()
  return (await getDefaultNine1Tab()) ?? undefined
}

async function ensureDedicatedTabGroup(): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'nine1bot-sidepanel-ensure-tab-group',
    onlyIfMissing: true,
  }).catch(() => undefined)
}

function notifyFramePageChanged(): void {
  postFrameMessage('nine1bot.activePageChanged')
}

function scheduleFramePageChanged(): void {
  if (pageChangeTimer) {
    clearTimeout(pageChangeTimer)
  }
  pageChangeTimer = setTimeout(() => {
    pageChangeTimer = null
    notifyFramePageChanged()
  }, 180)
}

function setupActivePageListener(): void {
  chrome.tabs.onActivated.addListener(() => {
    scheduleFramePageChanged()
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status) {
      scheduleFramePageChanged()
    }
  })

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === 'local'
      && (
        changes[ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]
        || changes[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]
      )
    ) {
      scheduleFramePageChanged()
    }
  })
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return

    const relayChange = changes[SERVER_ORIGIN_STORAGE_KEY]
    if (relayChange?.newValue && typeof relayChange.newValue === 'string') {
      currentServerOrigin = normalizeServerOrigin(relayChange.newValue)
      refreshConnection({ mount: true }).catch((error) => {
        console.warn('[SidePanel] Failed to reload after relay origin change:', error)
      })
    }

    const nonceChange = changes[SIDE_PANEL_OPEN_NONCE_STORAGE_KEY]
    if (nonceChange?.newValue && typeof nonceChange.newValue === 'string') {
      currentOpenNonce = nonceChange.newValue
      mountFrame().catch((error) => {
        console.warn('[SidePanel] Failed to reload after open nonce change:', error)
      })
    }
  })
}

function setupControls(): void {
  qs<HTMLButtonElement>('settings-toggle')?.addEventListener('click', () => {
    settingsOpen = true
    activeSettingsTab = 'relay'
    renderPanels()
  })
  qs<HTMLButtonElement>('settings-close')?.addEventListener('click', () => {
    settingsOpen = false
    renderPanels()
  })
  qs<HTMLElement>('settings-panel')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      settingsOpen = false
      renderPanels()
    }
  })
  qs<HTMLButtonElement>('reload')?.addEventListener('click', () => {
    refreshConnection({ mount: true }).catch((error) => {
      console.warn('[SidePanel] Failed to refresh connection:', error)
    })
  })
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    if (target?.matches('.tab[data-tab]')) {
      activeSettingsTab = target.dataset.tab || 'relay'
      renderPanels()
    }
    if (target?.id === 'save-settings') {
      handleSaveRelaySettings().catch((error) => {
        console.warn('[SidePanel] Failed to save relay settings:', error)
        setMessage('settings-message', '保存失败。', 'error')
      })
    }
    if (target?.id === 'test-settings') {
      handleTestRelaySettings().catch((error) => {
        console.warn('[SidePanel] Failed to test relay settings:', error)
        setMessage('settings-message', '测试失败。', 'error')
      })
    }
  })
  qs<HTMLIFrameElement>('app-frame')?.addEventListener('load', () => {
    broadcastRelayStatus()
  })
}

async function init(): Promise<void> {
  currentServerOrigin = await readStoredServerOrigin()
  currentOpenNonce = await readOpenNonce()
  setRelayFormValue(currentServerOrigin)
  await ensureDedicatedTabGroup()
  setupControls()
  setupStorageListener()
  setupActivePageListener()
  window.addEventListener('message', (event) => {
    handleFrameMessage(event).catch((error) => {
      console.warn('[SidePanel] Failed to handle frame message:', error)
    })
  })
  await refreshConnection({ mount: true })
  healthTimer = setInterval(() => {
    refreshConnection().catch(() => {})
  }, 5000)
}

window.addEventListener('unload', () => {
  if (healthTimer) {
    clearInterval(healthTimer)
    healthTimer = null
  }
  if (pageChangeTimer) {
    clearTimeout(pageChangeTimer)
    pageChangeTimer = null
  }
})

init().catch((error) => {
  console.error('[SidePanel] Failed to initialize:', error)
  serverReachable = false
  relayConnected = false
  setStatus()
  renderPanels()
})
