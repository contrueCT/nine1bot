import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Nine1BotPlatformRoutes } from "../../src/server/routes/nine1bot-platforms"
import {
  getBuiltinPlatformManager,
  resetBuiltinPlatformManagerForTesting,
} from "../../../../../packages/nine1bot/src/platform/builtin"
import * as configStore from "../../../../../packages/nine1bot/src/platform/config-store"

test("reading platform list preserves inherited configuration and disabled adapters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine1bot-review-platform-"))
  const previousPath = process.env.NINE1BOT_CONFIG_PATH
  const originalRead = configStore.readPlatformManagerConfig
  let readSpy: ReturnType<typeof spyOn> | undefined
  try {
    const configPath = join(directory, "nine1bot.config.jsonc")
    const globalConfigPath = join(directory, "global.jsonc")
    await writeFile(configPath, JSON.stringify({ server: { port: 4096 } }))
    await writeFile(globalConfigPath, JSON.stringify({ platforms: {
      feishu: { enabled: false, settings: { inheritedMarker: "global-config" } },
      gitlab: { enabled: false },
    } }))
    readSpy = spyOn(configStore, "readPlatformManagerConfig").mockImplementation((filePath = configPath) => originalRead(filePath, { globalConfigPath }))
    process.env.NINE1BOT_CONFIG_PATH = configPath
    resetBuiltinPlatformManagerForTesting()
    // launch() passes effective merged global + project settings here.
    const manager = getBuiltinPlatformManager({ config: {
      feishu: { enabled: false, settings: { inheritedMarker: "global-config" } },
      gitlab: { enabled: false },
    } })
    expect(manager.configSnapshot().feishu?.settings?.inheritedMarker).toBe("global-config")
    expect(manager.get("feishu")?.enabled).toBe(false)
    const response = await Nine1BotPlatformRoutes().request("/")
    expect(response.status).toBe(200)
    expect(manager.configSnapshot().feishu?.settings?.inheritedMarker).toBe("global-config")
    expect(manager.get("feishu")?.enabled).toBe(false)
  } finally {
    readSpy?.mockRestore()
    resetBuiltinPlatformManagerForTesting()
    if (previousPath === undefined) delete process.env.NINE1BOT_CONFIG_PATH
    else process.env.NINE1BOT_CONFIG_PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  }
})
