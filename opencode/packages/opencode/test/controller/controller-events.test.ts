import { describe, expect, test } from "bun:test"
import { RuntimeControllerEvents } from "../../src/runtime/controller/events"

describe("RuntimeControllerEvents", () => {
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
})
