import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { RuntimeContextEvents } from "../../src/runtime/context/events"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
const jsonHeaders = {
  "Content-Type": "application/json",
  "x-opencode-directory": projectRoot,
}
Log.init({ print: false })

describe("nine1bot controller api", () => {
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
        }

        expect(body.templateIds).toContain("feishu-chat")
        expect(body.profileSnapshot?.sourceTemplateIds).toContain("feishu-chat")
        expect(body.profileSnapshot?.context.blocks.some((block) => block.source === "template.feishu-chat")).toBe(true)
        expect(JSON.stringify(body.profileSnapshot)).not.toContain("profileSnapshotId")

        await Session.remove(body.sessionId)
      },
    })
  })

  test("busy controller message returns 409 before writing user message or page context", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        SessionPrompt._testing.reserve(session.id)

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
        await Session.remove(session.id)
      },
    })
  })
})
