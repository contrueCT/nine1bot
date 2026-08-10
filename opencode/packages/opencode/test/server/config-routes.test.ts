import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"
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
  RuntimeToolRegistry.clearForTesting()
  restoreEnv(envSnapshot)
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(tempDirs.splice(0).map(removeTempDirectory))
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

  test("browser extension config route reads and writes sidepanel defaults", async () => {
    const setup = await setupProject()
    const disposed = collectInstanceDisposedEvents()

    try {
      const empty = await request(setup.projectDir, "/config/nine1bot/browser-extension", {
        method: "GET",
        headers: jsonHeaders,
      })
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({})

      const update = await request(setup.projectDir, "/config/nine1bot/browser-extension", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          model: { providerID: "openai", modelID: "gpt-5" },
          prompt: "Use concise browser context.",
          mcpServers: ["filesystem", "gitlab", "filesystem"],
          skills: ["browser-review", "browser-review"],
        }),
      })
      expect(update.status).toBe(200)
      expect(await update.json()).toEqual({
        model: { providerID: "openai", modelID: "gpt-5" },
        prompt: "Use concise browser context.",
        mcpServers: ["filesystem", "gitlab"],
        skills: ["browser-review"],
      })
      expect(disposed.events).toEqual([])

      const file = JSON.parse(await readFile(setup.nine1botConfigPath, "utf-8"))
      expect(file.browser.sidepanel).toEqual({
        model: "openai/gpt-5",
        prompt: "Use concise browser context.",
        mcpServers: ["filesystem", "gitlab"],
        skills: ["browser-review"],
      })

      const clearPrompt = await request(setup.projectDir, "/config/nine1bot/browser-extension", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          prompt: null,
          mcpServers: null,
          skills: [],
        }),
      })
      expect(clearPrompt.status).toBe(200)
      expect(await clearPrompt.json()).toEqual({
        model: { providerID: "openai", modelID: "gpt-5" },
      })
    } finally {
      disposed.stop()
    }
  })

  test("rejects missing or declared-only browser registered tool defaults", async () => {
    const setup = await setupProject()
    RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [
        registeredToolDefinition("demo_lookup", "user-selectable"),
        registeredToolDefinition("demo_declared", "declared-only"),
      ],
    })

    const valid = await request(setup.projectDir, "/config/nine1bot/browser-extension", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ registeredTools: ["demo_lookup"] }),
    })
    expect(valid.status).toBe(200)

    for (const toolID of ["demo_declared", "demo_missing"]) {
      const invalid = await request(setup.projectDir, "/config/nine1bot/browser-extension", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ registeredTools: [toolID] }),
      })
      expect(invalid.status).toBe(400)
    }

    const stored = JSON.parse(await readFile(setup.nine1botConfigPath, "utf-8"))
    expect(stored.browser.sidepanel.registeredTools).toEqual(["demo_lookup"])
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

  test("custom provider updates invalidate provider caches across project directories", async () => {
    const setup = await setupProject()
    const otherProjectDir = await mkdtemp(path.join(tmpdir(), "opencode-config-routes-other-"))
    tempDirs.push(otherProjectDir)
    const provider = {
      name: "Shared Custom",
      protocol: "openai",
      baseURL: "https://example.test/v1",
      models: [{ id: "shared-model" }],
    }

    expect(await hasProvider(setup.projectDir, "shared-custom")).toBe(false)
    expect(await hasProvider(otherProjectDir, "shared-custom")).toBe(false)

    const upsert = await request(otherProjectDir, "/config/nine1bot/custom-providers/shared-custom", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(provider),
    })

    expect(upsert.status).toBe(200)
    expect(await hasProvider(setup.projectDir, "shared-custom")).toBe(true)
    expect(await hasProvider(otherProjectDir, "shared-custom")).toBe(true)

    const remove = await request(otherProjectDir, "/config/nine1bot/custom-providers/shared-custom", {
      method: "DELETE",
      headers: jsonHeaders,
    })

    expect(remove.status).toBe(200)
    expect(await hasProvider(setup.projectDir, "shared-custom")).toBe(false)
    expect(await hasProvider(otherProjectDir, "shared-custom")).toBe(false)
  })

  test("provider auth updates invalidate provider caches across project directories", async () => {
    const setup = await setupProject()
    const otherProjectDir = await mkdtemp(path.join(tmpdir(), "opencode-auth-routes-other-"))
    tempDirs.push(otherProjectDir)
    const provider = {
      name: "Shared Auth",
      protocol: "openai",
      baseURL: "https://example.test/v1",
      models: [{ id: "shared-model" }],
    }

    const upsert = await request(setup.projectDir, "/config/nine1bot/custom-providers/shared-auth", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(provider),
    })
    expect(upsert.status).toBe(200)
    expect(await providerKey(setup.projectDir, "shared-auth")).toBeUndefined()
    expect(await providerKey(otherProjectDir, "shared-auth")).toBeUndefined()

    const setAuth = await request(otherProjectDir, "/auth/shared-auth", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ type: "api", key: "test-key" }),
    })
    expect(setAuth.status).toBe(200)
    expect(await providerKey(setup.projectDir, "shared-auth")).toBe("test-key")
    expect(await providerKey(otherProjectDir, "shared-auth")).toBe("test-key")

    const removeAuth = await request(otherProjectDir, "/auth/shared-auth", {
      method: "DELETE",
      headers: jsonHeaders,
    })
    expect(removeAuth.status).toBe(200)
    expect(await providerKey(setup.projectDir, "shared-auth")).toBeUndefined()
    expect(await providerKey(otherProjectDir, "shared-auth")).toBeUndefined()
  })
})

function registeredToolDefinition(
  id: string,
  catalogVisibility: "declared-only" | "user-selectable",
): RuntimeToolRegistry.Definition {
  return {
    id,
    description: `Use ${id}`,
    catalogVisibility,
    inputSchema: { type: "object" },
    parse: (input) => input,
    execute: async () => ({ status: "ok", title: id, output: id }),
  }
}

async function setupProject() {
  const projectDir = await mkdtemp(path.join(tmpdir(), "opencode-config-routes-"))
  tempDirs.push(projectDir)
  const runtimeConfigPath = path.join(projectDir, "config.json")
  const nine1botConfigPath = path.join(projectDir, "nine1bot.config.jsonc")
  const authPath = path.join(projectDir, "auth.json")
  await writeFile(runtimeConfigPath, "{}\n", "utf-8")
  await writeFile(nine1botConfigPath, "{}\n", "utf-8")
  process.env.OPENCODE_CONFIG = runtimeConfigPath
  process.env.NINE1BOT_CONFIG_PATH = nine1botConfigPath
  process.env.NINE1BOT_AUTH_PATH = authPath
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

async function hasProvider(projectDir: string, providerID: string) {
  return Instance.provide({
    directory: projectDir,
    fn: async () => providerID in (await Provider.list()),
  })
}

async function providerKey(projectDir: string, providerID: string) {
  return Instance.provide({
    directory: projectDir,
    fn: async () => (await Provider.list())[providerID]?.key,
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

async function removeTempDirectory(directory: string) {
  try {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Bun can leave refreshed config files delete-pending until process exit on Windows.
    if (process.platform === "win32" && code === "EBUSY") return
    throw error
  }
}
