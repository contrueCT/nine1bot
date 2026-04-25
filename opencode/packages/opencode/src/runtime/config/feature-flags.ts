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
}
