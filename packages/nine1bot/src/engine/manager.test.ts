import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { EngineManager } from './manager'
import type { EngineAdapter, EngineContext, EngineHandle, PreparedRuntime } from './types'
import { Nine1BotConfigSchema } from '../config/schema'

class FakeAdapter implements EngineAdapter {
  readonly name = 'fake'
  startCalls = 0
  stopCalls = 0
  rebuildCalls = 0
  startedFingerprints: string[] = []
  createdRuntimeDirs: string[] = []
  lastRebuildRuntimeDir?: string
  nextRequiresRestart = false
  nextFingerprint = 'initial'
  nextRuntimeConfig: Record<string, unknown> = { label: 'initial' }
  mode: 'subprocess' | 'in-process' = 'subprocess'
  failStartCount = 0
  private runtimeCounter = 0

  constructor(private readonly rootDir: string) {}

  async prepare(_config: any, _context: EngineContext) {
    return this.createPrepared('initial', { label: 'initial' }, this.mode)
  }

  async start(prepared: PreparedRuntime): Promise<EngineHandle> {
    this.startCalls++
    if (this.failStartCount > 0) {
      this.failStartCount--
      throw new Error('start failed')
    }

    this.startedFingerprints.push(prepared.restartFingerprint)
    let stopped = false
    return {
      baseUrl: `http://engine-${this.startCalls}.local`,
      health: async () => !stopped,
      stop: async () => {
        if (stopped) return
        stopped = true
        this.stopCalls++
      },
    }
  }

  async rebuildRuntime(
    _reason: string,
    _config: any,
    _context: EngineContext,
    _currentPrepared?: PreparedRuntime,
  ) {
    this.rebuildCalls++
    const prepared = await this.createPrepared(this.nextFingerprint, this.nextRuntimeConfig, this.mode)
    this.lastRebuildRuntimeDir = prepared.runtimeDir
    return {
      prepared,
      requiresRestart: this.nextRequiresRestart,
    }
  }

  private async createPrepared(
    fingerprint: string,
    runtimeConfig: Record<string, unknown>,
    mode: 'subprocess' | 'in-process',
  ): Promise<PreparedRuntime> {
    this.runtimeCounter++
    const runtimeDir = join(this.rootDir, `runtime-${this.runtimeCounter}`)
    await mkdir(runtimeDir, { recursive: true })
    const configPath = join(runtimeDir, 'opencode.config.json')
    const runtimeConfigText = JSON.stringify(runtimeConfig, null, 2)
    await writeFile(configPath, runtimeConfigText, 'utf-8')
    this.createdRuntimeDirs.push(runtimeDir)
    return {
      runtimeDir,
      env: {
        OPENCODE_CONFIG: configPath,
      },
      artifactPaths: {
        configPath,
        runtimeDir,
      },
      startSpec: {
        type: mode,
        host: '127.0.0.1',
        port: this.runtimeCounter,
        healthEndpoint: '/global/health',
      },
      runtimeConfig,
      runtimeConfigText,
      restartFingerprint: fingerprint,
    }
  }
}

