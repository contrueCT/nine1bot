import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const jsonHeaders = {
  "Content-Type": "application/json",
}

let envSnapshot: NodeJS.ProcessEnv
const tempDirs: string[] = []

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(async () => {
  restoreEnv(envSnapshot)
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("config routes reload behavior", () => {
  test("PATCH /config refreshes config without disposing the current instance", async () => {
    const setup = await setupProject()
    const disposed = collectInstanceDisposedEvents()

    try {
      const response = await request(setup.projectDir, "/config", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ model: "updated/model" }),
      })

      expect(response.status).toBe(200)
      expect(disposed.events).toEqual([])
      expect(await configModel(setup.projectDir)).toBe("updated/model")
    } finally {
      disposed.stop()
    }
  })

  test("PATCH /config/nine1bot refreshes runtime config without disposing the current instance", async () => {
    const setup = await setupProject()
    const disposed = collectInstanceDisposedEvents()

    try {
      const response = await request(setup.projectDir, "/config/nine1bot", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ model: "nine1bot/model" }),
      })

      expect(response.status).toBe(200)
      expect(disposed.events).toEqual([])
      expect(JSON.parse(await readFile(setup.runtimeConfigPath, "utf-8")).model).toBe("nine1bot/model")
      expect(await configModel(setup.projectDir)).toBe("nine1bot/model")
    } finally {
      disposed.stop()
    }
  })

  test("custom provider upsert and delete refresh providers without disposing the current instance", async () => {
    const setup = await setupProject()
    const disposed = collectInstanceDisposedEvents()
    const provider = {
      name: "Local Custom",
      protocol: "openai",
      baseURL: "https://example.test/v1",
      models: [{ id: "custom-model" }],
    }

    try {
      const upsert = await request(setup.projectDir, "/config/nine1bot/custom-providers/local-custom", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify(provider),
      })

      expect(upsert.status).toBe(200)
      expect(disposed.events).toEqual([])
      await Instance.provide({
        directory: setup.projectDir,
        fn: async () => {
          expect((await Config.get()).provider?.["local-custom"]).toBeDefined()
          expect((await Provider.list())["local-custom"]?.models["custom-model"]).toBeDefined()
        },
      })

      const remove = await request(setup.projectDir, "/config/nine1bot/custom-providers/local-custom", {
        method: "DELETE",
        headers: jsonHeaders,
      })

      expect(remove.status).toBe(200)
      expect(disposed.events).toEqual([])
      await Instance.provide({
        directory: setup.projectDir,
        fn: async () => {
          expect((await Config.get()).provider?.["local-custom"]).toBeUndefined()
          expect((await Provider.list())["local-custom"]).toBeUndefined()
        },
      })
    } finally {
      disposed.stop()
    }
  })
})

async function setupProject() {
  const projectDir = await mkdtemp(path.join(tmpdir(), "opencode-config-routes-"))
  tempDirs.push(projectDir)
  const runtimeConfigPath = path.join(projectDir, "config.json")
  const nine1botConfigPath = path.join(projectDir, "nine1bot.config.jsonc")
  await writeFile(runtimeConfigPath, "{}\n", "utf-8")
  await writeFile(nine1botConfigPath, "{}\n", "utf-8")
  process.env.OPENCODE_CONFIG = runtimeConfigPath
  process.env.NINE1BOT_CONFIG_PATH = nine1botConfigPath
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
  return { projectDir, runtimeConfigPath, nine1botConfigPath }
}

async function request(projectDir: string, pathname: string, init: RequestInit) {
  return Server.App().request(pathname, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      "x-opencode-directory": projectDir,
    },
  })
}

async function configModel(projectDir: string) {
  return Instance.provide({
    directory: projectDir,
    fn: async () => (await Config.get()).model,
  })
}

function collectInstanceDisposedEvents() {
  const events: Array<{ directory?: string; payload: any }> = []
  const handler = (event: { directory?: string; payload: any }) => {
    if (event.payload?.type === "server.instance.disposed") events.push(event)
  }
  GlobalBus.on("event", handler)
  return {
    events,
    stop() {
      GlobalBus.off("event", handler)
    },
  }
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
