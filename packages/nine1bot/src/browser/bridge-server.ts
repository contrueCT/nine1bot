/**
 * Browser Bridge Server
 * 提供 HTTP API 供 MCP 工具调用，通过 CDP 控制浏览器
 * 支持两种模式：
 * 1. 直接 CDP 模式：启动新 Chrome 实例或连接现有实例
 * 2. Extension Relay 模式：通过 Chrome 扩展控制用户的浏览器（可访问登录状态）
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { Server } from 'http'
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
  type CDPTarget,
} from './cdp'
import { launchChrome, isChromeRunning, connectToChrome, type ChromeInstance } from './chrome'
import { createExtensionRelay, type ExtensionRelay } from './extension-relay'

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

let state: BridgeServerState | null = null

/**
 * 确保 Chrome 浏览器可用（直接 CDP 模式）
 */
async function ensureBrowserAvailable(): Promise<string> {
  if (!state) {
    throw new Error('Bridge server not started')
  }

  // 检查是否已有 Chrome 运行
  if (await isChromeRunning(state.cdpPort)) {
    return state.cdpUrl
  }

  // 如果启用了自动启动
  if (state.autoLaunch) {
    console.log('[Browser Bridge] Launching Chrome...')
    const instance = await launchChrome({
      cdpPort: state.cdpPort,
      headless: false,
    })
    state.chromeInstance = instance
    state.cdpUrl = instance.cdpUrl
    console.log('[Browser Bridge] Chrome launched, CDP URL:', state.cdpUrl)
    return state.cdpUrl
  }

  throw new Error('Chrome is not running. Please start Chrome with --remote-debugging-port=' + state.cdpPort)
}

/**
 * 获取指定目标的 WebSocket URL
 */
