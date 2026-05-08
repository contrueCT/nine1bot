import { feishuPlatformContribution } from '@nine1bot/platform-feishu/runtime'
import { gitlabPlatformContribution } from '@nine1bot/platform-gitlab/runtime'
import type { PlatformSecretAccess } from '@nine1bot/platform-protocol'
import {
  PlatformAdapterManager,
  type PlatformBackgroundServicesStartOptions,
  type PlatformManagerConfig,
} from './manager'

export const builtinPlatformContributions = [
  gitlabPlatformContribution,
  feishuPlatformContribution,
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
  if (options.config) {
    builtinPlatformManager.configure(options.config)
  }
  return builtinPlatformManager
}

export function registerBuiltinPlatformAdapters(options: BuiltinPlatformManagerOptions = {}) {
  return getBuiltinPlatformManager(options).registerRuntimeAdapters()
}

export async function startBuiltinPlatformBackgroundServices(options: PlatformBackgroundServicesStartOptions & BuiltinPlatformManagerOptions) {
  const manager = builtinPlatformManager ?? getBuiltinPlatformManager({
    config: options.config,
    secrets: options.secrets,
    env: options.env,
  })
  return manager.startBackgroundServices(options)
}

export async function stopBuiltinPlatformBackgroundServices() {
  await builtinPlatformManager?.stopBackgroundServices()
}

export function unregisterBuiltinPlatformAdapters() {
  return builtinPlatformManager?.unregisterRuntimeAdapters() ?? []
}

export function resetBuiltinPlatformManagerForTesting() {
  unregisterBuiltinPlatformAdapters()
  void stopBuiltinPlatformBackgroundServices()
  builtinPlatformManager = undefined
}
