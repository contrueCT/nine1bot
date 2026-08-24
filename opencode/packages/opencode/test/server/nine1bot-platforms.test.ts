import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"
import { Log } from "../../src/util/log"
import {
  builtinPlatformContributions,
  getBuiltinPlatformManager,
  registerBuiltinPlatformAdapters,
  resetBuiltinPlatformManagerForTesting,
} from "../../../../../packages/nine1bot/src/platform/builtin"
import { FilePlatformSecretStore } from "../../../../../packages/nine1bot/src/platform/secrets"
import { gitLabCliToolIds } from "../../../../../packages/platform-gitlab/src/cli"
import type {
  AnyPlatformToolDefinition,
  PlatformAdapterContribution,
  PlatformSecretRef,
} from "../../../../../packages/platform-protocol/src"

const projectRoot = path.join(__dirname, "../..")
const jsonHeaders = {
  "Content-Type": "application/json",
  "x-opencode-directory": projectRoot,
}

const tempDirs: string[] = []
const builtinContributionCount = builtinPlatformContributions.length
let envSnapshot: NodeJS.ProcessEnv

Log.init({ print: false })

beforeEach(async () => {
  envSnapshot = { ...process.env }
  resetPlatformState()
  const configDir = await mkdtemp(path.join(tmpdir(), "nine1bot-platform-opencode-"))
  tempDirs.push(configDir)
  const opencodeConfigPath = path.join(configDir, "opencode.json")
  await writeFile(opencodeConfigPath, JSON.stringify({
    model: "test-provider/test-model",
    permission: {
      demo_hidden: "deny",
    },
  }), "utf-8")
  process.env.OPENCODE_CONFIG = opencodeConfigPath
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
})

