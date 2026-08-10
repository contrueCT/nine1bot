import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { RuntimeContextEvents } from "../../src/runtime/context/events"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
const jsonHeaders = {
  "Content-Type": "application/json",
  "x-opencode-directory": projectRoot,
}
Log.init({ print: false })

let envSnapshot: NodeJS.ProcessEnv
const tempDirs: string[] = []

beforeEach(async () => {
  envSnapshot = { ...process.env }
  const configDir = await mkdtemp(path.join(tmpdir(), "nine1bot-controller-api-"))
  tempDirs.push(configDir)
  const runtimeConfigPath = path.join(configDir, "config.json")
  await writeFile(
    runtimeConfigPath,
    JSON.stringify({
      model: "openai/gpt-4o-mini",
    }),
    "utf-8",
  )
  process.env.OPENCODE_CONFIG = runtimeConfigPath
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
})

afterEach(async () => {
  RuntimePlatformAdapterRegistry.clearForTesting()
  RuntimeToolRegistry.clearForTesting()
  await Instance.disposeAll().catch(() => undefined)
  restoreEnv(envSnapshot)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("nine1bot controller api", () => {
  test("advertises registered platform tool support", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const response = await Server.App().request("/nine1bot/runtime/capabilities", {
          headers: jsonHeaders,
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          server: { registeredTools?: boolean }
        }
        expect(body.server.registeredTools).toBe(true)
      },
    })
  })

  test("creates a profiled session and accepts a noReply message with a turn snapshot", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const created = await app.request("/nine1bot/agent/sessions", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            title: "Controller API test",
          }),
        })
        expect(created.status).toBe(200)
        const sessionBody = (await created.json()) as {
          sessionId: string
          profileSnapshotId?: string
        }
        expect(typeof sessionBody.sessionId).toBe("string")
        expect(sessionBody.sessionId.startsWith("ses")).toBe(true)
        expect(typeof sessionBody.profileSnapshotId).toBe("string")

        const sent = await app.request(`/nine1bot/agent/sessions/${sessionBody.sessionId}/messages`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            noReply: true,
            clientCapabilities: {
              interactions: true,
              artifacts: true,
              debug: true,
            },
            context: {
              page: {
                platform: "gitlab",
                pageType: "repo",
                objectKey: "group/project",
                title: "group/project",
              },
            },
            parts: [
              {
                type: "text",
                text: "controller no-reply request",
              },
            ],
          }),
        })
        expect(sent.status).toBe(202)
        const sendBody = (await sent.json()) as {
          accepted: boolean
          turnSnapshotId?: string
        }
        expect(sendBody.accepted).toBe(true)
        expect(typeof sendBody.turnSnapshotId).toBe("string")

        const messages = await Session.messages({ sessionID: sessionBody.sessionId })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.role).toBe("user")
        expect(await RuntimeContextEvents.list({ sessionID: sessionBody.sessionId })).toHaveLength(1)

        await Session.remove(sessionBody.sessionId)
      },
    })
  })

  test("creates controller sessions with entry template profile blocks", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const created = await app.request("/nine1bot/agent/sessions", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            title: "Feishu template session",
            debug: {
              profileSnapshot: true,
            },
            entry: {
              source: "feishu",
              platform: "feishu",
              mode: "feishu-private-chat",
              templateIds: ["default-user-template", "feishu-chat"],
            },
            clientCapabilities: {
              interactions: false,
              permissionRequests: false,
              questionRequests: false,
            },
          }),
        })
        expect(created.status).toBe(200)
        const body = (await created.json()) as {
          sessionId: string
          templateIds?: string[]
          profileSnapshot?: {
            sourceTemplateIds: string[]
            context: {
              blocks: Array<{ source: string; content: string }>
            }
          }
          session?: {
            client?: {
              source?: string
              platform?: string
              mode?: string
            }
          }
        }

        expect(body.templateIds).toContain("feishu-chat")
        expect(body.session?.client).toEqual({
          source: "feishu",
          platform: "feishu",
          mode: "feishu-private-chat",
        })
        expect(body.profileSnapshot?.sourceTemplateIds).toContain("feishu-chat")
        expect(body.profileSnapshot?.context.blocks.some((block) => block.source === "template.feishu-chat")).toBe(true)
        expect(JSON.stringify(body.profileSnapshot)).not.toContain("profileSnapshotId")

        await Session.remove(body.sessionId)
      },
    })
  })

  test("freezes the platform-recommended agent used for resource conditions into the session profile", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let resourceAgentName: string | undefined
        RuntimePlatformAdapterRegistry.register({
          id: "demo",
          recommendedAgent: ({ templateIds }) => templateIds.includes("demo-page") ? "plan" : undefined,
          resourceContributions: ({ agentName }) => {
            resourceAgentName = agentName
            return RuntimeResourceResolver.emptyResources()
          },
        })

        const created = await Server.App().request("/nine1bot/agent/sessions", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            debug: { profileSnapshot: true },
            entry: {
              source: "web",
              templateIds: ["demo-page"],
            },
          }),
        })
        expect(created.status).toBe(200)
        const body = (await created.json()) as {
          sessionId: string
          profileSnapshot?: {
            agent: {
              name: string
              source: string
            }
          }
        }

        expect(resourceAgentName).toBe("plan")
        expect(body.profileSnapshot?.agent).toEqual({
          name: "plan",
          source: "internal-runtime",
        })

        await Session.remove(body.sessionId)
      },
    })
  })

  test("applies browser extension sidepanel model and prompt only to extension sessions", async () => {
    const envSnapshot = { ...process.env }
    const tempDir = await mkdtemp(path.join(tmpdir(), "nine1bot-browser-extension-agent-"))
    const configPath = path.join(tempDir, "nine1bot.config.jsonc")
    await writeFile(
      configPath,
      JSON.stringify({
        browser: {
          sidepanel: {
            model: "openai/gpt-5",
            prompt: "Browser-only controller prompt.",
            mcpServers: ["filesystem"],
            skills: ["browser-review"],
          },
        },
      }),
      "utf-8",
    )
    process.env.NINE1BOT_CONFIG_PATH = configPath

    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const app = Server.App()
          let browserSessionId = ""
          let webSessionId = ""

          try {
            const browserCreated = await app.request("/nine1bot/agent/sessions", {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify({
                title: "Browser extension configured session",
                entry: {
                  source: "browser-extension",
                  mode: "browser-sidepanel",
                },
                debug: {
                  profileSnapshot: true,
                },
              }),
            })
            expect(browserCreated.status).toBe(200)
            const browserBody = (await browserCreated.json()) as {
              sessionId: string
              currentModel?: {
                providerID: string
                modelID: string
                source: string
              }
              profileSnapshot?: {
                resources?: {
                  mcp?: { servers?: string[] }
                  skills?: { skills?: string[] }
                }
              }
            }
            browserSessionId = browserBody.sessionId
            expect(browserBody.currentModel).toMatchObject({
              providerID: "openai",
              modelID: "gpt-5",
              source: "session-choice",
            })
            expect(browserBody.profileSnapshot?.resources?.mcp?.servers).toContain("filesystem")
            expect(browserBody.profileSnapshot?.resources?.skills?.skills).toContain("browser-review")

            const browserSent = await app.request(`/nine1bot/agent/sessions/${browserSessionId}/messages`, {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify({
                noReply: true,
                system: "Turn-specific browser prompt.",
                parts: [
                  {
                    type: "text",
                    text: "browser extension message",
                  },
                ],
              }),
            })
            expect(browserSent.status).toBe(202)
            const browserMessages = await Session.messages({ sessionID: browserSessionId })
            const browserMessageInfo = browserMessages[0]?.info
            expect(browserMessageInfo?.role).toBe("user")
            if (browserMessageInfo?.role !== "user") throw new Error("expected browser message to be a user message")
            expect(browserMessageInfo.system).toContain("Browser-only controller prompt.")
            expect(browserMessageInfo.system).toContain("Turn-specific browser prompt.")

            const webCreated = await app.request("/nine1bot/agent/sessions", {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify({
                title: "Web configured session",
              entry: {
                source: "web",
              },
              debug: {
                profileSnapshot: true,
              },
            }),
          })
            expect(webCreated.status).toBe(200)
            const webBody = (await webCreated.json()) as {
              sessionId: string
              currentModel?: {
                providerID: string
              modelID: string
              source: string
            }
            profileSnapshot?: {
              resources?: {
                mcp?: { servers?: string[] }
                skills?: { skills?: string[] }
              }
            }
          }
          webSessionId = webBody.sessionId
          expect(webBody.currentModel).not.toMatchObject({
            providerID: "openai",
            modelID: "gpt-5",
            source: "session-choice",
          })
          expect(webBody.profileSnapshot?.resources?.mcp?.servers ?? []).not.toContain("filesystem")
          expect(webBody.profileSnapshot?.resources?.skills?.skills ?? []).not.toContain("browser-review")

            const webSent = await app.request(`/nine1bot/agent/sessions/${webSessionId}/messages`, {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify({
                noReply: true,
                system: "Turn-specific web prompt.",
                parts: [
                  {
                    type: "text",
                    text: "web message",
                  },
                ],
              }),
            })
            expect(webSent.status).toBe(202)
            const webMessages = await Session.messages({ sessionID: webSessionId })
            const webMessageInfo = webMessages[0]?.info
            expect(webMessageInfo?.role).toBe("user")
            if (webMessageInfo?.role !== "user") throw new Error("expected web message to be a user message")
            expect(webMessageInfo.system).toContain("Turn-specific web prompt.")
            expect(webMessageInfo.system ?? "").not.toContain("Browser-only controller prompt.")
          } finally {
            if (browserSessionId) await Session.remove(browserSessionId).catch(() => undefined)
            if (webSessionId) await Session.remove(webSessionId).catch(() => undefined)
          }
        },
      })
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key]
      }
      for (const [key, value] of Object.entries(envSnapshot)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("reports declared and conflict-finalized registered tools in session debug", async () => {
    RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [registeredToolDefinition("demo_lookup")],
    })
    RuntimePlatformAdapterRegistry.register({
      id: "demo",
      resourceContributions: ({ templateIds }) => templateIds.includes("demo-page")
        ? {
            ...RuntimeResourceResolver.emptyResources(),
            registeredTools: {
              tools: ["demo_lookup"],
              lifecycle: "session",
              mergeMode: "additive-only",
            },
          }
        : undefined,
    })

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const created = await app.request("/nine1bot/agent/sessions", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            entry: {
              source: "web",
              templateIds: ["demo-page"],
            },
            debug: { profileSnapshot: true },
          }),
        })
        expect(created.status).toBe(200)
        const createdBody = await created.json() as { sessionId: string }

        try {
          const response = await app.request(
            `/nine1bot/agent/sessions/${createdBody.sessionId}/debug`,
            { method: "GET", headers: jsonHeaders },
          )
          expect(response.status).toBe(200)
          const body = await response.json() as {
            registeredTools?: {
              declared: string[]
              resolved: Array<{
                id: string
                ownerId: string
                generation: number
                status: string
                reason?: string
              }>
            }
          }
          expect(body.registeredTools?.declared).toEqual(["demo_lookup"])
          expect(body.registeredTools?.resolved).toEqual([{
            id: "demo_lookup",
            ownerId: "demo",
            generation: 1,
            status: "available",
          }])
          expect(JSON.stringify(body.registeredTools)).not.toContain("inputSchema")
          expect(JSON.stringify(body.registeredTools)).not.toContain("execute")
        } finally {
          await Session.remove(createdBody.sessionId)
        }
      },
    })
  }, 30_000)

  test("busy controller message returns 409 before writing user message or page context", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        const lease = SessionPrompt._testing.reserve(session.id)

        const beforeMessages = await Session.messages({ sessionID: session.id })
        const response = await app.request(`/nine1bot/agent/sessions/${session.id}/messages`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            noReply: true,
            context: {
              page: {
                platform: "gitlab",
                pageType: "repo",
                objectKey: "group/project",
              },
            },
            parts: [
              {
                type: "text",
                text: "blocked controller request",
              },
            ],
          }),
        })

        expect(response.status).toBe(409)
        const body = (await response.json()) as {
          accepted: boolean
          busy?: boolean
          turnSnapshotId?: string
        }
        expect(body.accepted).toBe(false)
        expect(body.busy).toBe(true)
        expect(typeof body.turnSnapshotId).toBe("string")

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)
        expect(await RuntimeContextEvents.list({ sessionID: session.id, projectID: session.projectID })).toHaveLength(0)

        SessionPrompt.cancel(session.id)
        SessionPrompt._testing.release(session.id, lease.id)
        await Session.remove(session.id)
      },
    })
  })
})

function restoreEnv(snapshot: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function registeredToolDefinition(id: string): RuntimeToolRegistry.Definition {
  return {
    id,
    description: `Use ${id}`,
    catalogVisibility: "declared-only",
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
  }
}
