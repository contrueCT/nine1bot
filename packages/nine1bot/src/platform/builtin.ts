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

export function getBuiltinPlatformManager(options: BuiltinPlatformManagerOptions = {}) {
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

export function registerBuiltinPlatformAdapters(options: BuiltinPlatformManagerOptions = {}) {
  return getBuiltinPlatformManager(options).registerRuntimeAdapters()
}

export function unregisterBuiltinPlatformAdapters() {
  return builtinPlatformManager?.unregisterRuntimeAdapters() ?? []
}

export function resetBuiltinPlatformManagerForTesting() {
  unregisterBuiltinPlatformAdapters()
  builtinPlatformManager = undefined
}