describe('EngineManager', () => {
  let adapter: FakeAdapter
  let manager: EngineManager
  let tempDir: string
  let configPath: string
  let originalFetch: typeof fetch
  let activeSessions = false
  let runtimeReloadCalls = 0

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nine1bot-engine-manager-'))
    await mkdir(tempDir, { recursive: true })
    configPath = join(tempDir, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf-8')

    adapter = new FakeAdapter(tempDir)
    manager = new EngineManager(adapter, {
      configPath,
      installDir: tempDir,
      projectDir: tempDir,
    })

    originalFetch = globalThis.fetch
    activeSessions = false
    runtimeReloadCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/session/status')) {
        return new Response(JSON.stringify(activeSessions ? { a: { type: 'busy' } } : { a: { type: 'idle' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ healthy: true }), { status: 200 })
      }
      if (url.endsWith('/config/runtime/reload')) {
        runtimeReloadCalls++
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await manager.stop()
    await rm(tempDir, { recursive: true, force: true })
  })

  test('applies no-restart updates through runtime reload and cleans the staged runtime dir', async () => {
    const config = Nine1BotConfigSchema.parse({})
    await manager.start(config)

    const currentRuntimeDir = adapter.createdRuntimeDirs[0]
    const currentRuntimeConfigPath = join(currentRuntimeDir, 'opencode.config.json')

    adapter.nextRequiresRestart = false
    adapter.nextFingerprint = 'same-runtime'
    adapter.nextRuntimeConfig = { label: 'updated' }

    const result = await manager.applyRuntimeChange('no-restart')

    expect(result).toEqual({
      state: 'applied',
      effectiveAfterCurrentSession: false,
    })
    expect(adapter.startCalls).toBe(1)
    expect(adapter.stopCalls).toBe(0)
    expect(runtimeReloadCalls).toBe(1)
    expect(await readFile(currentRuntimeConfigPath, 'utf-8')).toContain('"updated"')
    expect(adapter.lastRebuildRuntimeDir).toBeDefined()
    expect(await Bun.file(join(adapter.lastRebuildRuntimeDir!, 'opencode.config.json')).exists()).toBe(false)
    expect(await Bun.file(currentRuntimeConfigPath).exists()).toBe(true)
  })

  test('rebuilds fresh after busy sessions finish instead of reusing a stale prepared runtime', async () => {
    const config = Nine1BotConfigSchema.parse({})
    await manager.start(config)

    activeSessions = true
    adapter.nextRequiresRestart = true
    adapter.nextFingerprint = 'stale'
    adapter.nextRuntimeConfig = { label: 'stale' }

    const result = await manager.applyRuntimeChange('delayed-restart')

    expect(result).toEqual({
      state: 'pending-rebuild',
      effectiveAfterCurrentSession: true,
    })
    const staleRuntimeDir = adapter.lastRebuildRuntimeDir
    expect(staleRuntimeDir).toBeDefined()
    expect(await Bun.file(join(staleRuntimeDir!, 'opencode.config.json')).exists()).toBe(false)
    expect(adapter.startCalls).toBe(1)
    expect(adapter.rebuildCalls).toBe(1)

    adapter.nextFingerprint = 'fresh'
    adapter.nextRuntimeConfig = { label: 'fresh' }
    activeSessions = false
    await Bun.sleep(1200)

    expect(adapter.rebuildCalls).toBe(2)
    expect(adapter.startedFingerprints).toEqual(['initial', 'fresh'])
    expect(adapter.startCalls).toBe(2)
    expect(adapter.stopCalls).toBe(1)
  })

  test('cleans the prepared runtime dir when initial engine start fails', async () => {
    adapter.failStartCount = 1
    const config = Nine1BotConfigSchema.parse({})

    await expect(manager.start(config)).rejects.toThrow('start failed')

    const failedRuntimeDir = adapter.createdRuntimeDirs[0]
    expect(await Bun.file(join(failedRuntimeDir, 'opencode.config.json')).exists()).toBe(false)
    expect(adapter.startCalls).toBe(1)
  })

  test('rolls back to the previous in-process runtime when restart start-up fails', async () => {
    adapter.mode = 'in-process'
    const config = Nine1BotConfigSchema.parse({})
    await manager.start(config)

    const originalRuntimeDir = adapter.createdRuntimeDirs[0]
    adapter.nextRequiresRestart = true
    adapter.nextFingerprint = 'broken-next'
    adapter.nextRuntimeConfig = { label: 'broken-next' }
    adapter.failStartCount = 1

    await expect(manager.applyRuntimeChange('restart-failure')).rejects.toThrow('start failed')

    expect(adapter.startCalls).toBe(3)
    expect(adapter.stopCalls).toBe(1)
    expect(adapter.startedFingerprints).toEqual(['initial', 'initial'])
    expect(await Bun.file(join(originalRuntimeDir, 'opencode.config.json')).exists()).toBe(true)
    expect(adapter.lastRebuildRuntimeDir).toBeDefined()
    expect(await Bun.file(join(adapter.lastRebuildRuntimeDir!, 'opencode.config.json')).exists()).toBe(false)
    expect(await manager.health()).toBe(true)
  })
})
