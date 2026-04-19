import { Server as OpencodeServer } from '../../../../../opencode/packages/opencode/src/server/server'
import type { EngineAdapter, EngineContext, EngineHandle, PreparedRuntime } from '../types'
import { loadEngineManifest } from '../manifest'
import { prepareOpencodeRuntime } from '../opencode-runtime'
import type { Nine1BotConfig } from '../../config/schema'

function applyEnv(env: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function healthCheck(baseUrl: string, healthEndpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${healthEndpoint}`)
    return response.ok
  } catch {
    return false
  }
}

export class InProcessOpencodeAdapter implements EngineAdapter {
  readonly name = 'opencode-in-process'

  async prepare(config: Nine1BotConfig, context: EngineContext): Promise<PreparedRuntime> {
    const manifest = await loadEngineManifest()
    return prepareOpencodeRuntime(config, context, manifest, 'in-process')
  }

  async start(prepared: PreparedRuntime): Promise<EngineHandle> {
    const restoreEnv = applyEnv(prepared.env)
    let server: Awaited<ReturnType<typeof OpencodeServer.listen>>
    try {
      server = await OpencodeServer.listen({
        port: prepared.startSpec.port,
        hostname: prepared.startSpec.host,
        cors: [],
      })
    } catch (error) {
      restoreEnv()
      throw error
    }
    const baseUrl = server.url.toString().replace(/\/$/, '')

    let stopped = false
    return {
      baseUrl,
      health: () => healthCheck(baseUrl, prepared.startSpec.healthEndpoint),
      stop: async () => {
        if (stopped) return
        stopped = true
        try {
          await server.stop(true)
        } finally {
          restoreEnv()
        }
      },
    }
  }

  async rebuildRuntime(
    _reason: string,
    config: Nine1BotConfig,
    context: EngineContext,
    currentPrepared?: PreparedRuntime,
  ) {
    const prepared = await this.prepare(config, context)
    return {
      prepared,
      requiresRestart: prepared.restartFingerprint !== currentPrepared?.restartFingerprint,
    }
  }
}
