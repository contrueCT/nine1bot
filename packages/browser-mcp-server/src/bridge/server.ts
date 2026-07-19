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
import { Socket } from 'node:net'
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
  BrowserRuntimeConflict,
  BrowserRuntimeStatus,
  SnapshotResult,
  ClickOptions,
} from '../core/types'
import { KEY_MAP, MODIFIER_BITS } from '../core/types'
import { buildSnapshotExpression } from '../core/page-scripts/snapshot'
import { buildFindExpression, type FindMatch } from '../core/page-scripts/find'
import { buildResolveRefExpression, buildScrollIntoViewExpression } from '../core/page-scripts/resolve-ref'
import { buildFormFillExpression, type FormFillResult } from '../core/page-scripts/form-fill'
import {
  buildLocateExpression,
  buildResolveTargetExpression,
  buildTargetFormFillExpression,
  type LocateOptions,
  type LocateResult,
  type TargetFormFillResult,
} from '../core/page-scripts/locate'

export interface BridgeServerOptions {
  cdpPort?: number
  autoLaunch?: boolean
  headless?: boolean
  serverOrigin?: string
  instanceId?: string
}

const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:4096'
const LEGACY_BROWSER_PORTS = [18791, 18793]
const EXTENSION_PROTOCOL_VERSION = '2026-03-15'

function normalizeServerOrigin(serverOrigin: string): string {
  try {
    const parsed = new URL(serverOrigin)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return DEFAULT_SERVER_ORIGIN
  }
}

