import { gitlabPlatformContribution } from '@nine1bot/platform-gitlab/runtime'
import type { PlatformSecretAccess } from '@nine1bot/platform-protocol'
import { PlatformAdapterManager, type PlatformManagerConfig } from './manager'

export const builtinPlatformContributions = [
  gitlabPlatformContribution,
]

let builtinPlatformManager: PlatformAdapterManager | undefined

export type BuiltinPlatformManagerOptions = {
  config?: PlatformManagerConfig
  secrets?: PlatformSecretAccess
  env?: Record<string, string | undefined>
}

function normalizeOptions(input?: PlatformManagerConfig | BuiltinPlatformManagerOptions): BuiltinPlatformManagerOptions {
  if (!input) return {}
  if ('config' in input || 'secrets' in input || 'env' in input) {
    return input as BuiltinPlatformManagerOptions
  }
  return { config: input as PlatformManagerConfig }
}

export function getBuiltinPlatformManager(input?: PlatformManagerConfig | BuiltinPlatformManagerOptions) {
  const options = normalizeOptions(input)
  if (!builtinPlatformManager) {
    builtinPlatformManager = new PlatformAdapterManager({
      contributions: builtinPlatformContributions,
      config: options.config,
      secrets: options.secrets,
      env: options.env,
    })
    return builtinPlatformManager
  }
  if (options.secrets || options.env) {
    unregisterBuiltinPlatformAdapters()
    builtinPlatformManager = new PlatformAdapterManager({
      contributions: builtinPlatformContributions,
      config: options.config,
      secrets: options.secrets,
      env: options.env,
    })
    return builtinPlatformManager
  }
  if (options.config) {
    builtinPlatformManager.configure(options.config)
  }
  return builtinPlatformManager
}

export function registerBuiltinPlatformAdapters(input?: PlatformManagerConfig | BuiltinPlatformManagerOptions) {
  return getBuiltinPlatformManager(input).registerRuntimeAdapters()
}

export function unregisterBuiltinPlatformAdapters() {
  return builtinPlatformManager?.unregisterRuntimeAdapters() ?? []
}

export function resetBuiltinPlatformManagerForTesting() {
  unregisterBuiltinPlatformAdapters()
  builtinPlatformManager = undefined
}
