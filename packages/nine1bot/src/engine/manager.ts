import { writeFile } from 'fs/promises'
import { loadConfig } from '../config/loader'
import type { Nine1BotConfig } from '../config/schema'
import type { EngineAdapter, EngineContext, EngineHandle, PreparedRuntime, RuntimeApplyResult } from './types'
import { cleanupPreparedRuntime } from './opencode-runtime'

export class EngineManager {
  private currentConfig?: Nine1BotConfig
  private currentPrepared?: PreparedRuntime
  private currentHandle?: EngineHandle
  private pendingReason?: string
  private pendingWatcher?: ReturnType<typeof setInterval>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly adapter: EngineAdapter,
    private readonly context: EngineContext,
  ) {}

  async start(config: Nine1BotConfig): Promise<EngineHandle> {
    return this.runExclusive(async () => {
      this.currentConfig = config
      const prepared = await this.adapter.prepare(config, this.context)
      try {
        const handle = await this.adapter.start(prepared)
        this.currentPrepared = prepared
        this.currentHandle = handle
        return handle
      } catch (error) {
        await cleanupPreparedRuntime(prepared)
        throw error
      }
    })
  }

  async stop(): Promise<void> {
    await this.runExclusive(async () => {
      this.clearPendingRebuild()
      const handle = this.currentHandle
      const prepared = this.currentPrepared
      this.currentHandle = undefined
      this.currentPrepared = undefined

      try {
        if (handle) {
          await handle.stop()
        }
      } finally {
        await cleanupPreparedRuntime(prepared)
      }
    })
  }

  currentBaseUrl(): string {
    if (!this.currentHandle) {
      throw new Error('Engine is not started')
    }
    return this.currentHandle.baseUrl
  }

  async health(): Promise<boolean> {
    if (!this.currentHandle) {
      return false
    }
    return this.currentHandle.health()
  }

  async proxy(path: string, request: Request): Promise<Response> {
    const baseUrl = this.currentBaseUrl()
    const headers = new Headers(request.headers)
    headers.delete('host')

    return fetch(`${baseUrl}${path}`, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      // @ts-expect-error Bun accepts duplex when needed and ignores it otherwise.
      duplex: 'half',
    })
  }

  async applyRuntimeChange(reason: string): Promise<RuntimeApplyResult> {
    return this.runExclusive(async () => {
      const config = await loadConfig(this.context.configPath)
      this.currentConfig = config

      const { prepared, requiresRestart } = await this.adapter.rebuildRuntime(
        reason,
        config,
        this.context,
        this.currentPrepared,
      )

      if (!requiresRestart) {
        this.clearPendingRebuild()
        await this.applyPreparedRuntime(prepared)
        return {
          state: 'applied',
          effectiveAfterCurrentSession: false,
        }
      }

      if (await this.hasActiveSessions()) {
        this.pendingReason = reason
        this.ensurePendingWatcher()
        await cleanupPreparedRuntime(prepared)
        return {
          state: 'pending-rebuild',
          effectiveAfterCurrentSession: true,
        }
      }

      await this.restart(prepared)
      this.clearPendingRebuild()
      return {
        state: 'applied',
        effectiveAfterCurrentSession: false,
      }
    })
  }

  private ensurePendingWatcher() {
    if (this.pendingWatcher) return

    this.pendingWatcher = setInterval(() => {
      void this.runExclusive(async () => {
        if (!this.pendingReason) return
        if (await this.hasActiveSessions()) return

        const reason = this.pendingReason
        try {
          const config = await loadConfig(this.context.configPath)
          this.currentConfig = config

          const { prepared, requiresRestart } = await this.adapter.rebuildRuntime(
            reason,
            config,
            this.context,
            this.currentPrepared,
          )

          if (requiresRestart) {
            await this.restart(prepared)
          } else {
            await this.applyPreparedRuntime(prepared)
          }
          this.clearPendingRebuild()
        } catch (error) {
          console.warn(
            `[Nine1Bot] Pending runtime update failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
    }, 1000)
  }

  private clearPendingRebuild() {
    if (this.pendingWatcher) {
      clearInterval(this.pendingWatcher)
      this.pendingWatcher = undefined
    }
    this.pendingReason = undefined
  }

  private async applyPreparedRuntime(prepared: PreparedRuntime) {
    const currentPrepared = this.currentPrepared
    const currentHandle = this.currentHandle
    if (!currentPrepared || !currentHandle) {
      await cleanupPreparedRuntime(prepared)
      throw new Error('Engine is not started')
    }

    if (prepared.runtimeConfigText === currentPrepared.runtimeConfigText) {
      await cleanupPreparedRuntime(prepared)
      return
    }

    const runtimeConfigPath = currentPrepared.artifactPaths.configPath
    const previousRuntimeConfigText = currentPrepared.runtimeConfigText
    try {
      await writeFile(runtimeConfigPath, prepared.runtimeConfigText, 'utf-8')
    } catch (error) {
      await cleanupPreparedRuntime(prepared)
      throw error
    }

    try {
      await this.reloadRuntimeState(currentHandle.baseUrl)
      this.currentPrepared = {
        ...currentPrepared,
        runtimeConfig: prepared.runtimeConfig,
        runtimeConfigText: prepared.runtimeConfigText,
      }
      await cleanupPreparedRuntime(prepared)
    } catch (error) {
      let rollbackError: unknown
      try {
        await writeFile(runtimeConfigPath, previousRuntimeConfigText, 'utf-8')
        await this.reloadRuntimeState(currentHandle.baseUrl)
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure
      }
      await cleanupPreparedRuntime(prepared)
      this.currentPrepared = currentPrepared
      if (rollbackError) {
        const originalMessage = error instanceof Error ? error.message : String(error)
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`${originalMessage} (runtime rollback failed: ${rollbackMessage})`)
      }
      throw error
    }
  }

  private async reloadRuntimeState(baseUrl: string) {
    const response = await fetch(`${baseUrl}/config/runtime/reload`, {
      method: 'POST',
    })
    if (response.ok) return

    const message = await response.text().catch(() => '')
    throw new Error(message || `Runtime reload failed with status ${response.status}`)
  }

  private async restart(prepared: PreparedRuntime) {
    const previousHandle = this.currentHandle
    const previousPrepared = this.currentPrepared
    const requiresStopFirst = previousPrepared?.startSpec.type === 'in-process' || prepared.startSpec.type === 'in-process'

    if (requiresStopFirst && previousHandle) {
      try {
        await previousHandle.stop()
        this.currentHandle = undefined
      } catch (error) {
        await cleanupPreparedRuntime(prepared)
        throw error
      }
    }

    let nextHandle: EngineHandle
    try {
      nextHandle = await this.adapter.start(prepared)
    } catch (error) {
      await cleanupPreparedRuntime(prepared)
      if (requiresStopFirst && previousPrepared) {
        try {
          this.currentHandle = await this.adapter.start(previousPrepared)
          this.currentPrepared = previousPrepared
        } catch (rollbackError) {
          this.currentHandle = undefined
          this.currentPrepared = previousPrepared
          const originalMessage = error instanceof Error ? error.message : String(error)
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          throw new Error(`${originalMessage} (restart rollback failed: ${rollbackMessage})`)
        }
      }
      throw error
    }

    this.currentHandle = nextHandle
    this.currentPrepared = prepared
    let previousStopped = requiresStopFirst

    if (!requiresStopFirst && previousHandle) {
      try {
        await previousHandle.stop()
        previousStopped = true
      } catch (error) {
        console.warn(
          `[Nine1Bot] Previous engine did not stop cleanly after restart: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (previousStopped) {
      await cleanupPreparedRuntime(previousPrepared)
    }
  }

  private async hasActiveSessions(): Promise<boolean> {
    if (!this.currentHandle) return false
    try {
      const response = await fetch(`${this.currentHandle.baseUrl}/session/status`)
      if (!response.ok) return false
      const data = await response.json() as Record<string, { type?: string }>
      return Object.values(data).some((status) => status.type === 'busy' || status.type === 'retry')
    } catch {
      return false
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}
