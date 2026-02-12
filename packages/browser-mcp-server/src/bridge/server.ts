/**
 * Browser Bridge Server — Dual-mode browser control
 *
 * Two channels:
 * 1. Extension (user browser): Chrome Extension connects via WebSocket relay,
 *    forwards commands through chrome.debugger / chrome.scripting
 * 2. Direct CDP (bot browser): Server-side Chrome launched/connected via CDP
 *
 * All methods accept an optional `browser` parameter:
 * - "user"  → force Extension channel
 * - "bot"   → force Direct CDP channel
 * - omitted → auto-detect (Extension if connected, otherwise CDP)
 */

import { Hono } from 'hono'
import {
  listCdpTargets,
  captureScreenshot,
  evaluateScript,
  navigateToUrl,
  getCdpVersion,
  createCdpTarget,
  closeCdpTarget,
  withCdpSession,
} from '../core/cdp'
import { launchChrome, isChromeRunning, type ChromeInstance } from '../core/chrome'
import { createRelayRoutes, getExtensionRelay, type ExtensionRelay } from './relay-routes'
import type {
  Tab,
  ScreenshotOptions,
  ExtensionToolResult,
  BrowserTarget,
  BrowserStatus,
  SnapshotResult,
  ClickOptions,
} from '../core/types'
import { KEY_MAP, MODIFIER_BITS } from '../core/types'
import { buildSnapshotExpression } from '../core/page-scripts/snapshot'
import { buildFindExpression, type FindMatch } from '../core/page-scripts/find'
import { buildResolveRefExpression, buildScrollIntoViewExpression } from '../core/page-scripts/resolve-ref'
import { buildFormFillExpression, type FormFillResult } from '../core/page-scripts/form-fill'

export interface BridgeServerOptions {
  cdpPort?: number
  autoLaunch?: boolean
  headless?: boolean
}

/**
 * Browser Bridge Server
 * Class-based, supports multiple instances, exposes direct methods for AI tools
 */
export class BridgeServer {
  private options: Required<BridgeServerOptions>
  private chromeInstance: ChromeInstance | null = null
  private relay: ExtensionRelay | null = null
  private started = false

  constructor(options: BridgeServerOptions = {}) {
    this.options = {
      cdpPort: options.cdpPort ?? 9222,
      autoLaunch: options.autoLaunch ?? true,
      headless: options.headless ?? false,
    }
  }

  // ==================== Lifecycle ====================

  async start(): Promise<void> {
    if (this.started) {
      console.log('[Browser Bridge] Already started')
      return
    }

    this.relay = getExtensionRelay()
    this.started = true

    console.log(`[Browser Bridge] Initialized (CDP port: ${this.options.cdpPort}, Auto-launch: ${this.options.autoLaunch})`)
  }

  async stop(): Promise<void> {
    if (!this.started) return

    if (this.relay) {
      await this.relay.stop()
      this.relay = null
    }

    if (this.chromeInstance) {
      await this.chromeInstance.stop()
      this.chromeInstance = null
    }

    this.started = false
    console.log('[Browser Bridge] Stopped')
  }

  get isExtensionConnected(): boolean {
    return this.relay?.extensionConnected() ?? false
  }

  // ==================== Channel Routing ====================

  /**
   * Determine which channel to use based on the browser parameter.
   * Throws if the requested channel is unavailable.
   */
  private getChannel(browser?: BrowserTarget): 'extension' | 'cdp' {
    if (browser === 'user') {
      if (!this.isExtensionConnected) {
        throw new Error('User browser not connected. Please install and connect the Nine1Bot browser extension.')
      }
      return 'extension'
    }
    if (browser === 'bot') {
      return 'cdp'
    }
    // Auto-detect: prefer extension if connected
    return this.isExtensionConnected ? 'extension' : 'cdp'
  }

  // ==================== Hono Routes ====================

  getRoutes(): Hono {
    const app = new Hono()
    app.route('/', createRelayRoutes())
    app.route('/', this.createHttpApp())
    return app
  }

  // ==================== Status & Launch ====================

