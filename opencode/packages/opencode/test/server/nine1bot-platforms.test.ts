import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { Log } from "../../src/util/log"
import {
  getBuiltinPlatformManager,
  registerBuiltinPlatformAdapters,
  resetBuiltinPlatformManagerForTesting,
} from "../../../../../packages/nine1bot/src/platform/builtin"
import { FilePlatformSecretStore } from "../../../../../packages/nine1bot/src/platform/secrets"

const projectRoot = path.join(__dirname, "../..")
const jsonHeaders = {
  "Content-Type": "application/json",
  "x-opencode-directory": projectRoot,
}

const tempDirs: string[] = []
let envSnapshot: NodeJS.ProcessEnv

Log.init({ print: false })

beforeEach(async () => {
  envSnapshot = { ...process.env }
  resetPlatformState()
})

afterEach(async () => {
  restoreEnv(envSnapshot)
  resetPlatformState()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function resetPlatformState() {
  resetBuiltinPlatformManagerForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
}

function restoreEnv(snapshot: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function setupPlatformConfig(config: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "nine1bot-platform-api-"))
  tempDirs.push(dir)
  const configPath = path.join(dir, "nine1bot.config.jsonc")
  const secretPath = path.join(dir, "platform-secrets.json")
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
  process.env.NINE1BOT_CONFIG_PATH = configPath
  process.env.NINE1BOT_PLATFORM_SECRETS_PATH = secretPath
  registerBuiltinPlatformAdapters({
    config: config.platforms as any,
    secrets: new FilePlatformSecretStore(secretPath),
  })
  return { configPath, secretPath }
}

async function request(pathname: string, init?: RequestInit) {
  return Instance.provide({
    directory: projectRoot,
    fn: async () => Server.App().request(pathname, init),
  })
}

describe("nine1bot platform api", () => {
  test("lists platforms and returns GitLab detail", async () => {
    await setupPlatformConfig({})

    const list = await request("/nine1bot/platforms", {
      method: "GET",
      headers: jsonHeaders,
    })
    expect(list.status).toBe(200)
    const listBody = await list.json() as {
      platforms: Array<{ id: string; enabled: boolean; status: string }>
    }
    expect(listBody.platforms).toContainEqual(expect.objectContaining({
      id: "gitlab",
      enabled: true,
      status: "available",
    }))

    const detail = await request("/nine1bot/platforms/gitlab", {
      method: "GET",
      headers: jsonHeaders,
    })
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as {
      descriptor: { id: string }
      actions: Array<{ id: string }>
      runtimeStatus: { status: string }
    }
    expect(detailBody.descriptor.id).toBe("gitlab")
    expect(detailBody.actions.map((action) => action.id)).toContain("connection.test")
    expect(detailBody.runtimeStatus.status).toBe("available")
  })

  test("patches platform enabled state and updates runtime registry", async () => {
    const { configPath } = await setupPlatformConfig({})
    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain("gitlab")

    const disabled = await request("/nine1bot/platforms/gitlab", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({
        enabled: false,
      }),
    })
    expect(disabled.status).toBe(200)
    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain("gitlab")

    const storedAfterDisable = JSON.parse(await readFile(configPath, "utf-8"))
    expect(storedAfterDisable.platforms.gitlab.enabled).toBe(false)

    const enabled = await request("/nine1bot/platforms/gitlab", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({
        enabled: true,
      }),
    })
    expect(enabled.status).toBe(200)
    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain("gitlab")
  })

  test("rejects invalid platform settings without writing config", async () => {
    const { configPath } = await setupPlatformConfig({})

    const response = await request("/nine1bot/platforms/gitlab", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({
        settings: {
          apiEnrichment: "bad-value",
        },
      }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { fieldErrors?: Record<string, string> }
    expect(body.fieldErrors?.apiEnrichment).toContain("Must be one of")
    const stored = JSON.parse(await readFile(configPath, "utf-8"))
    expect(stored.platforms).toBeUndefined()
  })

  test("executes declared action as structured failed result when handler is missing", async () => {
    await setupPlatformConfig({})

    const response = await request("/nine1bot/platforms/gitlab/actions/connection.test", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      message: "Action is not implemented: connection.test",
    })
  })

  test("restores in-memory platform settings when action persistence fails", async () => {
    const { configPath } = await setupPlatformConfig({})
    await chmod(configPath, 0o444)

    try {
      const response = await request("/nine1bot/platforms/feishu/actions/skills.configureDirectory", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          input: {
            directory: "",
          },
        }),
      })

      expect(response.status).toBe(500)
      expect(getBuiltinPlatformManager().configSnapshot().feishu).toBeUndefined()
      const stored = JSON.parse(await readFile(configPath, "utf-8"))
      expect(stored.platforms).toBeUndefined()
    } finally {
      await chmod(configPath, 0o666).catch(() => undefined)
    }
  })
})
