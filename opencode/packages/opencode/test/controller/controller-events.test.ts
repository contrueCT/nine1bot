import { describe, expect, test } from "bun:test"
import { RuntimeControllerEvents } from "../../src/runtime/controller/events"

describe("RuntimeControllerEvents", () => {
  test("projects compact part deltas without a full part payload", () => {
    const [event] = RuntimeControllerEvents.project({
      type: "message.part.delta",
      properties: {
        sessionID: "session_test",
        messageID: "message_test",
        partID: "part_test",
        field: "text",
        delta: "hello",
      },
    })

    expect(event?.type).toBe("runtime.message.part.delta")
    expect(event?.data).toEqual({
      messageId: "message_test",
      partId: "part_test",
      field: "text",
      delta: "hello",
    })
  })

  test("projects question and permission requests into interaction envelopes", () => {
    const question = RuntimeControllerEvents.project({
      type: "question.asked",
      properties: {
        id: "question_test",
        sessionID: "session_test",
        questions: [
          {
            header: "Pick",
            question: "Choose one",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    })

    expect(question).toHaveLength(1)
    expect(question[0]?.type).toBe("runtime.interaction.requested")
    expect(question[0]?.data).toMatchObject({
      kind: "question",
      requestId: "question_test",
    })

    const permission = RuntimeControllerEvents.project({
      type: "permission.asked",
      properties: {
        id: "permission_test",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["npm test"],
        always: ["npm *"],
      },
    })

    expect(permission).toHaveLength(1)
    expect(permission[0]?.type).toBe("runtime.interaction.requested")
    expect(permission[0]?.data).toMatchObject({
      kind: "permission",
      requestId: "permission_test",
      options: ["allow-once", "allow-session", "deny"],
    })

    const cancelled = RuntimeControllerEvents.project({
      type: "permission.cancelled",
      properties: {
        sessionID: "session_test",
        requestID: "permission_test",
        reason: "timeout",
      },
    })

    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.type).toBe("runtime.interaction.cancelled")
    expect(cancelled[0]?.data).toEqual({
      kind: "permission",
      requestId: "permission_test",
      reason: "timeout",
    })
  })

  test("projects tool attachments and previews into artifact envelopes", () => {
    const tool = RuntimeControllerEvents.project({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_tool",
          messageID: "message_test",
          sessionID: "session_test",
          type: "tool",
          tool: "send_file",
          callID: "call_test",
          state: {
            status: "completed",
            input: {},
            output: "sent",
            title: "Send file",
            metadata: {},
            time: {
              start: 1,
              end: 2,
            },
            attachments: [
              {
                id: "part_file",
                messageID: "message_test",
                sessionID: "session_test",
                type: "file",
                mime: "image/png",
                filename: "result.png",
                url: "file:///tmp/result.png",
              },
            ],
          },
        },
      },
    })

    expect(tool.map((event) => event.type)).toEqual([
      "runtime.message.part.updated",
      "runtime.artifact.available",
    ])
    expect(tool[1]?.data).toMatchObject({
      artifactId: "part_file",
      kind: "image",
      filename: "result.png",
      source: {
        type: "tool-call",
        tool: "send_file",
        callId: "call_test",
      },
    })

    const preview = RuntimeControllerEvents.project({
      type: "file-preview.open",
      properties: {
        id: "preview_test",
        sessionID: "session_test",
        path: "C:/tmp/report.md",
        filename: "report.md",
        mime: "text/markdown",
        content: "IyBUZXN0",
        size: 6,
        interactive: false,
      },
    })

    expect(preview).toHaveLength(1)
    expect(preview[0]?.type).toBe("runtime.artifact.available")
    expect(preview[0]?.data).toMatchObject({
      artifactId: "preview_test",
      kind: "preview",
      filename: "report.md",
      preview: {
        inlineContentBase64: "IyBUZXN0",
      },
    })
  })

  test("passes through direct runtime turn and tool events", () => {
    const turnCompleted = RuntimeControllerEvents.project({
      type: "runtime.turn.completed",
      properties: {
        sessionID: "session_test",
        turnSnapshotId: "turn_test",
        providerID: "openai",
        modelID: "gpt-5.4",
        finishReason: "stop",
        costUsd: 0.12,
        completedAt: 123,
      },
    })

    expect(turnCompleted).toHaveLength(1)
    expect(turnCompleted[0]?.type).toBe("runtime.turn.completed")
    expect(turnCompleted[0]?.data).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.4",
      finishReason: "stop",
      costUsd: 0.12,
    })

    const turnCancelled = RuntimeControllerEvents.project({
      type: "runtime.turn.cancelled",
      properties: {
        sessionID: "session_test",
        turnSnapshotId: "turn_cancelled",
        cancelledAt: 456,
        reason: "user-requested",
      },
    })

    expect(turnCancelled).toHaveLength(1)
    expect(turnCancelled[0]?.type).toBe("runtime.turn.cancelled")
    expect(turnCancelled[0]?.data).toMatchObject({
      cancelledAt: 456,
      reason: "user-requested",
    })

    const toolCompleted = RuntimeControllerEvents.project({
      type: "runtime.tool.completed",
      properties: {
        sessionID: "session_test",
        turnSnapshotId: "turn_test_2",
        messageID: "message_test",
        partID: "part_test",
        tool: "read_file",
        toolCallId: "call_test",
        startedAt: 10,
        finishedAt: 25,
        durationMs: 15,
      },
    })

    expect(toolCompleted).toHaveLength(1)
    expect(toolCompleted[0]?.type).toBe("runtime.tool.completed")
    expect(toolCompleted[0]?.data).toMatchObject({
      tool: "read_file",
      toolCallId: "call_test",
      durationMs: 15,
    })
  })

  test("does not synthesize terminal events from legacy idle or error notifications", () => {
    RuntimeControllerEvents.bindTurn("session_idle_test", "turn_idle_test")
    expect(
      RuntimeControllerEvents.project({
        type: "session.idle",
        properties: {
          sessionID: "session_idle_test",
        },
      }),
    ).toEqual([])

    RuntimeControllerEvents.bindTurn("session_error_test", "turn_error_test")
    expect(
      RuntimeControllerEvents.project({
        type: "session.error",
        properties: {
          sessionID: "session_error_test",
          error: { message: "failed" },
        },
      }),
    ).toEqual([])

    RuntimeControllerEvents.clearTurn("session_idle_test", "turn_idle_test")
    RuntimeControllerEvents.clearTurn("session_error_test", "turn_error_test")
  })
})
