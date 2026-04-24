import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
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
          headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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
})
