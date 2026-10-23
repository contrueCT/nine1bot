import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig, loadConfigDocument } from '../config/loader'
import {
  readPlatformManagerConfig,
  writePlatformManagerConfig,
} from './config-store'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempConfig(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'nine1bot-platform-config-'))
  tempDirs.push(dir)
  const path = join(dir, 'nine1bot.config.jsonc')
  await writeFile(path, content, 'utf-8')
  return path
}

describe('platform config store', () => {
  it('preserves JSONC comments when updating only platforms', async () => {
    const configPath = await tempConfig(`{
  // keep provider comments
  "model": "openai/gpt-5",
  /* keep platform comments */
  "platforms": {
    "gitlab": {
      "enabled": true
    }
  },
  "mcp": {
    "docs": {
      "type": "local",
      "command": ["node", "server.js"]
    }
  }
}
`)

    await writePlatformManagerConfig({
      gitlab: {
        enabled: false,
        features: {
          pageContext: true,
        },
        settings: {
          allowedHosts: ['gitlab.com'],
        },
      },
    }, configPath)

    const updated = await readFile(configPath, 'utf-8')
    expect(updated).toContain('// keep provider comments')
    expect(updated).toContain('/* keep platform comments */')
    expect(updated).toContain('"model": "openai/gpt-5"')
    expect(updated).toContain('"mcp"')
    await expect(readPlatformManagerConfig(configPath)).resolves.toEqual({
      gitlab: {
        enabled: false,
        features: {
          pageContext: true,
        },
        settings: {
          allowedHosts: ['gitlab.com'],
        },
      },
    })
  })

  it('adds platforms to an existing JSONC document without rewriting other fields', async () => {
    const configPath = await tempConfig(`{
  // comment before model
  "model": "openai/gpt-5"
}
`)

    await writePlatformManagerConfig({
      gitlab: {
        enabled: true,
      },
    }, configPath)

    const updated = await readFile(configPath, 'utf-8')
    expect(updated).toContain('// comment before model')
    expect(updated).toContain('"model": "openai/gpt-5"')
    expect(updated).toContain('"platforms"')
    await expect(readPlatformManagerConfig(configPath)).resolves.toEqual({
      gitlab: {
        enabled: true,
        features: {},
        settings: {},
      },
    })
  })

  it('merges global platforms with project overrides and expands environment values', async () => {
    const globalConfigPath = await tempConfig(JSON.stringify({ platforms: {
      feishu: { enabled: false, settings: { appId: 'inherited-app', endpoint: '{env:NINE1BOT_PLATFORM_TEST_ENDPOINT}' } },
      gitlab: { enabled: false },
    } }))
    const configPath = await tempConfig(JSON.stringify({ platforms: { feishu: { features: { pageContext: true } } } }))
    const old = process.env.NINE1BOT_PLATFORM_TEST_ENDPOINT
    process.env.NINE1BOT_PLATFORM_TEST_ENDPOINT = 'https://example.invalid'
    try {
      const config = await readPlatformManagerConfig(configPath, { globalConfigPath })
      expect(config.feishu).toEqual({ enabled: false, features: { pageContext: true }, settings: { appId: 'inherited-app', endpoint: 'https://example.invalid' } })
      expect(config.gitlab?.enabled).toBe(false)
      await writeFile(configPath, JSON.stringify({ isolation: { disableGlobalConfig: true } }))
      expect(await readPlatformManagerConfig(configPath, { globalConfigPath })).toEqual({})
    } finally {
      if (old === undefined) delete process.env.NINE1BOT_PLATFORM_TEST_ENDPOINT
      else process.env.NINE1BOT_PLATFORM_TEST_ENDPOINT = old
    }
  })

  it('persists only changed effective fields and keeps source expressions and inherited values', async () => {
    const globalConfigPath = await tempConfig(JSON.stringify({ platforms: {
      feishu: { enabled: false, settings: { appId: 'inherited-app' } },
    } }))
    const configPath = await tempConfig(`{
      // retain this source expression
      "platforms": { "feishu": { "settings": { "endpoint": "{env:NINE1BOT_MISSING_ENDPOINT:https://example.invalid}" } } }
    }`)
    const before = await readPlatformManagerConfig(configPath, { globalConfigPath })
    const after = structuredClone(before)
    after.feishu!.enabled = true
    await writePlatformManagerConfig(after, configPath, before)
    const source = await readFile(configPath, 'utf8')
    expect(source).toContain('// retain this source expression')
    expect(source).toContain('{env:NINE1BOT_MISSING_ENDPOINT:https://example.invalid}')
    expect(source).not.toContain('inherited-app')
    expect((await readPlatformManagerConfig(configPath, { globalConfigPath })).feishu).toEqual({ ...before.feishu, enabled: true })
  })

  it('masks a removed inherited setting across reload without changing the global file', async () => {
    const globalSource = JSON.stringify({ platforms: { feishu: { enabled: false, settings: { appSecret: { provider: 'env', key: 'TEST_SECRET' }, appId: 'keep' } } } })
    const globalConfigPath = await tempConfig(globalSource)
    const configPath = await tempConfig('{}')
    const before = await readPlatformManagerConfig(configPath, { globalConfigPath })
    const after = structuredClone(before)
    delete after.feishu!.settings!.appSecret
    await writePlatformManagerConfig(after, configPath, before)
    const reloaded = await readPlatformManagerConfig(configPath, { globalConfigPath })
    expect(reloaded.feishu?.settings).toEqual({ appId: 'keep' })
    const effective = await loadConfigDocument(configPath, undefined, { globalConfigPath })
    expect(effective.platforms?.feishu?.settings).toEqual({ appId: 'keep' })
    const startup = await loadConfig(configPath, { ...effective, isolation: { disableGlobalConfig: true } })
    expect(startup.platforms.feishu?.settings).toEqual({ appId: 'keep' })
    expect(await readFile(globalConfigPath, 'utf8')).toBe(globalSource)
    expect(await readFile(configPath, 'utf8')).toContain('null')
  })

  it('rejects a broken inherited source instead of restoring platform defaults', async () => {
    const configPath = await tempConfig('{}')
    const globalConfigPath = await tempConfig('{ invalid json')
    await expect(readPlatformManagerConfig(configPath, { globalConfigPath })).rejects.toThrow('Invalid JSON')
  })
})
