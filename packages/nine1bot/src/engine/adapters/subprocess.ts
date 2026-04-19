import { spawn, type ChildProcess } from 'child_process'
import type { EngineAdapter, EngineContext, EngineHandle, PreparedRuntime } from '../types'
import { loadEngineManifest } from '../manifest'
import { prepareOpencodeRuntime } from '../opencode-runtime'
import type { Nine1BotConfig } from '../../config/schema'

async function healthCheck(baseUrl: string, healthEndpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${healthEndpoint}`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(baseUrl: string, healthEndpoint: string, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await healthCheck(baseUrl, healthEndpoint)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Engine did not become healthy within ${timeoutMs}ms`)
}

function attachProcessLogging(proc: ChildProcess) {
  proc.stdout?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[engine] ${text}`)
  })
  proc.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.error(`[engine] ${text}`)
  })
}

async function stopProcess(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null) return

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }, timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}

export class SubprocessOpencodeAdapter implements EngineAdapter {
  readonly name = 'opencode-subprocess'

  async prepare(config: Nine1BotConfig, context: EngineContext): Promise<PreparedRuntime> {
    const manifest = await loadEngineManifest()
    return prepareOpencodeRuntime(config, context, manifest, 'subprocess')
  }

  async start(prepared: PreparedRuntime): Promise<EngineHandle> {
    const command = prepared.startSpec.command
    if (!command || command.length === 0) {
      throw new Error('Missing subprocess command for engine start')
    }

    const [bin, ...args] = command
    const proc = spawn(bin, args, {
      cwd: prepared.startSpec.cwd,
      env: {
        ...process.env,
        ...prepared.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    attachProcessLogging(proc)

    const baseUrl = `http://${prepared.startSpec.host}:${prepared.startSpec.port}`
    try {
      await waitForHealth(baseUrl, prepared.startSpec.healthEndpoint)
    } catch (error) {
      await stopProcess(proc)
      throw error
    }

    let stopped = false
    return {
      baseUrl,
      health: () => healthCheck(baseUrl, prepared.startSpec.healthEndpoint),
      stop: async () => {
        if (stopped) return
        stopped = true
        await stopProcess(proc)
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
