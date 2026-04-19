import { readFile, unlink, writeFile } from 'fs/promises'
import { Hono } from 'hono'
import { BrowserConfigSchema } from '../../config/schema'
import type { EngineManager } from '../../engine'
import { validateConfig } from '../../config/loader'
import { readRawConfig, writeRawConfig } from '../../config/raw'
import type { BrowserServiceInstance } from '../../browser/service'

const CUSTOM_PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9-_]{1,63}$/

interface ConfigRoutesOptions {
  browserService?: BrowserServiceInstance
  configPath: string
  engineManager: EngineManager
}

function formatError(error: unknown): { message: string; status: 400 | 500 } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    message,
    status: message.startsWith('Invalid config:') ? 400 : 500,
  }
}

async function snapshotConfig(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function restoreConfig(path: string, snapshot: string | null): Promise<void> {
  if (snapshot === null) {
    await unlink(path).catch(() => undefined)
    return
  }
  await writeFile(path, snapshot, 'utf-8')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepMerge(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...base }

  for (const [key, value] of Object.entries(patch)) {
    const current = result[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value)
      continue
    }
    result[key] = value
  }

  return result
}

function normalizeBrowserConfig(config: Record<string, any>) {
  return BrowserConfigSchema.parse(config.browser ?? {})
}

async function rollbackConfigUpdate(
  options: ConfigRoutesOptions,
  previousSnapshot: string | null,
  previousBrowserConfig: ReturnType<typeof normalizeBrowserConfig>,
  originalError: unknown,
): Promise<never> {
  let rollbackError: unknown

  try {
    await restoreConfig(options.configPath, previousSnapshot)
  } catch (error) {
    rollbackError = error
  }

  if (options.browserService) {
    try {
      await options.browserService.applyConfig(previousBrowserConfig)
    } catch (error) {
      rollbackError ??= error
    }
  }

  if (!rollbackError) {
    throw originalError
  }

  const originalMessage = originalError instanceof Error ? originalError.message : String(originalError)
  const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
  throw new Error(`${originalMessage} (rollback failed: ${rollbackMessage})`)
}

async function persistConfigUpdate(
  options: ConfigRoutesOptions,
  nextConfig: Record<string, any>,
  reason: string,
) {
  validateConfig(nextConfig)
  const previousConfig = await readRawConfig(options.configPath)
  const previous = await snapshotConfig(options.configPath)
  const previousBrowserConfig = normalizeBrowserConfig(previousConfig)
  const nextBrowserConfig = normalizeBrowserConfig(nextConfig)
  await writeRawConfig(options.configPath, nextConfig)

  try {
    if (options.browserService) {
      await options.browserService.applyConfig(nextBrowserConfig)
    }
    return await options.engineManager.applyRuntimeChange(reason)
  } catch (error) {
    await rollbackConfigUpdate(options, previous, previousBrowserConfig, error)
  }
}

export function createShellConfigRoutes(options: ConfigRoutesOptions) {
  return new Hono()
    .get('/nine1bot', async (c) => {
      const config = await readRawConfig(options.configPath)
      return c.json({
        model: config.model,
        small_model: config.small_model,
        customProviders: config.customProviders || {},
        configPath: options.configPath,
      })
    })
    .patch('/nine1bot', async (c) => {
      try {
        const body = await c.req.json().catch(() => ({})) as Record<string, any>
        const existing = await readRawConfig(options.configPath)
        const merged = deepMerge(existing, body)
        const runtime = await persistConfigUpdate(options, merged, 'config/nine1bot')
        return c.json({ success: true, runtime })
      } catch (error) {
        const failure = formatError(error)
        return c.json({ error: failure.message }, failure.status)
      }
    })
    .get('/nine1bot/custom-providers', async (c) => {
      const config = await readRawConfig(options.configPath)
      return c.json(config.customProviders || {})
    })
    .put('/nine1bot/custom-providers/:id', async (c) => {
      const { id } = c.req.param()
      if (!CUSTOM_PROVIDER_ID_REGEX.test(id)) {
        return c.json({ error: 'Invalid provider id' }, 400)
      }

      const provider = await c.req.json().catch(() => undefined)
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        return c.json({ error: 'Invalid custom provider payload' }, 400)
      }

      try {
        const existing = await readRawConfig(options.configPath)
        const customProviders = {
          ...(existing.customProviders || {}),
          [id]: provider,
        }
        const runtime = await persistConfigUpdate(options, {
          ...existing,
          customProviders,
        }, `custom-provider:${id}`)
        return c.json({ success: true, runtime })
      } catch (error) {
        const failure = formatError(error)
        return c.json({ error: failure.message }, failure.status)
      }
    })
    .delete('/nine1bot/custom-providers/:id', async (c) => {
      try {
        const { id } = c.req.param()
        const existing = await readRawConfig(options.configPath)
        const customProviders = { ...(existing.customProviders || {}) }
        delete customProviders[id]
        const runtime = await persistConfigUpdate(options, {
          ...existing,
          customProviders,
        }, `custom-provider:${id}:delete`)
        return c.json({ success: true, runtime })
      } catch (error) {
        const failure = formatError(error)
        return c.json({ error: failure.message }, failure.status)
      }
    })
}