  /**
   * Get status of both browser channels including tabs.
   */
  async getStatus(): Promise<BrowserStatus> {
    let userStatus: BrowserStatus['user'] = null
    let botStatus: BrowserStatus['bot'] = null

    // User browser (Extension)
    if (this.isExtensionConnected) {
      const targets = this.relay!.getTargets()
      userStatus = {
        connected: true,
        tabs: targets.map(t => ({
          id: t.targetId,
          sessionId: t.sessionId,
          title: t.targetInfo.title,
          url: t.targetInfo.url,
        })),
      }
    } else {
      userStatus = { connected: false, tabs: [] }
    }

    // Bot browser (Direct CDP)
    try {
      const running = await isChromeRunning(this.options.cdpPort)
      if (running) {
        const targets = await listCdpTargets(this.cdpUrl)
        botStatus = {
          running: true,
          tabs: targets
            .filter(t => t.type === 'page')
            .map(t => ({ id: t.id, title: t.title, url: t.url })),
        }
      } else {
        botStatus = { running: false, tabs: [] }
      }
    } catch {
      botStatus = { running: false, tabs: [] }
    }

    return { user: userStatus, bot: botStatus }
  }

  /**
   * Launch the bot browser (server-side Chrome).
   */
  async launchBotBrowser(options?: { headless?: boolean; url?: string }): Promise<{ success: boolean; message: string }> {
    const running = await isChromeRunning(this.options.cdpPort)
    if (running) {
      if (options?.url) {
        await createCdpTarget(this.cdpUrl, options.url)
        return { success: true, message: `Bot browser already running. Opened ${options.url} in new tab.` }
      }
      return { success: true, message: 'Bot browser is already running.' }
    }

    const instance = await launchChrome({
      cdpPort: this.options.cdpPort,
      headless: options?.headless ?? this.options.headless,
    })
    this.chromeInstance = instance

    if (options?.url) {
      await new Promise(r => setTimeout(r, 500))
      try {
        await createCdpTarget(instance.cdpUrl, options.url)
      } catch {
        // First tab might already exist
      }
    }

    return { success: true, message: `Bot browser launched on CDP port ${this.options.cdpPort}.` }
  }

  // ==================== Tab Management ====================

  async listTabs(browser?: BrowserTarget): Promise<Tab[]> {
    const channel = this.getChannel(browser)

    if (channel === 'extension') {
      const targets = this.relay!.getTargets()
      return targets.map(t => ({
        id: t.targetId,
        sessionId: t.sessionId,
        title: t.targetInfo.title,
        url: t.targetInfo.url,
      }))
    }

    const cdpUrl = await this.ensureBrowserAvailable()
    const targets = await listCdpTargets(cdpUrl)
    return targets
      .filter(t => t.type === 'page')
      .map(t => ({ id: t.id, title: t.title, url: t.url }))
  }

  // ==================== Snapshot (a11y tree) ====================

