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

describe("session prompt routes busy semantics", () => {
  test("message endpoint returns 409 without persisting a queued prompt", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        SessionPrompt._testing.reserve(session.id)
        const beforeMessages = await Session.messages({ sessionID: session.id })

        const response = await app.request(`/session/${session.id}/message`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
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
                text: "blocked over http",
              },
            ],
          }),
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
          name: "BusyError",
          message: `Session ${session.id} is busy`,
          data: {
            sessionID: session.id,
          },
        })

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)
        expect(await RuntimeContextEvents.list({ sessionID: session.id, projectID: session.projectID })).toHaveLength(0)

        SessionPrompt.cancel(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("prompt_async returns 409 without side effects when busy", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        SessionPrompt._testing.reserve(session.id)
        const beforeMessages = await Session.messages({ sessionID: session.id })

        const response = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            parts: [
              {
                type: "text",
                text: "blocked async request",
              },
            ],
          }),
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
          name: "BusyError",
          message: `Session ${session.id} is busy`,
          data: {
            sessionID: session.id,
          },
        })

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)

        SessionPrompt.cancel(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("prompt_async accepts idle noReply requests and persists the message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            noReply: true,
            parts: [
              {
                type: "text",
                text: "accepted async request",
              },
            ],
          }),
        })

        expect(response.status).toBe(204)

        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.role).toBe("user")

        await Session.remove(session.id)
      },
    })
  })

  test("prompt_async writes deduped page context events after busy reservation", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        const repoPage = {
          platform: "gitlab",
          pageType: "repo",
          objectKey: "group/project",
          title: "group/project",
          visibleSummary: "Repository overview",
        }

        const first = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            noReply: true,
            context: {
              page: repoPage,
            },
            parts: [
              {
                type: "text",
                text: "first page-aware request",
              },
            ],
          }),
        })
        expect(first.status).toBe(204)
        expect(await RuntimeContextEvents.list({ sessionID: session.id, projectID: session.projectID })).toHaveLength(1)

        const duplicate = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            noReply: true,
            context: {
              page: repoPage,
            },
            parts: [
              {
                type: "text",
                text: "same page request",
              },
            ],
          }),
        })
        expect(duplicate.status).toBe(204)
        expect(await RuntimeContextEvents.list({ sessionID: session.id, projectID: session.projectID })).toHaveLength(1)

        const mr = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            noReply: true,
            context: {
              page: {
                ...repoPage,
                pageType: "merge-request",
                objectKey: "group/project!123",
                title: "Draft: add runtime context",
              },
            },
            parts: [
              {
                type: "text",
                text: "mr page request",
              },
            ],
          }),
        })
        expect(mr.status).toBe(204)
        const events = await RuntimeContextEvents.list({ sessionID: session.id, projectID: session.projectID })
        expect(events).toHaveLength(2)
        expect(events.map((event) => event.type)).toEqual(["page-enter", "page-enter"])

        await Session.remove(session.id)
      },
    })
  })
})
