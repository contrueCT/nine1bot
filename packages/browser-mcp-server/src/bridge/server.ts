/**
 * Browser Bridge Server
 * 提供 HTTP API + 直接方法调用两种方式控制浏览器
 * 支持两种模式：
 * 1. 直接 CDP 模式：启动新 Chrome 实例或连接现有实例
 * 2. Extension Relay 模式：通过 Chrome 扩展控制用户的浏览器（可访问登录状态）
 */

import { Hono } from 'hono'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import {
  listCdpTargets,
  createCdpTarget,
  closeCdpTarget,
  activateCdpTarget,
  captureScreenshot,
  evaluateScript,
  mouseClick,
  typeText,
  navigateToUrl,
  getCdpVersion,
} from '../core/cdp'
import { launchChrome, isChromeRunning, connectToChrome, type ChromeInstance } from '../core/chrome'
import { createExtensionRelay, type ExtensionRelay } from '../core/extension-relay'
import type { BrowserMcpConfig, Tab, PageContent, ScreenshotOptions, ExtensionToolResult } from '../core/types'

export interface BridgeServerState {
  server: Server | null
  port: number
  host: string
  cdpPort: number
  cdpUrl: string
  chromeInstance: ChromeInstance | null
  autoLaunch: boolean
  extensionRelay: ExtensionRelay | null
}

export interface BridgeServerOptions {
  port?: number
  host?: string
  cdpPort?: number
  autoLaunch?: boolean
  headless?: boolean
}

/**
 * Browser Bridge Server
 * Class-based, supports multiple instances, exposes direct methods for MCP layer
 */
export class BridgeServer {
  private state: BridgeServerState | null = null
  private options: Required<BridgeServerOptions>

  constructor(options: BridgeServerOptions = {}) {
    this.options = {
      port: options.port ?? 18791,
      host: options.host ?? '127.0.0.1',
      cdpPort: options.cdpPort ?? 9222,
      autoLaunch: options.autoLaunch ?? true,
      headless: options.headless ?? false,
    }
  }

  // ==================== Lifecycle ====================

  async start(): Promise<BridgeServerState> {
    if (this.state?.server) {
      console.log('[Browser Bridge] Server already running')
      return this.state
    }

    const { port, host, cdpPort, autoLaunch } = this.options
    const app = this.createHttpApp()

    // 使用 Node 原生 http.createServer 而非 @hono/node-server
    // 避免全局 Response 污染（Bun 兼容性）
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = `http://${host}:${port}${req.url || '/'}`
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }

