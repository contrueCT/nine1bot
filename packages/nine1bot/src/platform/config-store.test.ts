import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
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
})