function generateInstanceId(): string {
  return `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function defaultLocateResult(query: string, warnings: string[] = []): LocateResult {
  return {
    query,
    matches: [],
    scannedNodes: 0,
    truncated: false,
    elapsedMs: 0,
    inaccessibleFrames: 0,
    warnings,
  }
}

function normalizeLocateResult(value: unknown, query: string): LocateResult {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Partial<LocateResult>).matches)) {
    return defaultLocateResult(query, ['Locator returned an invalid result.'])
  }

  const result = value as Partial<LocateResult>
  return {
    query: typeof result.query === 'string' ? result.query : query,
    matches: result.matches as LocateResult['matches'],
    scannedNodes: typeof result.scannedNodes === 'number' ? result.scannedNodes : 0,
    truncated: typeof result.truncated === 'boolean' ? result.truncated : false,
    elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : 0,
    inaccessibleFrames: typeof result.inaccessibleFrames === 'number' ? result.inaccessibleFrames : 0,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  }
}

type ExtensionTabListSource = 'authoritative_group_scan' | 'relay_cache_fallback' | 'none'

interface RefreshExtensionTabsResult {
  tabs: Tab[]
  source: ExtensionTabListSource
  issues: BrowserRuntimeStatus['issues']
}

async function isLocalPortListening(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
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
      serverOrigin: normalizeServerOrigin(options.serverOrigin ?? DEFAULT_SERVER_ORIGIN),
      instanceId: options.instanceId ?? generateInstanceId(),
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
    const runtimeIssues: BrowserRuntimeStatus['issues'] = []

    // User browser (Extension)
    if (this.isExtensionConnected) {
      const refreshedTabs = await this.refreshExtensionTabs()
      runtimeIssues.push(...refreshedTabs.issues)
      userStatus = {
        connected: true,
        tabs: refreshedTabs.tabs,
        tabListSource: refreshedTabs.source,
      }
    } else {
      userStatus = { connected: false, tabs: [], tabListSource: 'none' }
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

    return {
      user: userStatus,
      bot: botStatus,
      runtime: await this.getRuntimeStatus(runtimeIssues),
    }
  }

  private async refreshExtensionTabs(): Promise<RefreshExtensionTabsResult> {
    if (!this.relay?.extensionConnected()) {
      return { tabs: [], source: 'none', issues: [] }
    }
    const supportedTools = this.relay.getTools()
    if (supportedTools.length > 0 && !supportedTools.includes('tabs_context_mcp')) {
      const targets = this.relay.getTargets()
      return {
        tabs: targets.map((target) => ({
          id: target.targetId,
          sessionId: target.sessionId,
          title: target.targetInfo.title,
          url: target.targetInfo.url,
        })),
        source: targets.length > 0 ? 'relay_cache_fallback' : 'none',
        issues: targets.length > 0
          ? [{
            code: 'relay_cache_fallback',
            severity: 'warning',
            message: 'Extension tabs_context_mcp is unavailable; using relay cache fallback.',
          }]
          : [],
      }
    }

    try {
      const result = await this.relay.sendCommand(
        'Extension.callTool',
        {
          toolName: 'tabs_context_mcp',
          args: { includeAll: true },
          timeoutMs: 5000,
          taskLabel: 'Refresh browser tabs',
        },
      ) as ExtensionToolResult
      const text = result.content?.find(c => c.type === 'text')?.text ?? '{}'
      if (result.isError) {
        return {
          tabs: [],
          source: 'none',
          issues: [
            {
              code: 'tab_scan_failed',
              severity: 'error',
              message: `Extension tab scan failed: ${text}`,
            },
          ],
        }
      }

      if (!text.trim().startsWith('{')) {
        return {
          tabs: [],
          source: 'none',
          issues: [
            {
              code: 'tab_scan_failed',
              severity: 'error',
              message: `Extension tab scan returned a non-JSON payload: ${text}`,
            },
          ],
        }
      }

      const parsed = JSON.parse(text) as {
        allTabs?: Array<{ id?: number; title?: string; url?: string; active?: boolean; windowId?: number }>
        activeTab?: { id?: number; title?: string; url?: string; windowId?: number } | null
        tabScanStatus?: {
          source?: string
          reasonCode?: string
          recoverySource?: string
          windowId?: number | null
          matchedGroupIds?: number[]
        }
      }
      const allTabs = Array.isArray(parsed.allTabs) ? parsed.allTabs : []
      const issues: BrowserRuntimeStatus['issues'] = []
      if (allTabs.length > 0) {
        const tabs = allTabs
          .filter(tab => typeof tab.id === 'number')
          .map(tab => ({
            id: String(tab.id),
            sessionId: `tab_${tab.id}`,
            title: tab.title ?? '',
            url: tab.url ?? '',
            active: tab.active,
            windowId: tab.windowId,
          }))
        const beforeTargets = this.relay.getTargets()
        this.relay.upsertTargetsFromTabs(tabs)
        if (beforeTargets.length === 0) {
          issues.push({
            code: 'relay_cache_empty',
            severity: 'warning',
            message: 'Relay target cache was empty; rebuilt it from authoritative extension tab scan.',
          })
        }
        return {
          tabs,
          source: 'authoritative_group_scan',
          issues,
        }
      }

      const reasonCode = parsed.tabScanStatus?.reasonCode ?? 'no_active_group'
      if (reasonCode !== 'ok') {
        issues.push({
          code: reasonCode,
          severity: reasonCode === 'tab_scan_failed' ? 'error' : 'warning',
          message: `Extension tab scan reported ${reasonCode}.`,
        })
      }

      return {
        tabs: [],
        source: 'none',
        issues,
      }
    } catch {
      const cachedTargets = this.relay.getTargets()
      if (cachedTargets.length > 0) {
        return {
          tabs: cachedTargets.map((target) => ({
            id: target.targetId,
            sessionId: target.sessionId,
            title: target.targetInfo.title,
            url: target.targetInfo.url,
          })),
          source: 'relay_cache_fallback',
          issues: [
            {
              code: 'tab_scan_failed',
              severity: 'error',
              message: 'Extension tab scan failed; using relay cache fallback.',
            },
            {
              code: 'relay_cache_fallback',
              severity: 'warning',
              message: 'Using relay cache fallback because authoritative extension tab scan failed.',
            },
          ],
        }
      }

      return {
        tabs: [],
        source: 'none',
        issues: [
          {
            code: 'tab_scan_failed',
            severity: 'error',
            message: 'Extension tab scan failed and relay cache is empty.',
          },
        ],
      }
    }
  }

  private async getRuntimeStatus(additionalIssues: BrowserRuntimeStatus['issues'] = []): Promise<BrowserRuntimeStatus> {
    const hello = this.relay?.getHello() ?? null
    const helloAt = this.relay?.getHelloAt() ?? null
    const diagnostics = this.relay?.getDiagnostics() ?? null
    const conflicts = await this.detectLegacyPortConflicts()
    const issues: BrowserRuntimeStatus['issues'] = []

    if (hello?.serverOrigin && normalizeServerOrigin(hello.serverOrigin) !== this.options.serverOrigin) {
      issues.push({
        code: 'extension_server_origin_mismatch',
        severity: 'error',
        message: `Extension is paired with ${hello.serverOrigin}, but this server expects ${this.options.serverOrigin}.`,
      })
    }

    if (hello?.pairedInstanceId && hello.pairedInstanceId !== this.options.instanceId) {
      issues.push({
        code: 'extension_instance_mismatch',
        severity: 'error',
        message: `Extension is paired with instance ${hello.pairedInstanceId}, but this server instance is ${this.options.instanceId}.`,
      })
    }

    for (const conflict of conflicts) {
      issues.push({
        code: `legacy_port_${conflict.port}`,
        severity: 'warning',
        message: conflict.message,
      })
    }

    issues.push(...additionalIssues)

    return {
      mode: 'embedded',
      serverOrigin: this.options.serverOrigin,
      instanceId: this.options.instanceId,
      extension: {
        connected: this.isExtensionConnected,
        helloAt,
        version: hello?.version ?? null,
        protocolVersion: hello?.protocolVersion ?? null,
        serverOrigin: hello?.serverOrigin ?? null,
        pairedInstanceId: hello?.pairedInstanceId ?? null,
        diagnostics,
      },
      conflicts,
      issues,
    }
  }

  private async detectLegacyPortConflicts(): Promise<BrowserRuntimeConflict[]> {
    let currentPort: number | null = null
    try {
      currentPort = Number(new URL(this.options.serverOrigin).port || 80)
    } catch {
      currentPort = null
    }

    const conflicts: BrowserRuntimeConflict[] = []
    for (const port of LEGACY_BROWSER_PORTS) {
      if (currentPort === port) continue
      if (!(await isLocalPortListening('127.0.0.1', port))) continue
      conflicts.push({
        host: '127.0.0.1',
        port,
        message: `Detected a legacy browser bridge listener on 127.0.0.1:${port}. Browser control now uses ${this.options.serverOrigin}/browser/* only.`,
      })
    }
    return conflicts
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
      const refreshedTabs = await this.refreshExtensionTabs()
      return refreshedTabs.tabs
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
    options?: {
      depth?: number
      filter?: 'all' | 'interactive' | 'visible'
      refId?: string
      maxChars?: number
      viewportOnly?: boolean
      maxNodes?: number
      includeShadow?: boolean
    },
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
        viewportOnly: options?.viewportOnly,
        maxNodes: options?.maxNodes,
        includeShadow: options?.includeShadow,
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
      viewportOnly: options?.viewportOnly,
      maxNodes: options?.maxNodes,
      includeShadow: options?.includeShadow,
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

  // ==================== Locate Elements ====================

  async locateElements(tabId: string, options: LocateOptions, browser?: BrowserTarget): Promise<LocateResult> {
    const channel = this.getChannel(browser)
    const expression = buildLocateExpression(options)
    let resultJson: string

    if (channel === 'extension') {
      const result = await this.relay!.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
      }, tabId) as { result?: { value?: string } }
      resultJson = String(result?.result?.value ?? '{}')
    } else {
      const wsUrl = await this.getTargetWsUrl(tabId)
      resultJson = String(await evaluateScript(wsUrl, expression) ?? '{}')
    }

    try {
      return normalizeLocateResult(JSON.parse(resultJson), options.query)
    } catch {
      return defaultLocateResult(options.query, ['Failed to parse locator result.'])
    }
  }

  // ==================== Find Elements ====================

  async findElements(tabId: string, query: string, browser?: BrowserTarget): Promise<FindMatch[]> {
    const result = await this.locateElements(
      tabId,
      {
        query,
        scope: 'auto',
        visibleOnly: true,
        viewportOnly: false,
        maxResults: 20,
        timeoutMs: 350,
      },
      browser,
    )
    return result.matches.map((match) => ({
      ref: match.targetId,
      targetId: match.targetId,
      tag: match.tag,
      text: match.text,
      label: match.label,
      role: match.role,
      score: match.score,
      rect: {
        x: match.rect.x,
        y: match.rect.y,
        width: match.rect.width,
        height: match.rect.height,
      },
    } as FindMatch & { targetId: string }))
  }

  // ==================== Click ====================

  async clickElement(tabId: string, options: ClickOptions, browser?: BrowserTarget): Promise<void> {
    const channel = this.getChannel(browser)
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1

    let coords: [number, number] | undefined = options.coordinate

    if (options.targetId && !coords) {
      coords = await this.resolveTargetToCoords(tabId, options.targetId, channel)
    }

    if (options.ref && !coords) {
      if (options.ref.startsWith('target_')) {
        try {
          coords = await this.resolveTargetToCoords(tabId, options.ref, channel)
        } catch {
          coords = await this.resolveRefToCoords(tabId, options.ref, channel)
        }
      } else {
        coords = await this.resolveRefToCoords(tabId, options.ref, channel)
      }
    }

    if (!coords) {
      throw new Error('Either targetId, ref, or coordinate is required for click')
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

  async fillForm(
    tabId: string,
    ref: string | undefined,
    value: unknown,
    browser?: BrowserTarget,
    targetId?: string,
  ): Promise<FormFillResult | TargetFormFillResult> {
    const channel = this.getChannel(browser)
    const stableTargetId = targetId ?? (ref?.startsWith('target_') ? ref : undefined)

    if (stableTargetId) {
      const expression = buildTargetFormFillExpression(stableTargetId, value)
      let resultJson: string
      if (channel === 'extension') {
        const result = await this.relay!.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
        }, tabId) as { result?: { value?: string } }
        resultJson = String(result?.result?.value ?? '{}')
      } else {
        const wsUrl = await this.getTargetWsUrl(tabId)
        resultJson = String(await evaluateScript(wsUrl, expression) ?? '{}')
      }
      try {
        return JSON.parse(resultJson) as TargetFormFillResult
      } catch {
        return { success: false, error: 'Failed to parse target fill result' }
      }
    }

    if (!ref) {
      return { success: false, error: 'Either ref or targetId is required' }
    }

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
      if (channel === 'extension') {
        const targetNumericId = Number(tabId)
        const states = this.relay?.getAgentStates() ?? []
        const state = states.find((s) => s.tabId === targetNumericId)
        if (state?.state === 'stopping') {
          throw new Error('Wait cancelled by user stop request')
        }
      }

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
      ) as unknown

      if (result && typeof result === 'object') {
        const record = result as {
          exceptionDetails?: { text?: string }
          result?: { value?: unknown }
          value?: unknown
        }

        if (record.exceptionDetails?.text) {
          throw new Error(record.exceptionDetails.text)
        }
        if (record.result && typeof record.result === 'object' && 'value' in record.result) {
          return record.result.value
        }
        if ('value' in record) {
          return record.value
        }
      }

      return result
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    return evaluateScript(wsUrl, expression)
  }

  // ==================== Extension Tool Forwarding ====================

  async callExtensionTool(
    tabId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options?: { timeoutMs?: number; taskLabel?: string },
  ): Promise<ExtensionToolResult> {
    if (!this.isExtensionConnected) {
      throw new Error('Chrome extension not connected. Install and connect the Nine1Bot Browser Control extension.')
    }
    const supportedTools = this.relay!.getTools()
    if (supportedTools.length > 0 && !supportedTools.includes(toolName)) {
      throw new Error(`Unknown extension tool: ${toolName}. Available: ${supportedTools.join(', ')}`)
    }
    const result = await this.relay!.sendCommand(
      'Extension.callTool',
      {
        toolName,
        args,
        timeoutMs: options?.timeoutMs,
        taskLabel: options?.taskLabel,
      },
      tabId
    )
    return result as ExtensionToolResult
  }

  async readConsoleMessages(
    tabId: string,
    options?: { sampleMs?: number; max?: number; sinceMs?: number; level?: string },
    browser?: BrowserTarget,
  ): Promise<unknown[]> {
    const channel = this.getChannel(browser)
    if (channel === 'cdp') {
      throw new Error('console_messages is currently supported only in extension channel. Use browser=\"user\".')
    }
    const result = await this.callExtensionTool(tabId, 'console_messages', options ?? {})
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '[]'
    return JSON.parse(text)
  }

  async readNetworkRequests(
    tabId: string,
    options?: { sampleMs?: number; max?: number; sinceMs?: number; resourceType?: string },
    browser?: BrowserTarget,
  ): Promise<unknown[]> {
    const channel = this.getChannel(browser)
    if (channel === 'cdp') {
      throw new Error('network_requests is currently supported only in extension channel. Use browser=\"user\".')
    }
    const result = await this.callExtensionTool(tabId, 'network_requests', options ?? {})
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '[]'
    return JSON.parse(text)
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
  private async resolveTargetToCoords(tabId: string, targetId: string, channel: 'extension' | 'cdp'): Promise<[number, number]> {
    const expression = buildResolveTargetExpression(targetId, { scrollIntoView: true })
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

    const parsed = JSON.parse(resultJson) as {
      found?: boolean
      centerX?: number
      centerY?: number
      message?: string
    } | null

    if (!parsed || parsed.found === false) {
      throw new Error(parsed?.message || `Target "${targetId}" not found`)
    }
    if (typeof parsed.centerX !== 'number' || typeof parsed.centerY !== 'number') {
      throw new Error(parsed.message || `Target "${targetId}" did not resolve to valid coordinates`)
    }
    return [parsed.centerX, parsed.centerY]
  }

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

    const parsed = JSON.parse(resultJson) as {
      found?: boolean
      centerX?: number
      centerY?: number
      visible?: boolean
      message?: string
    } | null

    if (!parsed || parsed.found === false) {
      throw new Error(parsed?.message || `Element with ref "${ref}" not found`)
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
      const newParsed = JSON.parse(newJson) as {
        found?: boolean
        centerX?: number
        centerY?: number
        message?: string
      } | null
      if (!newParsed || newParsed.found === false) {
        throw new Error(newParsed?.message || `Element with ref "${ref}" could not be resolved after scrolling`)
      }
      if (typeof newParsed.centerX === 'number' && typeof newParsed.centerY === 'number') {
        return [newParsed.centerX, newParsed.centerY]
      }
    }

    if (typeof parsed.centerX !== 'number' || typeof parsed.centerY !== 'number') {
      throw new Error(parsed.message || `Element with ref "${ref}" did not resolve to valid coordinates`)
    }

    return [parsed.centerX, parsed.centerY]
  }

  // ==================== HTTP API Routes ====================

  private createHttpApp(): Hono {
    const app = new Hono()

    app.get('/bootstrap', (c) => {
      return c.json({
        mode: 'embedded',
        serverOrigin: this.options.serverOrigin,
        instanceId: this.options.instanceId,
        extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      })
    })

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

    app.get('/diagnostics', async (c) => {
      try {
        const runtime = await this.getRuntimeStatus()
        return c.json({ ok: true, runtime })
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

    app.get('/extension/health', (c) => {
      const health = this.relay?.getHealth() ?? null
      const helloAt = this.relay?.getHelloAt() ?? null
      const hello = this.relay?.getHello() ?? null
      const capabilities = this.relay?.getCapabilities() ?? {}
      const agentStates = this.relay?.getAgentStates() ?? []
      return c.json({
        connected: this.isExtensionConnected,
        helloAt,
        hello,
        health,
        capabilities,
        agentStates,
        instanceId: this.options.instanceId,
        serverOrigin: this.options.serverOrigin,
      })
    })

    app.get('/extension/tools', (c) => {
      return c.json({
        connected: this.isExtensionConnected,
        tools: this.relay?.getTools() ?? [],
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
        const body = await c.req.json<{
          depth?: number
          filter?: 'all' | 'interactive' | 'visible'
          refId?: string
          viewportOnly?: boolean
          maxNodes?: number
          includeShadow?: boolean
        }>().catch(() => ({}))
        const result = await this.snapshot(tabId, body, browser)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/locate', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req.json<LocateOptions>().catch(() => ({ query: '' }))
        if (!body.query) return c.json({ ok: false, error: 'query is required' }, 400)
        const result = await this.locateElements(tabId, body, browser)
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
        const { ref, targetId, value } = await c.req.json<{ ref?: string; targetId?: string; value: unknown }>()
        if (!ref && !targetId) return c.json({ ok: false, error: 'ref or targetId is required' }, 400)
        const result = await this.fillForm(tabId, ref, value, browser, targetId)
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

    app.post('/tabs/:targetId/diagnostics/console', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req
          .json<{ sampleMs?: number; max?: number; sinceMs?: number; level?: string }>()
          .catch(() => ({}))
        const entries = await this.readConsoleMessages(tabId, body, browser)
        return c.json({ ok: true, entries })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/diagnostics/network', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const browser = c.req.query('browser') as BrowserTarget | undefined
        const body = await c.req
          .json<{ sampleMs?: number; max?: number; sinceMs?: number; resourceType?: string }>()
          .catch(() => ({}))
        const entries = await this.readNetworkRequests(tabId, body, browser)
        return c.json({ ok: true, entries })
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
