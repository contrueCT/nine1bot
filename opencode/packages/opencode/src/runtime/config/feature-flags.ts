import { Config } from "@/config/config"

export namespace RuntimeFeatureFlags {
  export async function agentRunSpecEnabled() {
    const config = await Config.get()
    return config.runtime?.agentRunSpec?.enabled ?? true
  }

  export async function profileSnapshotEnabled() {
    const config = await Config.get()
    return config.runtime?.profileSnapshot?.enabled ?? true
  }

  export async function contextPipelineEnabled() {
    const config = await Config.get()
    return config.runtime?.contextPipeline?.enabled ?? true
  }

  export async function resourceResolverEnabled() {
    const config = await Config.get()
    return config.runtime?.resourceResolver?.enabled ?? true
  }
}
