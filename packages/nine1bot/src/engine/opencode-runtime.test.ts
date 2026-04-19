import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMcpAuthPath } from '../config/loader'
import { Nine1BotConfigSchema } from '../config/schema'
import { prepareOpencodeRuntime } from './opencode-runtime'
import type { EngineContext, EngineManifest } from './types'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('prepareOpencodeRuntime', () => {
  test('passes NINE1BOT_MCP_AUTH_PATH into the engine environment', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'nine1bot-opencode-runtime-'))
    tempDirs.push(installDir)

    const configPath = join(installDir, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf-8')

    const manifest: EngineManifest = {
      engineId: 'opencode',
      engineVersion: 'test',
      mode: 'local-source',
      entry: {
        command: 'bun',
        args: ['run', 'serve', '--port', '{port}', '--hostname', '{host}'],
      },
      healthEndpoint: '/global/health',
      defaultPortStrategy: 'ephemeral',
      runtimeLayoutVersion: 1,
    }

    const context: EngineContext = {
      configPath,
      installDir,
      projectDir: installDir,
    }

    const prepared = await prepareOpencodeRuntime(
      Nine1BotConfigSchema.parse({}),
      context,
      manifest,
      'subprocess',
    )
    tempDirs.push(prepared.runtimeDir)

    expect(prepared.env.NINE1BOT_MCP_AUTH_PATH).toBe(getMcpAuthPath())
  })

  test('keeps restart fingerprints stable across prepares and filters feishu from the runtime config', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'nine1bot-opencode-runtime-'))
    tempDirs.push(installDir)

    const configPath = join(installDir, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf-8')

    const manifest: EngineManifest = {
      engineId: 'opencode',
      engineVersion: 'test',
      mode: 'local-source',
      entry: {
        command: 'bun',
        args: ['run', 'serve', '--port', '{port}', '--hostname', '{host}'],
      },
      healthEndpoint: '/global/health',
      defaultPortStrategy: 'ephemeral',
      runtimeLayoutVersion: 1,
    }

    const context: EngineContext = {
      configPath,
      installDir,
      projectDir: installDir,
    }

    const config = Nine1BotConfigSchema.parse({})
    const first = await prepareOpencodeRuntime(config, context, manifest, 'in-process')
    const second = await prepareOpencodeRuntime(config, context, manifest, 'in-process')
    tempDirs.push(first.runtimeDir, second.runtimeDir)

    expect(first.restartFingerprint).toBe(second.restartFingerprint)

    const runtimeConfig = JSON.parse(await readFile(first.artifactPaths.configPath, 'utf-8')) as Record<string, unknown>
    expect(runtimeConfig.feishu).toBeUndefined()
  })

  test('only changes the restart fingerprint for restart-sensitive config fields', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'nine1bot-opencode-runtime-'))
    tempDirs.push(installDir)

    const configPath = join(installDir, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf-8')

    const manifest: EngineManifest = {
      engineId: 'opencode',
      engineVersion: 'test',
      mode: 'local-source',
      entry: {
        command: 'bun',
        args: ['run', 'serve', '--port', '{port}', '--hostname', '{host}'],
      },
      healthEndpoint: '/global/health',
      defaultPortStrategy: 'ephemeral',
      runtimeLayoutVersion: 1,
    }

    const context: EngineContext = {
      configPath,
      installDir,
      projectDir: installDir,
    }

    const baseConfig = Nine1BotConfigSchema.parse({
      model: 'openai/gpt-5',
      provider: {
        openai: {
          options: {
            apiKey: 'before',
          },
        },
      },
      mcp: {
        test: {
          type: 'local',
          command: ['node', 'server.js'],
        },
      },
    })
    const hotReloadConfig = Nine1BotConfigSchema.parse({
      ...baseConfig,
      model: 'anthropic/claude-sonnet-4-5',
      provider: {
        openai: {
          options: {
            apiKey: 'after',
          },
        },
      },
      mcp: {
        test: {
          type: 'local',
          command: ['node', 'next-server.js'],
        },
      },
    })
    const restartConfig = Nine1BotConfigSchema.parse({
      ...baseConfig,
      permission: {
        bash: 'deny',
      },
    })

    const basePrepared = await prepareOpencodeRuntime(baseConfig, context, manifest, 'in-process')
    const hotReloadPrepared = await prepareOpencodeRuntime(hotReloadConfig, context, manifest, 'in-process')
    const restartPrepared = await prepareOpencodeRuntime(restartConfig, context, manifest, 'in-process')
    tempDirs.push(basePrepared.runtimeDir, hotReloadPrepared.runtimeDir, restartPrepared.runtimeDir)

    expect(hotReloadPrepared.restartFingerprint).toBe(basePrepared.restartFingerprint)
    expect(restartPrepared.restartFingerprint).not.toBe(basePrepared.restartFingerprint)
  })
})
