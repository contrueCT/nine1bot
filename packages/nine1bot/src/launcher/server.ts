import { websocket } from 'hono/bun'
import type { ServerConfig, AuthConfig, Nine1BotConfig } from '../config/schema'
import { getInstallDir } from '../config/loader'
import { ShellGlobalEvents } from '../server/events'
import { createShellApp } from '../server/app'
import { startBrowserService, type BrowserServiceInstance } from '../browser/service'
import type { EngineAdapter } from '../engine/types'
import { EngineManager } from '../engine/manager'

export interface ServerInstance {
  url: string
  hostname: string
  port: number
  stop: () => Promise<void>
}

export interface StartServerOptions {
  server: ServerConfig
  auth: AuthConfig
  configPath: string
  fullConfig: Nine1BotConfig
}

async function createAdapter(): Promise<EngineAdapter> {
  const mode = process.env.NINE1BOT_ENGINE_MODE
  if (mode === 'subprocess') {
    const { SubprocessOpencodeAdapter } = await import('../engine/adapters/subprocess')
    return new SubprocessOpencodeAdapter()
  }
  const { InProcessOpencodeAdapter } = await import('../engine/adapters/in-process')
  return new InProcessOpencodeAdapter()
}

export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  const { server, auth, fullConfig } = options
  const installDir = getInstallDir()
  const projectDir = process.env.NINE1BOT_PROJECT_DIR || process.cwd()
  let browserService: BrowserServiceInstance | undefined
  try {
    browserService = await startBrowserService(fullConfig.browser)
  } catch (error) {
    console.warn(`[Nine1Bot] Failed to start browser service: ${error instanceof Error ? error.message : String(error)}`)
  }
  const engineManager = new EngineManager(await createAdapter(), {
    configPath: options.configPath,
    installDir,
    projectDir,
    browserServiceUrl: browserService?.url,
  })
  const globalEvents = new ShellGlobalEvents()

  try {
    await engineManager.start(fullConfig)
    const app = createShellApp({
      auth,
      browserService,
      configPath: options.configPath,
      engineManager,
      globalEvents,
      projectDir,
    })
    const args = {
      hostname: server.hostname,
      idleTimeout: 0,
      fetch: app.fetch,
      websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const publicServer = server.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(server.port)
    if (!publicServer) {
      throw new Error(`Failed to start server on port ${server.port}`)
    }

    return {
      url: publicServer.url.toString(),
      hostname: publicServer.hostname ?? server.hostname,
      port: publicServer.port ?? server.port,
      stop: async () => {
        publicServer.stop(true)
        await engineManager.stop()
        await browserService?.stop()
      },
    }
  } catch (error) {
    await engineManager.stop().catch(() => {})
    await browserService?.stop().catch(() => {})
    throw error
  }
}
