import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from './loader'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function writeConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nine1bot-config-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'nine1bot.config.jsonc')
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return configPath
}

describe('loadConfig browser migration guards', () => {
  it('rejects deprecated mcp.browser config', async () => {
    const configPath = await writeConfig({
      browser: { enabled: true },
      mcp: {
        browser: {
          type: 'local',
          enabled: true,
        },
      },
    })

    await expect(loadConfig(configPath)).rejects.toThrow('mcp.browser')
  })

  it('rejects deprecated browser.bridgePort config', async () => {
    const configPath = await writeConfig({
      browser: {
        enabled: true,
        bridgePort: 18793,
      },
    })

    await expect(loadConfig(configPath)).rejects.toThrow('browser.bridgePort')
  })
})
