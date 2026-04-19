import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BrowserConfigSchema } from '../config/schema'
import { clearBridgeServer, getBridgeServer } from '../../../../opencode/packages/opencode/src/browser/bridge'
import { startBrowserService, type BrowserServiceInstance } from './service'

const services: BrowserServiceInstance[] = []
let originalBrowserServiceUrl: string | undefined

beforeEach(() => {
  originalBrowserServiceUrl = process.env.BROWSER_SERVICE_URL
  delete process.env.BROWSER_SERVICE_URL
  clearBridgeServer()
})

afterEach(async () => {
  while (services.length > 0) {
    const service = services.pop()
    await service?.stop()
  }
  clearBridgeServer()
  if (originalBrowserServiceUrl === undefined) {
    delete process.env.BROWSER_SERVICE_URL
  } else {
    process.env.BROWSER_SERVICE_URL = originalBrowserServiceUrl
  }
})

describe('startBrowserService', () => {
  test('keeps a stable url and app while toggling browser availability', async () => {
    const service = await startBrowserService(BrowserConfigSchema.parse({ enabled: false }))
    services.push(service)

    const initialUrl = service.url
    const initialApp = service.app

    expect((await fetch(`${service.url}/status`)).status).toBe(503)
    expect(getBridgeServer()).toBeNull()

    await service.applyConfig(BrowserConfigSchema.parse({
      enabled: true,
      cdpPort: 9333,
      autoLaunch: false,
      headless: true,
    }))

    expect(service.url).toBe(initialUrl)
    expect(service.app).toBe(initialApp)
    expect((await fetch(`${service.url}/status`)).status).toBe(200)
    expect((getBridgeServer() as any)?.options).toEqual({
      cdpPort: 9333,
      autoLaunch: false,
      headless: true,
    })

    await service.applyConfig(BrowserConfigSchema.parse({ enabled: false }))

    expect(service.url).toBe(initialUrl)
    expect(service.app).toBe(initialApp)
    expect((await fetch(`${service.url}/status`)).status).toBe(503)
    expect(getBridgeServer()).toBeNull()
  })

  test('reconfigures the active bridge in place and stops managed chrome when needed', async () => {
    const service = await startBrowserService(BrowserConfigSchema.parse({
      enabled: true,
      cdpPort: 9222,
      autoLaunch: true,
      headless: false,
    }))
    services.push(service)

    const bridge = getBridgeServer() as any
    let stopped = false
    bridge.chromeInstance = {
      stop: async () => {
        stopped = true
      },
    }

    await service.applyConfig(BrowserConfigSchema.parse({
      enabled: true,
      cdpPort: 9444,
      autoLaunch: false,
      headless: true,
    }))

    expect(getBridgeServer()).toBe(bridge)
    expect(stopped).toBe(true)
    expect(bridge.chromeInstance).toBeNull()
    expect(bridge.options).toEqual({
      cdpPort: 9444,
      autoLaunch: false,
      headless: true,
    })
  })
})
