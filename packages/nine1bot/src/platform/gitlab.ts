import { gitlabPlatformContribution } from '@nine1bot/platform-gitlab/runtime'
import { PlatformAdapterManager } from './manager'

export function registerGitLabPlatformAdapter() {
  return new PlatformAdapterManager({
    contributions: [gitlabPlatformContribution],
  }).registerRuntimeAdapters()
}
