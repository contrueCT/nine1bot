import { gitlabPlatformContribution } from '@nine1bot/platform-gitlab/runtime'
import { PlatformAdapterManager, type PlatformManagerConfig } from './manager'

export const builtinPlatformContributions = [
  gitlabPlatformContribution,
]

let builtinPlatformManager: PlatformAdapterManager | undefined

export function getBuiltinPlatformManager(config?: PlatformManagerConfig) {
  if (!builtinPlatformManager) {
    builtinPlatformManager = new PlatformAdapterManager({
      contributions: builtinPlatformContributions,
      config,
    })
    return builtinPlatformManager
  }
  if (config) {
    builtinPlatformManager.configure(config)
  }
  return builtinPlatformManager
}

export function registerBuiltinPlatformAdapters(config?: PlatformManagerConfig) {
  return getBuiltinPlatformManager(config).registerRuntimeAdapters()
}

export function unregisterBuiltinPlatformAdapters() {
  return builtinPlatformManager?.unregisterRuntimeAdapters() ?? []
}

export function resetBuiltinPlatformManagerForTesting() {
  unregisterBuiltinPlatformAdapters()
  builtinPlatformManager = undefined
}