async function getTargetWsUrl(targetId: string): Promise<string> {
  const cdpUrl = await ensureBrowserAvailable()
  const targets = await listCdpTargets(cdpUrl)
  const target = targets.find(t => t.id === targetId)

  if (!target) {
    throw new Error(`Target not found: ${targetId}`)
  }

  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Target has no WebSocket URL: ${targetId}`)
  }

  return target.webSocketDebuggerUrl
}

/**
 * 创建 Bridge Server 的 Hono 应用
 */
function createBridgeApp() {
  const app = new Hono()

  // 健康检查 - 包含 Extension Relay 状态
  app.get('/', async (c) => {
    try {
      const cdpUrl = state?.cdpUrl ?? `http://127.0.0.1:${state?.cdpPort ?? 9222}`
      const running = await isChromeRunning(state?.cdpPort ?? 9222)
      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      let version = null
      if (running) {
        try {
          version = await getCdpVersion(cdpUrl)
        } catch {}
      }

      return c.json({
        ok: true,
        running,
        cdpUrl,
        cdpPort: state?.cdpPort ?? 9222,
        autoLaunch: state?.autoLaunch ?? false,
        version: version?.Browser ?? null,
        extensionRelay: {
          enabled: Boolean(state?.extensionRelay),
          connected: extensionConnected,
          wsUrl: extensionConnected ? `ws://${state?.host}:${state?.port}/extension` : null,
          cdpWsUrl: extensionConnected ? `ws://${state?.host}:${state?.port}/cdp` : null,
        },
      })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // Extension Relay 状态
  app.get('/extension/status', (c) => {
    const connected = state?.extensionRelay?.extensionConnected() ?? false
    const targets = state?.extensionRelay?.getTargets() ?? []
    return c.json({
      connected,
      targets: targets.map(t => ({
        id: t.targetId,
        sessionId: t.sessionId,
        title: t.targetInfo.title,
        url: t.targetInfo.url,
      })),
    })
  })

  // CDP JSON API（兼容标准 CDP 协议）
  app.get('/json/version', async (c) => {
    const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false
    const wsHost = `ws://${state?.host}:${state?.port}`

    if (extensionConnected) {
      // Extension mode
      return c.json({
        Browser: 'Nine1Bot/Extension-Relay',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `${wsHost}/cdp`,
      })
    }

    // Direct CDP mode
    try {
      const cdpUrl = state?.cdpUrl ?? `http://127.0.0.1:${state?.cdpPort ?? 9222}`
      const version = await getCdpVersion(cdpUrl)
      return c.json({
        ...version,
        webSocketDebuggerUrl: `${wsHost}/cdp`,
      })
    } catch {
      return c.json({
        Browser: 'Nine1Bot/Bridge',
        'Protocol-Version': '1.3',
      })
    }
  })

  app.get('/json/list', async (c) => {
    const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false
    const wsHost = `ws://${state?.host}:${state?.port}`

    if (extensionConnected) {
      // Extension mode - return targets from relay
      const targets = state?.extensionRelay?.getTargets() ?? []
      return c.json(targets.map(t => ({
        id: t.targetId,
        type: t.targetInfo.type ?? 'page',
        title: t.targetInfo.title ?? '',
        description: t.targetInfo.title ?? '',
        url: t.targetInfo.url ?? '',
        webSocketDebuggerUrl: `${wsHost}/cdp`,
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=${wsHost.replace('ws://', '')}/cdp`,
      })))
    }

    // Direct CDP mode
    try {
      const cdpUrl = await ensureBrowserAvailable()
      const targets = await listCdpTargets(cdpUrl)
      return c.json(targets.filter(t => t.type === 'page').map(t => ({
        id: t.id,
        type: t.type,
        title: t.title,
        description: t.title,
        url: t.url,
        webSocketDebuggerUrl: `${wsHost}/cdp`,
      })))
    } catch (error) {
      return c.json([])
    }
  })

  // 启动浏览器（直接 CDP 模式）
  app.post('/start', async (c) => {
    try {
      const cdpUrl = await ensureBrowserAvailable()
      return c.json({ ok: true, cdpUrl })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 停止浏览器
  app.post('/stop', async (c) => {
    try {
      if (state?.chromeInstance) {
        await state.chromeInstance.stop()
        state.chromeInstance = null
        return c.json({ ok: true, stopped: true })
      }
      return c.json({ ok: true, stopped: false, message: 'No managed browser instance' })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 列出所有标签页
  app.get('/tabs', async (c) => {
    const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

    if (extensionConnected) {
      // Extension mode
      const targets = state?.extensionRelay?.getTargets() ?? []
      return c.json({
        ok: true,
        mode: 'extension',
        tabs: targets.map(t => ({
          id: t.targetId,
          sessionId: t.sessionId,
          title: t.targetInfo.title,
          url: t.targetInfo.url,
        })),
      })
    }

    // Direct CDP mode
    try {
      const cdpUrl = await ensureBrowserAvailable()
      const targets = await listCdpTargets(cdpUrl)
      const tabs = targets
        .filter(t => t.type === 'page')
        .map(t => ({
          id: t.id,
          title: t.title,
          url: t.url,
        }))
      return c.json({ ok: true, mode: 'cdp', tabs })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 创建新标签页
  app.post('/tabs', async (c) => {
    try {
      const body = await c.req.json<{ url?: string }>()
      const url = body.url ?? 'about:blank'
      const cdpUrl = await ensureBrowserAvailable()
      const target = await createCdpTarget(cdpUrl, url)
      return c.json({
        ok: true,
        tab: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
      })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 关闭标签页
  app.delete('/tabs/:targetId', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const cdpUrl = await ensureBrowserAvailable()
      await closeCdpTarget(cdpUrl, targetId)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 激活标签页
  app.post('/tabs/:targetId/activate', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const cdpUrl = await ensureBrowserAvailable()
      await activateCdpTarget(cdpUrl, targetId)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 导航到 URL
  app.post('/tabs/:targetId/navigate', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const body = await c.req.json<{ url: string }>()

      if (!body.url) {
        return c.json({ ok: false, error: 'url is required' }, 400)
      }

      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      if (extensionConnected) {
        // Extension mode - use Page.navigate
        await state!.extensionRelay!.sendCommand(
          'Page.navigate',
          { url: body.url },
          targetId
        )
        return c.json({ ok: true })
      }

      // Direct CDP mode
      const wsUrl = await getTargetWsUrl(targetId)
      await navigateToUrl(wsUrl, body.url)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 截图
  app.post('/tabs/:targetId/screenshot', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const body = await c.req.json<{ fullPage?: boolean; format?: 'png' | 'jpeg' }>().catch(() => ({}))

      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      if (extensionConnected) {
        // Extension mode - use extension to capture screenshot
        const result = await state!.extensionRelay!.sendCommand(
          'Page.captureScreenshot',
          { format: body.format || 'png' },
          targetId
        ) as { data?: string }

        if (result?.data) {
          return c.json({
            ok: true,
            data: result.data,
            mimeType: body.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          })
        }
        return c.json({ ok: false, error: 'Screenshot failed' }, 500)
      }

      // Direct CDP mode
      const wsUrl = await getTargetWsUrl(targetId)
      const buffer = await captureScreenshot(wsUrl, {
        fullPage: body.fullPage,
        format: body.format,
      })

      const base64 = buffer.toString('base64')
      return c.json({
        ok: true,
        data: base64,
        mimeType: body.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 执行 JavaScript
  app.post('/tabs/:targetId/evaluate', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const body = await c.req.json<{ expression: string }>()

      if (!body.expression) {
        return c.json({ ok: false, error: 'expression is required' }, 400)
      }

      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      if (extensionConnected) {
        // Extension mode
        const result = await state!.extensionRelay!.sendCommand(
          'Runtime.evaluate',
          { expression: body.expression, returnByValue: true },
          targetId
        ) as { result?: { value?: unknown } }

        return c.json({ ok: true, result: result?.result?.value })
      }

      // Direct CDP mode
      const wsUrl = await getTargetWsUrl(targetId)
      const result = await evaluateScript(wsUrl, body.expression)
      return c.json({ ok: true, result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 鼠标点击
  app.post('/tabs/:targetId/click', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const body = await c.req.json<{ x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }>()

      if (typeof body.x !== 'number' || typeof body.y !== 'number') {
        return c.json({ ok: false, error: 'x and y coordinates are required' }, 400)
      }

      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      if (extensionConnected) {
        // Extension mode - simulate mouse click
        const x = body.x
        const y = body.y
        const button = body.button || 'left'
        const clickCount = body.clickCount || 1

        // Mouse move
        await state!.extensionRelay!.sendCommand(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x, y },
          targetId
        )

        // Mouse down
        await state!.extensionRelay!.sendCommand(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x, y, button, clickCount },
          targetId
        )

        // Mouse up
        await state!.extensionRelay!.sendCommand(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x, y, button, clickCount },
          targetId
        )

        return c.json({ ok: true })
      }

      // Direct CDP mode
      const wsUrl = await getTargetWsUrl(targetId)
      await mouseClick(wsUrl, body.x, body.y, {
        button: body.button,
        clickCount: body.clickCount,
      })
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 键盘输入
  app.post('/tabs/:targetId/type', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const body = await c.req.json<{ text: string; delay?: number }>()

      if (!body.text) {
        return c.json({ ok: false, error: 'text is required' }, 400)
      }

      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      if (extensionConnected) {
        // Extension mode - use Input.insertText for simple text input
        await state!.extensionRelay!.sendCommand(
          'Input.insertText',
          { text: body.text },
          targetId
        )
        return c.json({ ok: true })
      }

      // Direct CDP mode
      const wsUrl = await getTargetWsUrl(targetId)
      await typeText(wsUrl, body.text, body.delay)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // 获取页面内容（DOM 树简化版）
  app.post('/tabs/:targetId/content', async (c) => {
    try {
      const targetId = c.req.param('targetId')
      const extensionConnected = state?.extensionRelay?.extensionConnected() ?? false

      if (extensionConnected) {
        // Extension mode
        const htmlResult = await state!.extensionRelay!.sendCommand(
          'Runtime.evaluate',
          { expression: 'document.documentElement.outerHTML', returnByValue: true },
          targetId
        ) as { result?: { value?: string } }

        const titleResult = await state!.extensionRelay!.sendCommand(
          'Runtime.evaluate',
          { expression: 'document.title', returnByValue: true },
          targetId
        ) as { result?: { value?: string } }

        const urlResult = await state!.extensionRelay!.sendCommand(
          'Runtime.evaluate',
          { expression: 'window.location.href', returnByValue: true },
          targetId
        ) as { result?: { value?: string } }

        const html = htmlResult?.result?.value ?? ''
        const title = titleResult?.result?.value ?? ''
        const url = urlResult?.result?.value ?? ''

        return c.json({
          ok: true,
          title,
          url,
          html: typeof html === 'string' ? html.slice(0, 100000) : '',
        })
      }

      // Direct CDP mode
      const wsUrl = await getTargetWsUrl(targetId)

      // 获取页面 HTML
      const html = await evaluateScript(wsUrl, 'document.documentElement.outerHTML')
      // 获取页面标题
      const title = await evaluateScript(wsUrl, 'document.title')
      // 获取页面 URL
      const url = await evaluateScript(wsUrl, 'window.location.href')

      return c.json({
        ok: true,
        title,
        url,
        html: typeof html === 'string' ? html.slice(0, 100000) : '', // 限制大小
      })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  return app
}

/**
 * 启动 Bridge Server
 */
export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<BridgeServerState> {
  const port = options.port ?? 18791
  const host = options.host ?? '127.0.0.1'
  const cdpPort = options.cdpPort ?? 9222
  const autoLaunch = options.autoLaunch ?? true

  if (state?.server) {
    console.log('[Browser Bridge] Server already running')
    return state
  }

  const app = createBridgeApp()

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  }) as Server

  // 创建 Extension Relay
  const extensionRelay = createExtensionRelay({
    httpServer: server,
  })

  state = {
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

  return state
}

/**
 * 停止 Bridge Server
 */
export async function stopBridgeServer(): Promise<void> {
  if (!state) return

  // 停止 Extension Relay
  if (state.extensionRelay) {
    await state.extensionRelay.stop()
    state.extensionRelay = null
  }

  // 停止 Chrome
  if (state.chromeInstance) {
    await state.chromeInstance.stop()
    state.chromeInstance = null
  }

  // 关闭服务器
  if (state.server) {
    state.server.close()
    state.server = null
  }

  state = null
  console.log('[Browser Bridge] Server stopped')
}

/**
 * 获取当前状态
 */
export function getBridgeState(): BridgeServerState | null {
  return state
}