      const body = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks)))
      })

      const request = new Request(url, {
        method: req.method || 'GET',
        headers,
        body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : new Uint8Array(body),
      })

      try {
        const response = await app.fetch(request)
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        const arrayBuffer = await response.arrayBuffer()
        res.end(Buffer.from(arrayBuffer))
      } catch {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    })

    await new Promise<void>((resolve) => {
      server.listen(port, host, () => resolve())
    })

    const extensionRelay = createExtensionRelay({ httpServer: server })

    this.state = {
      server,
      port,
      host,
      cdpPort,
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      chromeInstance: null,
      autoLaunch,
      extensionRelay,
    }

    console.log(`[Browser Bridge] Server started at http://${host}:${port}`)
    console.log(`[Browser Bridge] CDP port: ${cdpPort}, Auto-launch: ${autoLaunch}`)
    console.log(`[Browser Bridge] Extension Relay enabled at ws://${host}:${port}/extension`)

    return this.state
  }

  async stop(): Promise<void> {
    if (!this.state) return

    if (this.state.extensionRelay) {
      await this.state.extensionRelay.stop()
      this.state.extensionRelay = null
    }

    if (this.state.chromeInstance) {
      await this.state.chromeInstance.stop()
      this.state.chromeInstance = null
    }

    if (this.state.server) {
      this.state.server.close()
      this.state.server = null
    }

    this.state = null
    console.log('[Browser Bridge] Server stopped')
  }

  getState(): BridgeServerState | null {
    return this.state
  }

  get isExtensionConnected(): boolean {
    return this.state?.extensionRelay?.extensionConnected() ?? false
  }

  // ==================== Direct Methods (for MCP layer) ====================

  async listTabs(): Promise<Tab[]> {
    if (this.isExtensionConnected) {
      const targets = this.state!.extensionRelay!.getTargets()
      return targets.map(t => ({
        id: t.targetId,
        sessionId: t.sessionId,
        title: t.targetInfo.title,
        url: t.targetInfo.url,
      }))
    }

    // Direct CDP mode
    const cdpUrl = await this.ensureBrowserAvailable()
    const targets = await listCdpTargets(cdpUrl)
    return targets
      .filter(t => t.type === 'page')
      .map(t => ({ id: t.id, title: t.title, url: t.url }))
  }

  async screenshot(tabId: string, options?: ScreenshotOptions): Promise<{ data: string; mimeType: string }> {
    const format = options?.format ?? 'png'
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'

    if (this.isExtensionConnected) {
      const result = await this.state!.extensionRelay!.sendCommand(
        'Page.captureScreenshot',
        { format },
        tabId
      ) as { data?: string }

      if (!result?.data) throw new Error('Screenshot failed: no data returned')
      return { data: result.data, mimeType }
    }

    // Direct CDP mode
    const wsUrl = await this.getTargetWsUrl(tabId)
    const buffer = await captureScreenshot(wsUrl, { fullPage: options?.fullPage, format })
    return { data: buffer.toString('base64'), mimeType }
  }

  async navigate(tabId: string, url: string): Promise<void> {
    if (this.isExtensionConnected) {
      await this.state!.extensionRelay!.sendCommand('Page.navigate', { url }, tabId)
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await navigateToUrl(wsUrl, url)
  }

  async click(tabId: string, x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void> {
    const button = options?.button ?? 'left'
    const clickCount = options?.clickCount ?? 1

    if (this.isExtensionConnected) {
      const relay = this.state!.extensionRelay!
      await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, tabId)
      await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, tabId)
      await relay.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, tabId)
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await mouseClick(wsUrl, x, y, { button, clickCount })
  }

  async type(tabId: string, text: string, delay?: number): Promise<void> {
    if (this.isExtensionConnected) {
      await this.state!.extensionRelay!.sendCommand('Input.insertText', { text }, tabId)
      return
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    await typeText(wsUrl, text, delay)
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    if (this.isExtensionConnected) {
      const result = await this.state!.extensionRelay!.sendCommand(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        tabId
      ) as { result?: { value?: unknown } }
      return result?.result?.value
    }

    const wsUrl = await this.getTargetWsUrl(tabId)
    return evaluateScript(wsUrl, expression)
  }

  async getContent(tabId: string): Promise<PageContent> {
    if (this.isExtensionConnected) {
      const relay = this.state!.extensionRelay!

      const [htmlResult, titleResult, urlResult] = await Promise.all([
        relay.sendCommand('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, tabId) as Promise<{ result?: { value?: string } }>,
        relay.sendCommand('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, tabId) as Promise<{ result?: { value?: string } }>,
        relay.sendCommand('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }, tabId) as Promise<{ result?: { value?: string } }>,
      ])

      return {
        title: titleResult?.result?.value ?? '',
        url: urlResult?.result?.value ?? '',
        content: typeof htmlResult?.result?.value === 'string' ? htmlResult.result.value.slice(0, 100000) : '',
      }
    }

    // Direct CDP mode
    const wsUrl = await this.getTargetWsUrl(tabId)
    const [html, title, url] = await Promise.all([
      evaluateScript(wsUrl, 'document.documentElement.outerHTML'),
      evaluateScript(wsUrl, 'document.title'),
      evaluateScript(wsUrl, 'window.location.href'),
    ])

    return {
      title: String(title ?? ''),
      url: String(url ?? ''),
      content: typeof html === 'string' ? html.slice(0, 100000) : '',
    }
  }

  // ==================== Extension Tool Forwarding ====================

  /**
   * Call a Chrome extension tool by name (bypasses CSP restrictions).
   * Only available when the extension is connected via relay.
   *
   * Available tools: read_page, find, get_page_text, computer, form_input,
   *   screenshot, navigate, tabs_context_mcp, tabs_create_mcp
   */
  async callExtensionTool(tabId: string, toolName: string, args: Record<string, unknown> = {}): Promise<ExtensionToolResult> {
    if (!this.isExtensionConnected) {
      throw new Error('Chrome extension not connected. Install and connect the Nine1Bot Browser Control extension.')
    }
    const result = await this.state!.extensionRelay!.sendCommand(
      'Extension.callTool',
      { toolName, args },
      tabId
    )
    return result as ExtensionToolResult
  }

  // ==================== Internal Helpers ====================

  private async ensureBrowserAvailable(): Promise<string> {
    if (!this.state) throw new Error('Bridge server not started')

    if (await isChromeRunning(this.state.cdpPort)) {
      return this.state.cdpUrl
    }

    if (this.state.autoLaunch) {
      console.log('[Browser Bridge] Launching Chrome...')
      const instance = await launchChrome({
        cdpPort: this.state.cdpPort,
        headless: this.options.headless,
      })
      this.state.chromeInstance = instance
      this.state.cdpUrl = instance.cdpUrl
      return this.state.cdpUrl
    }

    throw new Error('Chrome is not running. Please start Chrome with --remote-debugging-port=' + this.state.cdpPort)
  }

  private async getTargetWsUrl(targetId: string): Promise<string> {
    const cdpUrl = await this.ensureBrowserAvailable()
    const targets = await listCdpTargets(cdpUrl)
    const target = targets.find(t => t.id === targetId)

    if (!target) throw new Error(`Target not found: ${targetId}`)
    if (!target.webSocketDebuggerUrl) throw new Error(`Target has no WebSocket URL: ${targetId}`)

    return target.webSocketDebuggerUrl
  }

  // ==================== HTTP App (optional, for backward compat) ====================

  private createHttpApp() {
    const app = new Hono()

    app.get('/', async (c) => {
      try {
        const running = await isChromeRunning(this.state?.cdpPort ?? 9222)
        return c.json({
          ok: true,
          running,
          cdpPort: this.state?.cdpPort ?? 9222,
          autoLaunch: this.state?.autoLaunch ?? false,
          extensionRelay: {
            enabled: Boolean(this.state?.extensionRelay),
            connected: this.isExtensionConnected,
          },
        })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.get('/extension/status', (c) => {
      const targets = this.state?.extensionRelay?.getTargets() ?? []
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
      const wsHost = `ws://${this.state?.host}:${this.state?.port}`
      if (this.isExtensionConnected) {
        return c.json({
          Browser: 'Browser-MCP/Extension-Relay',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `${wsHost}/cdp`,
        })
      }
      try {
        const version = await getCdpVersion(this.state?.cdpUrl ?? `http://127.0.0.1:${this.state?.cdpPort ?? 9222}`)
        return c.json({ ...version, webSocketDebuggerUrl: `${wsHost}/cdp` })
      } catch {
        return c.json({ Browser: 'Browser-MCP/Bridge', 'Protocol-Version': '1.3' })
      }
    })

    app.get('/tabs', async (c) => {
      try {
        const tabs = await this.listTabs()
        return c.json({ ok: true, mode: this.isExtensionConnected ? 'extension' : 'cdp', tabs })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/screenshot', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const body = await c.req.json<{ fullPage?: boolean; format?: 'png' | 'jpeg' }>().catch(() => ({}))
        const result = await this.screenshot(tabId, body)
        return c.json({ ok: true, ...result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/navigate', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const { url } = await c.req.json<{ url: string }>()
        if (!url) return c.json({ ok: false, error: 'url is required' }, 400)
        await this.navigate(tabId, url)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/click', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const body = await c.req.json<{ x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }>()
        if (typeof body.x !== 'number' || typeof body.y !== 'number') {
          return c.json({ ok: false, error: 'x and y are required' }, 400)
        }
        await this.click(tabId, body.x, body.y, body)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/type', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const { text, delay } = await c.req.json<{ text: string; delay?: number }>()
        if (!text) return c.json({ ok: false, error: 'text is required' }, 400)
        await this.type(tabId, text, delay)
        return c.json({ ok: true })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/evaluate', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const { expression } = await c.req.json<{ expression: string }>()
        if (!expression) return c.json({ ok: false, error: 'expression is required' }, 400)
        const result = await this.evaluate(tabId, expression)
        return c.json({ ok: true, result })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    app.post('/tabs/:targetId/content', async (c) => {
      try {
        const tabId = c.req.param('targetId')
        const content = await this.getContent(tabId)
        return c.json({ ok: true, ...content })
      } catch (error) {
        return c.json({ ok: false, error: String(error) }, 500)
      }
    })

    // Extension tool forwarding (for BridgeClient HTTP mode)
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
