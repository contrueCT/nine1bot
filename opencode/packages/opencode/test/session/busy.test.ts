import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.prompt busy semantics", () => {
  test("marks reserved sessions busy immediately and clears them on cancel", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        SessionPrompt._testing.reserve(session.id)
        expect(SessionStatus.get(session.id).type).toBe("busy")

        SessionPrompt.cancel(session.id)
        expect(SessionStatus.get(session.id).type).toBe("idle")

        await Session.remove(session.id)
      },
    })
  })

  test("rejects busy prompts before cleanup or message persistence", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        SessionPrompt._testing.reserve(session.id)
        await Session.update(session.id, (draft) => {
          draft.revert = {
            messageID: "message_busy_marker",
          }
        })

        const beforeMessages = await Session.messages({ sessionID: session.id })

        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            parts: [
              {
                type: "text",
                text: "blocked while busy",
              },
            ],
          }),
        ).rejects.toBeInstanceOf(Session.BusyError)

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)
        expect((await Session.get(session.id)).revert?.messageID).toBe("message_busy_marker")

        SessionPrompt.cancel(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("rejects busy noReply prompts before persisting a message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        SessionPrompt._testing.reserve(session.id)
        const beforeMessages = await Session.messages({ sessionID: session.id })

        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: "noReply should still be rejected",
              },
            ],
          }),
        ).rejects.toBeInstanceOf(Session.BusyError)

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)

        SessionPrompt.cancel(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("persists idle noReply prompts without leaving the session busy", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "persist without starting the loop",
            },
          ],
        })

        expect(message.info.role).toBe("user")
        expect(SessionStatus.get(session.id).type).toBe("idle")

        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.id).toBe(message.info.id)

        await Session.remove(session.id)
      },
    })
  })
})