  /**
   * Get an accessibility tree snapshot of a page.
   * Extension mode: calls read_page tool
   * CDP mode: injects snapshot script via Runtime.evaluate
   */
  async snapshot(
    tabId: string,
    options?: { depth?: number; filter?: 'all' | 'interactive' | 'visible'; refId?: string; maxChars?: number },
    browser?: BrowserTarget,
  ): Promise<SnapshotResult> {
    const channel = this.getChannel(browser)

    if (channel === 'extension') {
      const [titleResult, urlResult] = await Promise.all([
        this.relay!.sendCommand('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, tabId) as Promise<{ result?: { value?: string } }>,
        this.relay!.sendCommand('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }, tabId) as Promise<{ result?: { value?: string } }>,
      ])

      const result = await this.callExtensionTool(tabId, 'read_page', {
        filter: options?.filter ?? 'all',
        depth: options?.depth ?? 10,
        ref_id: options?.refId,
        max_chars: options?.maxChars ?? 50000,
      })

      const snapshotText = result.content?.find(c => c.type === 'text')?.text ?? ''

      return {
        title: titleResult?.result?.value ?? '',
        url: urlResult?.result?.value ?? '',
        snapshot: snapshotText,
      }
    }

    // CDP mode: inject script
    const wsUrl = await this.getTargetWsUrl(tabId)
    const expression = buildSnapshotExpression({
      depth: options?.depth,
      filter: options?.filter,
      refId: options?.refId,
      maxChars: options?.maxChars,
    })

    const [snapshotJson, title, url] = await Promise.all([
      evaluateScript(wsUrl, expression) as Promise<string>,
      evaluateScript(wsUrl, 'document.title') as Promise<string>,
      evaluateScript(wsUrl, 'window.location.href') as Promise<string>,
    ])

    return {
      title: String(title ?? ''),
      url: String(url ?? ''),
      snapshot: String(snapshotJson ?? ''),
    }
  }

  // ==================== Find Elements ====================

  async findElements(tabId: string, query: string, browser?: BrowserTarget): Promise<FindMatch[]> {
    const channel = this.getChannel(browser)

    if (channel === 'extension') {
      const result = await this.callExtensionTool(tabId, 'find', { query })
      const text = result.content?.find(c => c.type === 'text')?.text ?? '[]'
      try {
        const jsonStart = text.indexOf('[')
        if (jsonStart === -1) return []
        return JSON.parse(text.slice(jsonStart))
      } catch {
        return []
      }
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    const expression = buildFindExpression(query)
    const resultJson = await evaluateScript(wsUrl, expression) as string
    try {
      return JSON.parse(String(resultJson ?? '[]'))
    } catch {
      return []
    }
  }

  // ==================== Click ====================

  async clickElement(tabId: string, options: ClickOptions, browser?: BrowserTarget): Promise<void> {
    const channel = this.getChannel(browser)
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1

    let coords: [number, number] | undefined = options.coordinate

    if (options.ref && !coords) {
      coords = await this.resolveRefToCoords(tabId, options.ref, channel)
    }

    if (!coords) {
      throw new Error('Either ref or coordinate is required for click')
    }

    const [x, y] = coords

    if (channel === 'extension') {
      const relay = this.relay!
      await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, tabId)
      await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, tabId)
      await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, tabId)

      if (clickCount === 2) {
        await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 2 }, tabId)
        await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 2 }, tabId)
      }
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await withCdpSession(wsUrl, async (session) => {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount })
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount })
      if (clickCount === 2) {
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 2 })
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 2 })
      }
    })
  }

  // ==================== Form Fill ====================

  async fillForm(tabId: string, ref: string, value: unknown, browser?: BrowserTarget): Promise<FormFillResult> {
    const channel = this.getChannel(browser)

    if (channel === 'extension') {
      const result = await this.callExtensionTool(tabId, 'form_input', { ref, value })
      const text = result.content?.find(c => c.type === 'text')?.text ?? ''
      if (result.isError) {
        return { success: false, error: text }
      }
      return { success: true, elementType: text }
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    const expression = buildFormFillExpression(ref, value)
    const resultJson = await evaluateScript(wsUrl, expression) as string
    try {
      return JSON.parse(String(resultJson ?? '{}'))
    } catch {
      return { success: false, error: 'Failed to parse fill result' }
    }
  }

  // ==================== Press Key ====================

  async pressKey(tabId: string, key: string, browser?: BrowserTarget): Promise<void> {
    const channel = this.getChannel(browser)
    const parts = key.split('+')

    const modifiers: string[] = []
    let mainKey = ''
    for (const part of parts) {
      const lower = part.toLowerCase().trim()
      if (['control', 'alt', 'shift', 'meta'].includes(lower)) {
        modifiers.push(lower)
      } else {
        mainKey = KEY_MAP[lower] || part
      }
    }

    let modifierFlags = 0
    for (const mod of modifiers) {
      modifierFlags |= MODIFIER_BITS[mod] ?? 0
    }

    if (channel === 'extension') {
      const relay = this.relay!
      for (const mod of modifiers) {
        await relay.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: KEY_MAP[mod] || mod,
          modifiers: modifierFlags,
        }, tabId)
      }
      if (mainKey) {
        await relay.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: mainKey,
          modifiers: modifierFlags,
          ...(mainKey.length === 1 ? { text: modifiers.length === 0 ? mainKey : undefined } : {}),
        }, tabId)
        await relay.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: mainKey,
          modifiers: modifierFlags,
        }, tabId)
      }
      for (const mod of modifiers.reverse()) {
        await relay.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: KEY_MAP[mod] || mod,
        }, tabId)
      }
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await withCdpSession(wsUrl, async (session) => {
      for (const mod of modifiers) {
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: KEY_MAP[mod] || mod,
          modifiers: modifierFlags,
        })
      }
      if (mainKey) {
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: mainKey,
          modifiers: modifierFlags,
          ...(mainKey.length === 1 ? { text: modifiers.length === 0 ? mainKey : undefined } : {}),
        })
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: mainKey,
          modifiers: modifierFlags,
        })
      }
      for (const mod of modifiers.reverse()) {
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: KEY_MAP[mod] || mod,
        })
      }
    })
  }

  // ==================== Scroll ====================

  async scroll(
    tabId: string,
    direction: 'up' | 'down' | 'left' | 'right',
    amount?: number,
    ref?: string,
    browser?: BrowserTarget,
  ): Promise<void> {
    const channel = this.getChannel(browser)
    const scrollAmount = amount ?? 300
    const deltaX = direction === 'left' ? -scrollAmount : direction === 'right' ? scrollAmount : 0
    const deltaY = direction === 'up' ? -scrollAmount : direction === 'down' ? scrollAmount : 0

    let x = 0
    let y = 0
    if (ref) {
      try {
        const coords = await this.resolveRefToCoords(tabId, ref, channel)
        x = coords[0]
        y = coords[1]
      } catch {
        // Fallback to viewport origin
      }
    }

    if (channel === 'extension') {
      await this.relay!.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX, deltaY,
      }, tabId)
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await withCdpSession(wsUrl, async (session) => {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX, deltaY,
      })
    })
  }

  // ==================== Wait for Text ====================

  async waitForText(tabId: string, text: string, timeout?: number, browser?: BrowserTarget): Promise<boolean> {
    const channel = this.getChannel(browser)
    const maxWait = timeout ?? 10000
    const pollInterval = 500
    const startTime = Date.now()

    const checkExpression = `document.body.innerText.includes(${JSON.stringify(text)})`

    while (Date.now() - startTime < maxWait) {
      let found = false

      if (channel === 'extension') {
        const result = await this.relay!.sendCommand('Runtime.evaluate', {
          expression: checkExpression,
          returnByValue: true,
        }, tabId) as { result?: { value?: boolean } }
        found = result?.result?.value === true
      } else {
        const wsUrl = await this.getTargetWsUrl(tabId)
        const result = await evaluateScript(wsUrl, checkExpression)
        found = result === true
      }

      if (found) return true
      await new Promise(r => setTimeout(r, pollInterval))
    }

    return false
  }

  // ==================== Handle Dialog ====================

  async handleDialog(action: 'accept' | 'dismiss', promptText?: string, browser?: BrowserTarget): Promise<void> {
    const channel = this.getChannel(browser)
    const accept = action === 'accept'

    const params: Record<string, unknown> = { accept }
    if (promptText !== undefined) params.promptText = promptText

    if (channel === 'extension') {
      await this.relay!.sendCommand('Page.handleJavaScriptDialog', params)
      return
    }

    const cdpUrl = await this.ensureBrowserAvailable()
    const version = await getCdpVersion(cdpUrl)
    if (version.webSocketDebuggerUrl) {
      await withCdpSession(version.webSocketDebuggerUrl, async (session) => {
        await session.send('Page.handleJavaScriptDialog', params)
      })
    }
  }

  // ==================== Upload File ====================

  async uploadFile(tabId: string, ref: string, filePath: string, browser?: BrowserTarget): Promise<void> {
    const channel = this.getChannel(browser)

    if (channel === 'extension') {
      const docResult = await this.relay!.sendCommand('DOM.getDocument', {}, tabId) as { root?: { nodeId?: number } }
      const rootNodeId = docResult?.root?.nodeId
      if (!rootNodeId) throw new Error('Could not get document root')

      const queryResult = await this.relay!.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector: `[data-mcp-ref="${ref}"]`,
      }, tabId) as { nodeId?: number }

      if (!queryResult?.nodeId) throw new Error(`Element with ref "${ref}" not found in DOM`)

      await this.relay!.sendCommand('DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: queryResult.nodeId,
      }, tabId)
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await withCdpSession(wsUrl, async (session) => {
      await session.send('DOM.enable')
      const doc = await session.send('DOM.getDocument') as { root?: { nodeId?: number } }
      const rootNodeId = doc?.root?.nodeId
      if (!rootNodeId) throw new Error('Could not get document root')

      const query = await session.send('DOM.querySelector', {
        nodeId: rootNodeId,
        selector: `[data-mcp-ref="${ref}"]`,
      }) as { nodeId?: number }

      if (!query?.nodeId) throw new Error(`Element with ref "${ref}" not found in DOM`)

      await session.send('DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: query.nodeId,
      })
    })
  }

  // ==================== Existing Methods (with browser param) ====================

  async screenshot(tabId: string, options?: ScreenshotOptions, browser?: BrowserTarget): Promise<{ data: string; mimeType: string }> {
    const channel = this.getChannel(browser)
    const format = options?.format ?? 'png'
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'

    if (channel === 'extension') {
      const result = await this.relay!.sendCommand(
        'Page.captureScreenshot',
        { format },
        tabId
      ) as { data?: string }

      if (!result?.data) throw new Error('Screenshot failed: no data returned')
      return { data: result.data, mimeType }
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    const buffer = await captureScreenshot(wsUrl, { fullPage: options?.fullPage, format })
    return { data: buffer.toString('base64'), mimeType }
  }

  async navigate(
    tabId: string,
    options: { url?: string; action?: 'goto' | 'back' | 'forward' | 'reload' | 'new_tab' | 'close_tab' },
    browser?: BrowserTarget,
  ): Promise<{ tabId?: string }> {
    const channel = this.getChannel(browser)
    const action = options.action ?? 'goto'

    if (channel === 'extension') {
      const relay = this.relay!
      switch (action) {
        case 'goto':
          if (!options.url) throw new Error('url is required for goto action')
          await relay.sendCommand('Page.navigate', { url: options.url }, tabId)
          return {}
        case 'back':
          await relay.sendCommand('Runtime.evaluate', { expression: 'history.back()', returnByValue: true }, tabId)
          return {}
        case 'forward':
          await relay.sendCommand('Runtime.evaluate', { expression: 'history.forward()', returnByValue: true }, tabId)
          return {}
        case 'reload':
          await relay.sendCommand('Page.reload', {}, tabId)
          return {}
        case 'new_tab': {
          const result = await this.callExtensionTool(tabId, 'tabs_create_mcp', { url: options.url || 'about:blank' })
          const text = result.content?.find(c => c.type === 'text')?.text ?? ''
          try {
            const parsed = JSON.parse(text)
            return { tabId: parsed.id?.toString() }
          } catch {
            return {}
          }
        }
        case 'close_tab':
          await relay.sendCommand('Runtime.evaluate', { expression: 'window.close()', returnByValue: true }, tabId)
          return {}
        default:
          throw new Error(`Unknown action: ${action}`)
      }
    }

    // CDP mode
    const cdpUrl = await this.ensureBrowserAvailable()
    switch (action) {
      case 'goto': {
        if (!options.url) throw new Error('url is required for goto action')
        const wsUrl = await this.getTargetWsUrl(tabId)
        await navigateToUrl(wsUrl, options.url)
        return {}
      }
      case 'back': {
        const wsUrl = await this.getTargetWsUrl(tabId)
        await evaluateScript(wsUrl, 'history.back()')
        return {}
      }
      case 'forward': {
        const wsUrl = await this.getTargetWsUrl(tabId)
        await evaluateScript(wsUrl, 'history.forward()')
        return {}
      }
      case 'reload': {
        const wsUrl = await this.getTargetWsUrl(tabId)
        await withCdpSession(wsUrl, async (session) => {
          await session.send('Page.enable')
          await session.send('Page.reload')
        })
        return {}
      }
      case 'new_tab': {
        const target = await createCdpTarget(cdpUrl, options.url || 'about:blank')
        return { tabId: target.id }
      }
      case 'close_tab': {
        await closeCdpTarget(cdpUrl, tabId)
        return {}
      }
      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }

  async evaluate(tabId: string, expression: string, browser?: BrowserTarget): Promise<unknown> {
    const channel = this.getChannel(browser)

    if (channel === 'extension') {
      const result = await this.relay!.sendCommand(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        tabId
      ) as { result?: { value?: unknown } }
      return result?.result?.value
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    return evaluateScript(wsUrl, expression)
  }

  // ==================== Extension Tool Forwarding ====================

  async callExtensionTool(tabId: string, toolName: string, args: Record<string, unknown> = {}): Promise<ExtensionToolResult> {
    if (!this.isExtensionConnected) {
      throw new Error('Chrome extension not connected. Install and connect the Nine1Bot Browser Control extension.')
    }
    const result = await this.relay!.sendCommand(
      'Extension.callTool',
      { toolName, args },
      tabId
    )
    return result as ExtensionToolResult
  }

  // ==================== Internal Helpers ====================

  private get cdpUrl(): string {
    return `http://127.0.0.1:${this.options.cdpPort}`
  }

  private async ensureBrowserAvailable(): Promise<string> {
    if (await isChromeRunning(this.options.cdpPort)) {
      return this.cdpUrl
    }

    if (this.options.autoLaunch) {
      console.log('[Browser Bridge] Launching Chrome...')
      const instance = await launchChrome({
        cdpPort: this.options.cdpPort,
        headless: this.options.headless,
      })
      this.chromeInstance = instance
      return instance.cdpUrl
    }

    throw new Error('Chrome is not running. Please start Chrome with --remote-debugging-port=' + this.options.cdpPort)
  }

  private async getTargetWsUrl(targetId: string): Promise<string> {
    const cdpUrl = await this.ensureBrowserAvailable()
    const targets = await listCdpTargets(cdpUrl)
    const target = targets.find(t => t.id === targetId)

    if (!target) throw new Error(`Target not found: ${targetId}`)
    if (!target.webSocketDebuggerUrl) throw new Error(`Target has no WebSocket URL: ${targetId}`)

    return target.webSocketDebuggerUrl
  }

  /**
   * Resolve a ref ID to center coordinates [x, y].
   * Scrolls element into view if not visible.
   */
  private async resolveRefToCoords(tabId: string, ref: string, channel: 'extension' | 'cdp'): Promise<[number, number]> {
    const expression = buildResolveRefExpression(ref)

    let resultJson: string

    if (channel === 'extension') {
      const result = await this.relay!.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
      }, tabId) as { result?: { value?: string } }
      resultJson = String(result?.result?.value ?? 'null')
    } else {
      const wsUrl = await this.getTargetWsUrl(tabId)
      resultJson = String(await evaluateScript(wsUrl, expression) ?? 'null')
    }

    const parsed = JSON.parse(resultJson)
    if (!parsed) {
      throw new Error(`Element with ref "${ref}" not found`)
    }

    if (!parsed.visible) {
      // Scroll into view
      const scrollExpr = buildScrollIntoViewExpression(ref)
      if (channel === 'extension') {
        await this.relay!.sendCommand('Runtime.evaluate', { expression: scrollExpr, returnByValue: true }, tabId)
      } else {
        const wsUrl = await this.getTargetWsUrl(tabId)
        await evaluateScript(wsUrl, scrollExpr)
      }
      await new Promise(r => setTimeout(r, 300))

      // Re-resolve
      let newJson: string
      if (channel === 'extension') {
        const result = await this.relay!.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
        }, tabId) as { result?: { value?: string } }
        newJson = String(result?.result?.value ?? 'null')
      } else {
        const wsUrl = await this.getTargetWsUrl(tabId)
        newJson = String(await evaluateScript(wsUrl, expression) ?? 'null')
      }
      const newParsed = JSON.parse(newJson)
      if (newParsed) return [newParsed.centerX, newParsed.centerY]
    }

    return [parsed.centerX, parsed.centerY]
  }

  // ==================== HTTP API Routes ====================

  private createHttpApp(): Hono {
    const app = new Hono()

    app.get('/', async (c) => {
      try {
        const status = await this.getStatus()
        return c.json({ ok: true, ...status })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.get('/status', async (c) => {
      try {
        const status = await this.getStatus()
        return c.json({ ok: true, ...status })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/launch', async (c) => {
      try {
        const body = await c.req.json<{ headless?: boolean; url?: string }>().catch(() => ({}))
        const result = await this.launchBotBrowser(body)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.get('/extension/status', (c) => {
      const targets = this.relay?.getTargets() ?? []
      return c.json({
        connected: this.isExtensionConnected,
        targets: targets.map(t => ({
          id: t.targetId,
          sessionId: t.sessionId,
          title: t.targetInfo.title,
          url: t.targetInfo.url,
        })),
      })
    })

    app.get('/json/version', async (c) => {
      if (this.isExtensionConnected) {
        return c.json({
          Browser: 'Nine1Bot/Extension-Relay',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: '/browser/cdp',
        })
      }
      try {
        const version = await getCdpVersion(this.cdpUrl)
        return c.json({ ...version, webSocketDebuggerUrl: '/browser/cdp' })
      } catch {
        return c.json({ Browser: 'Nine1Bot/Browser-Bridge', 'Protocol-Version': '1.3' })
      }
    })

    app.get('/tabs', async (c) => {
      try {
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const tabs = await this.listTabs(browser)
        return c.json({ ok: true, tabs })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/snapshot', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req.json<{ depth?: number; filter?: 'all' | 'interactive' | 'visible'; refId?: string }>().catch(() => ({}))
        const result = await this.snapshot(tabId, body, browser)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/find', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { query } = await c.req.json<{ query: string }>()
        if (!query) return c.json({ ok: false, error: 'query is required' }, 400)
        const matches = await this.findElements(tabId, query, browser)
        return c.json({ ok: true, matches })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/screenshot', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req.json<{ fullPage?: boolean; format?: 'png' | 'jpeg' }>().catch(() => ({}))
        const result = await this.screenshot(tabId, body, browser)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/navigate', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req.json<{ url?: string; action?: string }>()
        const result = await this.navigate(tabId, body as Parameters<typeof this.navigate>[1], browser)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/click', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req.json<ClickOptions>()
        await this.clickElement(tabId, body, browser)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/fill', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { ref, value } = await c.req.json<{ ref: string; value: unknown }>()
        if (!ref) return c.json({ ok: false, error: 'ref is required' }, 400)
        const result = await this.fillForm(tabId, ref, value, browser)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/press-key', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { key } = await c.req.json<{ key: string }>()
        if (!key) return c.json({ ok: false, error: 'key is required' }, 400)
        await this.pressKey(tabId, key, browser)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/scroll', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browserParam = c.req.query('browser') as BrowserTarget | undefined
        const { direction, amount, ref } = await c.req.json<{ direction: string; amount?: number; ref?: string }>()
        if (!direction) return c.json({ ok: false, error: 'direction is required' }, 400)
        await this.scroll(tabId, direction as 'up' | 'down' | 'left' | 'right', amount, ref, browserParam)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/wait', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { text, timeout } = await c.req.json<{ text: string; timeout?: number }>()
        if (!text) return c.json({ ok: false, error: 'text is required' }, 400)
        const found = await this.waitForText(tabId, text, timeout, browser)
        return c.json({ ok: true, found })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/evaluate', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { expression } = await c.req.json<{ expression: string }>()
        if (!expression) return c.json({ ok: false, error: 'expression is required' }, 400)
        const result = await this.evaluate(tabId, expression, browser)
        return c.json({ ok: true, result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/dialog', async (c) => {
      try {
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { action, promptText } = await c.req.json<{ action: 'accept' | 'dismiss'; promptText?: string }>()
        if (!action) return c.json({ ok: false, error: 'action is required' }, 400)
        await this.handleDialog(action, promptText, browser)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/upload', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const { ref, filePath } = await c.req.json<{ ref: string; filePath: string }>()
        if (!ref || !filePath) return c.json({ ok: false, error: 'ref and filePath are required' }, 400)
        await this.uploadFile(tabId, ref, filePath, browser)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/tool/:toolName', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const toolName = c.req.param('toolName')
        const args = await c.req.json().catch(() => ({})) as Record<string, unknown>
        const result = await this.callExtensionTool(tabId, toolName, args)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    return app
  }
}