afterEach(async () => {
  restoreEnv(envSnapshot)
  resetPlatformState()
  ;(builtinPlatformContributions as PlatformAdapterContribution[]).splice(builtinContributionCount)
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function resetPlatformState() {
  resetBuiltinPlatformManagerForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
  RuntimeToolRegistry.clearForTesting()
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

function toolDefinition(
  id: string,
  options: Partial<AnyPlatformToolDefinition> = {},
): AnyPlatformToolDefinition {
  return {
    id,
    description: `Use ${id}`,
    catalogVisibility: "user-selectable",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    parse(input) {
      return input
    },
    async execute() {
      return {
        status: "ok",
        title: id,
        output: id,
      }
    },
    ...options,
  }
}

function testPlatformContribution(): PlatformAdapterContribution {
  return {
    descriptor: {
      id: "test-platform",
      name: "Test Platform",
      packageName: "@nine1bot/platform-test",
      version: "0.0.0-test",
      defaultEnabled: true,
      capabilities: {
        templates: ["test-platform-page"],
        resources: true,
      },
      actions: [{
        id: "fixture.missing",
        label: "Missing fixture action",
        kind: "button",
      }],
    },
    runtime: {
      createAdapter: () => ({ id: "test-platform" }),
      tools(context) {
        if ((context.settings as Record<string, unknown>).fail === true) {
          throw new Error("test platform tool provider failed")
        }
        return [toolDefinition("test_platform_lookup")]
      },
    },
  }
}

function testBackgroundPlatformContribution(tracker: {
  starts: string[]
  stops: string[]
  credentials: string[]
  active?: string
}): PlatformAdapterContribution {
  const platformID = "test-background"
  return {
    descriptor: {
      id: platformID,
      name: "Test Background Platform",
      packageName: "@nine1bot/platform-test-background",
      version: "0.0.0-test",
      defaultEnabled: true,
      capabilities: {},
      config: {
        sections: [{
          id: "auth",
          title: "Auth",
          fields: [{
            key: "token",
            label: "Token",
            type: "password",
            secret: true,
          }],
        }],
      },
    },
    runtime: {
      createAdapter: () => ({ id: platformID }),
      tools(context) {
        const version = String((context.settings as Record<string, unknown>).version ?? "missing")
        return [toolDefinition("test_background_lookup", {
          async execute() {
            return {
              status: "ok",
              title: "Background lookup",
              output: version,
            }
          },
        })]
      },
    },
    backgroundServices(context) {
      const version = String((context.settings as Record<string, unknown>).version ?? "missing")
      const tokenRef = (context.settings as Record<string, unknown>).token as PlatformSecretRef | undefined
      return [{
        id: "test-background-service",
        async start() {
          tracker.starts.push(version)
          tracker.credentials.push(`${version}:${tokenRef ? await context.secrets.get(tokenRef) : "missing"}`)
          tracker.active = version
          return {
            async stop() {
              tracker.stops.push(version)
              if (tracker.active === version) tracker.active = undefined
            },
          }
        },
      }]
    },
  }
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
      runtimeTools?: Array<{
        id: string
        ownerId: string
        catalogVisibility: string
        status: string
      }>
      desiredConfigRevision: number
      appliedConfigRevision?: number
    }
    expect(detailBody.descriptor.id).toBe("gitlab")
    expect(detailBody.actions.map((action) => action.id)).toContain("connection.test")
    expect(detailBody.runtimeStatus.status).toBe("available")
    expect(detailBody.runtimeTools?.map((tool) => tool.id)).toEqual(Object.values(gitLabCliToolIds))
    expect(detailBody.runtimeTools?.every((tool) => (
      tool.ownerId === "gitlab"
      && tool.catalogVisibility === "declared-only"
      && tool.status === "registered"
    ))).toBe(true)
    expect(detailBody.desiredConfigRevision).toBe(1)
    expect(detailBody.appliedConfigRevision).toBe(1)
  })

  test("returns a project-aware secret-safe selectable tool catalog", async () => {
    const fixtureSecret = "fixture-tool-token-value"
    await setupPlatformConfig({})
    RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [
        toolDefinition("demo_ready", {
          execute: async () => ({ status: "ok", title: "ready", output: fixtureSecret }),
        }),
        toolDefinition("demo_declared", { catalogVisibility: "declared-only" }),
        toolDefinition("demo_auth", {
          availability: () => ({
            status: "auth-required",
            reason: `token=${fixtureSecret}`,
            action: {
              type: "open-settings",
              label: `Authorization: Bearer ${fixtureSecret}`,
            },
          }),
        }),
        toolDefinition("demo_hidden"),
      ],
    })
    RuntimeToolRegistry.registerOwner({
      owner: { id: "display", kind: "platform", enabled: true },
      tools: [toolDefinition("display_file")],
    })

    const response = await request(
      "/nine1bot/platforms/tools?agent=build&templateIds=browser-generic,browser-generic",
      { method: "GET", headers: jsonHeaders },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      tools: Array<{
        id: string
        ownerId: string
        status: string
        unavailableReason?: string
        action?: { type: string; label: string }
      }>
    }

    expect(body.tools.map((tool) => tool.id)).toEqual([
      "demo_auth",
      "demo_ready",
      "display_file",
    ])
    expect(body.tools.find((tool) => tool.id === "demo_ready")?.status).toBe("registered")
    expect(body.tools.find((tool) => tool.id === "demo_auth")).toMatchObject({
      ownerId: "demo",
      status: "auth-required",
      action: { type: "open-settings" },
    })
    expect(body.tools.find((tool) => tool.id === "display_file")?.status).toBe("conflict")

    const serialized = JSON.stringify(body)
    for (const key of ["inputSchema", "parse", "execute", "settings", "cookie", "Authorization"]) {
      expect(serialized).not.toContain(`\"${key}\"`)
    }
    expect(serialized).not.toContain(fixtureSecret)
    expect(serialized).not.toContain("demo_declared")
    expect(serialized).not.toContain("demo_hidden")
  }, 30_000)

  test("keeps the last catalog generation live when a persisted reload degrades", async () => {
    ;(builtinPlatformContributions as PlatformAdapterContribution[]).push(testPlatformContribution())
    const { configPath } = await setupPlatformConfig({
      platforms: {
        "test-platform": {
          settings: { fail: false },
        },
      },
    })

    const initial = await request("/nine1bot/platforms/test-platform", {
      method: "GET",
      headers: jsonHeaders,
    })
    expect(initial.status).toBe(200)
    await expect(initial.json()).resolves.toMatchObject({
      runtimeTools: [{ id: "test_platform_lookup", generation: 1 }],
      desiredConfigRevision: 1,
      appliedConfigRevision: 1,
    })

    const updated = await request("/nine1bot/platforms/test-platform", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ settings: { fail: true } }),
    })
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      lifecycleStatus: "degraded",
      runtimeTools: [{ id: "test_platform_lookup", generation: 1 }],
      desiredConfigRevision: 2,
      appliedConfigRevision: 1,
    })

    const stored = JSON.parse(await readFile(configPath, "utf-8"))
    expect(stored.platforms["test-platform"].settings.fail).toBe(true)
    expect(RuntimeToolRegistry.get("test_platform_lookup")?.generation).toBe(1)
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
    ;(builtinPlatformContributions as PlatformAdapterContribution[]).push(testPlatformContribution())
    await setupPlatformConfig({})

    const response = await request("/nine1bot/platforms/test-platform/actions/fixture.missing", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      message: "Action is not implemented: fixture.missing",
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

  test("restores the running background service when patch persistence fails", async () => {
    const tracker = {
      starts: [] as string[],
      stops: [] as string[],
      credentials: [] as string[],
      active: undefined as string | undefined,
    }
    const previousTokenRef = {
      provider: "nine1bot-local",
      key: "platform:test-background:default:token",
    } satisfies PlatformSecretRef
    ;(builtinPlatformContributions as PlatformAdapterContribution[]).push(
      testBackgroundPlatformContribution(tracker),
    )
    const { configPath, secretPath } = await setupPlatformConfig({
      platforms: {
        feishu: { enabled: false },
        "test-background": {
          settings: {
            version: "persisted",
            token: previousTokenRef,
          },
        },
      },
    })
    const secrets = new FilePlatformSecretStore(secretPath)
    await secrets.set(previousTokenRef, "old-token")
    const manager = getBuiltinPlatformManager()
    await manager.startBackgroundServices({ localUrl: "http://127.0.0.1:4096" })
    expect(tracker).toMatchObject({
      starts: ["persisted"],
      stops: [],
      credentials: ["persisted:old-token"],
      active: "persisted",
    })
    await chmod(configPath, 0o444)

    try {
      const response = await request("/nine1bot/platforms/test-background", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ settings: { version: "unpersisted", token: "new-token" } }),
      })

      expect(response.status).toBe(500)
      expect(manager.configSnapshot()["test-background"]?.settings).toEqual({
        version: "persisted",
        token: previousTokenRef,
      })
      expect(tracker).toMatchObject({
        starts: ["persisted", "unpersisted", "persisted"],
        stops: ["persisted", "unpersisted"],
        credentials: ["persisted:old-token", "unpersisted:new-token", "persisted:old-token"],
        active: "persisted",
      })
      await expect(secrets.get(previousTokenRef)).resolves.toBe("old-token")
      expect(RuntimeToolRegistry.get("test_background_lookup")?.generation).toBe(3)
    } finally {
      await chmod(configPath, 0o666).catch(() => undefined)
    }
  })
})
