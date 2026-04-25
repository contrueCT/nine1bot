import { Config } from "@/config/config"

export namespace RuntimeFeatureFlags {
  export async function agentRunSpecEnabled() {
    const config = await Config.get()
    return config.runtime?.agentRunSpec?.enabled ?? true
  }
}
