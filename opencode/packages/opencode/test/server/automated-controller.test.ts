import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { SessionStatus } from "../../src/session/status"
import { PermissionNext } from "../../src/permission/next"
import {
  createAndSendAutomatedControllerTurn,
  startAutomatedRunMonitor,
  type AutomatedInteractionPolicy,
} from "../../src/server/routes/automated-controller"
import { tmpdir } from "../fixture/fixture"

const interactionPolicy: AutomatedInteractionPolicy = {
  permission: "deny",
  question: "deny",
  permissionAllowMessage: "allowed",
  permissionDenyMessage: "denied",
  questionDenyMessage: "denied",
}

describe("automated controller session startup", () => {
  test("binds the created session before sending the first message", async () => {
    const events: string[] = []
    let boundSession: string | undefined

    const result = await createAndSendAutomatedControllerTurn({
      async createSession() {
        return { sessionId: "session-review-1", marker: "created" }
      },
      async onSessionCreated({ sessionID }) {
        events.push("session-bound")
        boundSession = sessionID
      },
      async sendMessage(sessionID) {
        expect(sessionID).toBe("session-review-1")
        expect(boundSession).toBe(sessionID)
        events.push("message-sent")
        return { marker: "sent" }
      },
    })

    expect(events).toEqual(["session-bound", "message-sent"])
    expect(result).toEqual({
      sessionResponse: { sessionId: "session-review-1", marker: "created" },
      messageResponse: { marker: "sent" },
    })
  })

  test("subscribes to a fast idle event before sending the first message", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const finished: Array<{ status: string; error?: string }> = []

        await createAndSendAutomatedControllerTurn({
          async createSession() {
            return { sessionId: "session-fast-idle" }
          },
          startMonitor(sessionID) {
            return startAutomatedRunMonitor({
              sessionID,
              timeoutMs: 1_000,
              interactionPolicy,
              async onFinished(result) {
                finished.push(result)
              },
            })
          },
          async sendMessage(sessionID) {
            await Bus.publish(SessionStatus.Event.Idle, { sessionID })
            return { marker: "sent" }
          },
        })

        expect(finished).toEqual([{ status: "succeeded" }])
      },
    })
  })

  test("finishes once and disposes the monitor when the first send fails", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const finished: Array<{ status: string; error?: string }> = []

        const run = createAndSendAutomatedControllerTurn({
          async createSession() {
            return { sessionId: "session-send-failure" }
          },
          startMonitor(sessionID) {
            return startAutomatedRunMonitor({
              sessionID,
              timeoutMs: 20,
              timeoutMessage: "monitor timeout",
              interactionPolicy,
              async onFinished(result) {
                finished.push(result)
              },
            })
          },
          async sendMessage() {
            throw new Error("first send failed")
          },
        })

        await expect(run).rejects.toThrow("first send failed")
        await Bus.publish(SessionStatus.Event.Idle, { sessionID: "session-send-failure" })
        await Bun.sleep(40)

        expect(finished).toEqual([{ status: "failed", error: "first send failed" }])
      },
    })
  })

  test("cancels the active session exactly once when the monitor times out", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cancelled: string[] = []
        const finished: Array<{ status: string; error?: string }> = []
        startAutomatedRunMonitor({
          sessionID: "session-timeout-cancel",
          timeoutMs: 10,
          timeoutMessage: "monitor timeout",
          interactionPolicy,
          cancelSession(sessionID) {
            cancelled.push(sessionID)
          },
          async onFinished(result) {
            finished.push(result)
          },
        })

        await Bun.sleep(40)
        await Bus.publish(SessionStatus.Event.Idle, { sessionID: "session-timeout-cancel" })

        expect(cancelled).toEqual(["session-timeout-cancel"])
        expect(finished).toEqual([{ status: "failed", error: "monitor timeout" }])
      },
    })
  })

  test("denies security-critical permissions under an allow-session policy", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const interactions: Array<{ requestID: string; action: string }> = []
        const monitor = startAutomatedRunMonitor({
          sessionID: "session-permission-boundary",
          timeoutMs: 1_000,
          interactionPolicy: { ...interactionPolicy, permission: "allow-session" },
          async onInteraction(interaction) {
            interactions.push({ requestID: interaction.requestID, action: interaction.action })
          },
        })

        await Bus.publish(PermissionNext.Event.Asked, {
          id: "permission_monitor_read",
          sessionID: "session-permission-boundary",
          permission: "gitlab_cli_read",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })
        await Bus.publish(PermissionNext.Event.Asked, {
          id: "permission_monitor_publish",
          sessionID: "session-permission-boundary",
          permission: "gitlab_cli_publish_review_note",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })
        monitor.dispose()

        expect(interactions).toEqual([
          { requestID: "permission_monitor_read", action: "allow-session" },
          { requestID: "permission_monitor_publish", action: "deny" },
        ])
      },
    })
  })
})
