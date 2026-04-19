import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { createServer } from 'net'
import { BridgeServer } from '../../../browser-mcp-server/src/bridge/server'
import { createBridgeHttpRoutes } from '../../../browser-mcp-server/src/bridge/http-routes'
import { createRelayRoutes } from '../../../browser-mcp-server/src/bridge/relay-routes'
import type { BrowserConfig } from '../config/schema'
import { clearBridgeServer, setBridgeServer } from '../../../../opencode/packages/opencode/src/browser/bridge'

export interface BrowserServiceInstance {
  url: string
  app: Hono
  applyConfig(config: BrowserConfig): Promise<void>
  health(): Promise<boolean>
  stop(): Promise<void>
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(port)
      })
    })
  })
}

function createBrowserServiceApp(getBridge: () => BridgeServer | null): Hono {
  const app = new Hono()
  app.route('/', createRelayRoutes(() => Boolean(getBridge())))
  app.route('/', createBridgeHttpRoutes({ getBridge }))
  return app
}

function toBridgeOptions(config: BrowserConfig) {
  return {
    cdpPort: config.cdpPort,
    autoLaunch: config.autoLaunch,
    headless: config.headless,
  }
}

export async function startBrowserService(config: BrowserConfig): Promise<BrowserServiceInstance> {
  let currentBridge: BridgeServer | null = null
  const app = createBrowserServiceApp(() => currentBridge)
  const port = await findAvailablePort()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: app.fetch,
    websocket,
  })
  const url = server.url.toString().replace(/\/$/, '')

  const applyConfig = async (nextConfig: BrowserConfig) => {
    if (!nextConfig.enabled) {
      const bridge = currentBridge
      currentBridge = null
      clearBridgeServer()
      if (bridge) {
        await bridge.stop()
      }
      return
    }

    if (!currentBridge) {
      const bridge = new BridgeServer(toBridgeOptions(nextConfig))
      await bridge.start()
      currentBridge = bridge
    } else {
      await currentBridge.reconfigure(toBridgeOptions(nextConfig))
    }

    setBridgeServer(currentBridge)
  }

  try {
    await applyConfig(config)
  } catch (error) {
    server.stop(true)
    throw error
  }

  return {
    url,
    app,
    applyConfig,
    async health() {
      try {
        const response = await fetch(`${url}/status`)
        return response.ok
      } catch {
        return false
      }
    },
    async stop() {
      server.stop(true)
      const bridge = currentBridge
      currentBridge = null
      clearBridgeServer()
      if (bridge) {
        await bridge.stop()
      }
    },
  }
}
