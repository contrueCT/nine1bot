import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { Hono } from 'hono'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserServiceInstance } from '../../browser/service'
import type { EngineManager } from '../../engine'
import { readRawConfig } from '../../config/raw'
import { createShellConfigRoutes } from './config'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createEngineManager(applyRuntimeChange: EngineManager['applyRuntimeChange']): EngineManager {
  return {
    applyRuntimeChange,
  } as EngineManager
}

function createBrowserService(applyConfig: BrowserServiceInstance['applyConfig']): BrowserServiceInstance {
  return {
    url: 'http://browser-service.local',
    app: new Hono(),
    applyConfig,
    health: async () => true,
    stop: async () => {},
  }
}

async function createConfigFile(initial: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nine1bot-config-route-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'nine1bot.config.jsonc')
  await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8')
  return configPath
}

describe('createShellConfigRoutes', () => {
  test('rejects deprecated browser config before writing to disk', async () => {
    const configPath = await createConfigFile({ model: 'before' })
    let applyCalls = 0
    const app = createShellConfigRoutes({
      browserService: createBrowserService(async () => undefined),
      configPath,
      engineManager: createEngineManager(async () => {
        applyCalls++
        return { state: 'applied', effectiveAfterCurrentSession: false }
      }),
    })

    const response = await app.request('http://localhost/nine1bot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: {
          enabled: true,
          bridgePort: 18793,
        },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: expect.stringContaining('browser.bridgePort'),
    })
    expect(applyCalls).toBe(0)
    expect(await readRawConfig(configPath)).toEqual({ model: 'before' })
  })

  test('deep merges nested browser config updates before persisting', async () => {
    const configPath = await createConfigFile({
      browser: {
        cdpPort: 9333,
        autoLaunch: false,
        headless: true,
      },
      model: 'before',
    })
    const browserConfigs: Record<string, unknown>[] = []
    const app = createShellConfigRoutes({
      browserService: createBrowserService(async (config) => {
        browserConfigs.push(config)
      }),
      configPath,
      engineManager: createEngineManager(async () => ({
        state: 'applied',
        effectiveAfterCurrentSession: false,
      })),
    })

    const response = await app.request('http://localhost/nine1bot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: {
          enabled: true,
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      runtime: {
        state: 'applied',
        effectiveAfterCurrentSession: false,
      },
    })
    expect(browserConfigs).toEqual([
      {
        enabled: true,
        cdpPort: 9333,
        autoLaunch: false,
        headless: true,
      },
    ])
    expect(await readRawConfig(configPath)).toEqual({
      browser: {
        enabled: true,
        cdpPort: 9333,
        autoLaunch: false,
        headless: true,
      },
      model: 'before',
    })
  })

  test('restores the previous config when browser runtime apply fails', async () => {
    const configPath = await createConfigFile({
      browser: {
        enabled: false,
        cdpPort: 9333,
        autoLaunch: false,
        headless: false,
      },
      model: 'before',
    })
    let engineApplyCalls = 0
    const app = createShellConfigRoutes({
      browserService: createBrowserService(async (config) => {
        if (config.enabled) {
          throw new Error('browser apply failed')
        }
      }),
      configPath,
      engineManager: createEngineManager(async () => {
        engineApplyCalls++
        return { state: 'applied', effectiveAfterCurrentSession: false }
      }),
    })

    const response = await app.request('http://localhost/nine1bot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: {
          enabled: true,
        },
      }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'browser apply failed',
    })
    expect(engineApplyCalls).toBe(0)
    expect(await readRawConfig(configPath)).toEqual({
      browser: {
        enabled: false,
        cdpPort: 9333,
        autoLaunch: false,
        headless: false,
      },
      model: 'before',
    })
  })

  test('restores browser runtime and config when engine rebuild fails', async () => {
    const configPath = await createConfigFile({
      browser: {
        enabled: false,
        cdpPort: 9333,
        autoLaunch: false,
        headless: false,
      },
      model: 'before',
    })
    const browserConfigs: Record<string, unknown>[] = []
    const app = createShellConfigRoutes({
      browserService: createBrowserService(async (config) => {
        browserConfigs.push(config)
      }),
      configPath,
      engineManager: createEngineManager(async () => {
        throw new Error('engine rebuild failed')
      }),
    })

    const response = await app.request('http://localhost/nine1bot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: {
          enabled: true,
          headless: true,
        },
        model: 'after',
      }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'engine rebuild failed',
    })
    expect(browserConfigs).toEqual([
      {
        enabled: true,
        cdpPort: 9333,
        autoLaunch: false,
        headless: true,
      },
      {
        enabled: false,
        cdpPort: 9333,
        autoLaunch: false,
        headless: false,
      },
    ])
    expect(await readRawConfig(configPath)).toEqual({
      browser: {
        enabled: false,
        cdpPort: 9333,
        autoLaunch: false,
        headless: false,
      },
      model: 'before',
    })
  })
})
