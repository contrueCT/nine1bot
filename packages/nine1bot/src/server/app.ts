import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { AuthConfig } from '../config/schema'
import type { EngineManager } from '../engine'
import type { BrowserServiceInstance } from '../browser/service'
import type { ShellGlobalEvents } from './events'
import { createShellConfigRoutes } from './routes/config'
import { createGlobalRoutes } from './routes/global'
import { createPreferencesRoutes } from './routes/preferences'
import { createProjectContextRoutes } from './routes/project-context'

export interface ShellAppOptions {
  auth: AuthConfig
  browserService?: BrowserServiceInstance
  configPath: string
  engineManager: EngineManager
  globalEvents: ShellGlobalEvents
  projectDir: string
}

function allowOrigin(input?: string) {
  if (!input) return
  if (input.startsWith('http://localhost:')) return input
  if (input.startsWith('http://127.0.0.1:')) return input
  if (input === 'tauri://localhost' || input === 'http://tauri.localhost') return input
  if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
  if (/^https:\/\/[a-z0-9-]+\.ngrok(-free)?\.app$/.test(input)) return input
  if (/^https:\/\/[a-z0-9-]+\.ngrok\.io$/.test(input)) return input
  return
}

function createAuthMiddleware(auth: AuthConfig) {
  if (!auth.enabled || !auth.password) {
    return async (_c: any, next: () => Promise<void>) => next()
  }

  const username = 'nine1bot'
  const password = auth.password

  return async (c: any, next: () => Promise<void>) => {
    try {
      return await basicAuth({ username, password })(c, next)
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error
      }
      const authHeader = c.req.header('Authorization')
      if (authHeader) {
        try {
          const match = authHeader.match(/^Basic\s+(.+)$/i)
          if (match) {
            const decoded = atob(match[1])
            const separator = decoded.indexOf(':')
            if (separator !== -1) {
              const incomingUser = decoded.slice(0, separator)
              const incomingPassword = decoded.slice(separator + 1)
              if (incomingUser === username && incomingPassword === password) {
                return next()
              }
            }
          }
        } catch {
          // Ignore malformed auth header and fall through to 401.
        }
      }
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="Secure Area"',
      })
    }
  }
}

export function createShellApp(options: ShellAppOptions) {
  const app = new Hono()

  app.onError((error, c) => {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  })

  app.use(createAuthMiddleware(options.auth))
  app.use(
    cors({
      origin(input) {
        return allowOrigin(input)
      },
    }),
  )

  if (options.browserService) {
    app.route('/browser', options.browserService.app)
  } else {
    app.all('/browser', (c) => c.json({ ok: false, error: 'Browser control not enabled' }, 503))
    app.all('/browser/*', (c) => c.json({ ok: false, error: 'Browser control not enabled' }, 503))
  }

  app.route('/global', createGlobalRoutes({
    engineManager: options.engineManager,
    globalEvents: options.globalEvents,
  }))
  app.route('/preferences', createPreferencesRoutes(options.projectDir))
  app.route('/config', createShellConfigRoutes({
    browserService: options.browserService,
    configPath: options.configPath,
    engineManager: options.engineManager,
  }))
  app.route('/project', createProjectContextRoutes({
    engineManager: options.engineManager,
    globalEvents: options.globalEvents,
  }))

  app.all('*', async (c) => {
    try {
      const url = new URL(c.req.url)
      return await options.engineManager.proxy(`${url.pathname}${url.search}`, c.req.raw)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  return app
}
