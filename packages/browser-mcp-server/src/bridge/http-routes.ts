import { Hono } from 'hono'
import type { BrowserTarget, ClickOptions } from '../core/types'
import type { BridgeServer } from './server'

interface BridgeHttpRoutesOptions {
  getBridge: () => BridgeServer | null
}

const BROWSER_DISABLED_RESPONSE = { ok: false, error: 'Browser control not enabled' }

export function createBridgeHttpRoutes(options: BridgeHttpRoutesOptions): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    if (!options.getBridge()) {
      return c.json(BROWSER_DISABLED_RESPONSE, 503)
    }
    return next()
  })

  app.get('/', async (c) => {
    try {
      const bridge = options.getBridge()!
      const status = await bridge.getStatus()
      return c.json({ ok: true, ...status })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.get('/status', async (c) => {
    try {
      const bridge = options.getBridge()!
      const status = await bridge.getStatus()
      return c.json({ ok: true, ...status })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/launch', async (c) => {
    try {
      const bridge = options.getBridge()!
      const body = await c.req.json<{ headless?: boolean; url?: string }>().catch(() => ({}))
      const result = await bridge.launchBotBrowser(body)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.get('/extension/status', (c) => {
    const bridge = options.getBridge()!
    return c.json(bridge.getExtensionStatus())
  })

  app.get('/extension/health', (c) => {
    const bridge = options.getBridge()!
    return c.json(bridge.getExtensionHealth())
  })

  app.get('/extension/tools', (c) => {
    const bridge = options.getBridge()!
    return c.json(bridge.getExtensionToolsInfo())
  })

  app.get('/json/version', async (c) => {
    const bridge = options.getBridge()!
    return c.json(await bridge.getVersionInfo())
  })

  app.get('/tabs', async (c) => {
    try {
      const bridge = options.getBridge()!
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const tabs = await bridge.listTabs(browser)
      return c.json({ ok: true, tabs })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/snapshot', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const body = await c.req.json<{ depth?: number; filter?: 'all' | 'interactive' | 'visible'; refId?: string }>().catch(() => ({}))
      const result = await bridge.snapshot(tabId, body, browser)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/find', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { query } = await c.req.json<{ query: string }>()
      if (!query) return c.json({ ok: false, error: 'query is required' }, 400)
      const matches = await bridge.findElements(tabId, query, browser)
      return c.json({ ok: true, matches })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/screenshot', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const body = await c.req.json<{ fullPage?: boolean; format?: 'png' | 'jpeg' }>().catch(() => ({}))
      const result = await bridge.screenshot(tabId, body, browser)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/navigate', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const body = await c.req.json<{ url?: string; action?: 'goto' | 'back' | 'forward' | 'reload' | 'new_tab' | 'close_tab' }>()
      const result = await bridge.navigate(tabId, body, browser)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/click', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const body = await c.req.json<ClickOptions>()
      await bridge.clickElement(tabId, body, browser)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/fill', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { ref, value } = await c.req.json<{ ref: string; value: unknown }>()
      if (!ref) return c.json({ ok: false, error: 'ref is required' }, 400)
      const result = await bridge.fillForm(tabId, ref, value, browser)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/press-key', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { key } = await c.req.json<{ key: string }>()
      if (!key) return c.json({ ok: false, error: 'key is required' }, 400)
      await bridge.pressKey(tabId, key, browser)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/scroll', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { direction, amount, ref } = await c.req.json<{ direction: string; amount?: number; ref?: string }>()
      if (!direction) return c.json({ ok: false, error: 'direction is required' }, 400)
      await bridge.scroll(tabId, direction as 'up' | 'down' | 'left' | 'right', amount, ref, browser)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/wait', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { text, timeout } = await c.req.json<{ text: string; timeout?: number }>()
      if (!text) return c.json({ ok: false, error: 'text is required' }, 400)
      const found = await bridge.waitForText(tabId, text, timeout, browser)
      return c.json({ ok: true, found })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/evaluate', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { expression } = await c.req.json<{ expression: string }>()
      if (!expression) return c.json({ ok: false, error: 'expression is required' }, 400)
      const result = await bridge.evaluate(tabId, expression, browser)
      return c.json({ ok: true, result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/diagnostics/console', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const body = await c.req
        .json<{ sampleMs?: number; max?: number; sinceMs?: number; level?: string }>()
        .catch(() => ({}))
      const entries = await bridge.readConsoleMessages(tabId, body, browser)
      return c.json({ ok: true, entries })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/diagnostics/network', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const body = await c.req
        .json<{ sampleMs?: number; max?: number; sinceMs?: number; resourceType?: string }>()
        .catch(() => ({}))
      const entries = await bridge.readNetworkRequests(tabId, body, browser)
      return c.json({ ok: true, entries })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/dialog', async (c) => {
    try {
      const bridge = options.getBridge()!
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { action, promptText } = await c.req.json<{ action: 'accept' | 'dismiss'; promptText?: string }>()
      if (!action) return c.json({ ok: false, error: 'action is required' }, 400)
      await bridge.handleDialog(action, promptText, browser)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/upload', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const browser = c.req.query('browser') as BrowserTarget | undefined
      const { ref, filePath } = await c.req.json<{ ref: string; filePath: string }>()
      if (!ref || !filePath) return c.json({ ok: false, error: 'ref and filePath are required' }, 400)
      await bridge.uploadFile(tabId, ref, filePath, browser)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.post('/tabs/:targetId/tool/:toolName', async (c) => {
    try {
      const bridge = options.getBridge()!
      const tabId = c.req.param('targetId')
      const toolName = c.req.param('toolName')
      const args = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const result = await bridge.callExtensionTool(tabId, toolName, args)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  return app
}
