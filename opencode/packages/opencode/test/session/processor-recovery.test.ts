import { expect, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import type { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionSummary } from "../../src/session/summary"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

const model = {
  id: "test",
  providerID: "test",
  api: { id: "test", npm: "@ai-sdk/openai-compatible", url: "https://example.invalid" },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100000, input: 90000, output: 1000 },
} as Provider.Model

async function assistant(sessionID: string, parentID: string, summary = false) {
  return (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID,
    sessionID,
    role: "assistant",
    agent: "build",
    mode: "build",
    summary,
    modelID: model.id,
    providerID: model.providerID,
    path: { cwd: Instance.directory, root: Instance.directory },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })) as MessageV2.Assistant
}

function streamOf(events: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const event of events) yield event
    })(),
  } as unknown as Awaited<ReturnType<typeof LLM.stream>>
}

function overflow() {
  return new APICallError({
    message: "maximum context length exceeded",
    url: "https://example.invalid",
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  })
}

test("real context-length error finalizes partial output and returns a bounded compact result", async () => {
  await using tmp = await tmpdir({ config: { snapshot: false, model: "test/test" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const parentID = Identifier.ascending("message")
      const recovery = { attempts: 0 }
      const first = await assistant(session.id, parentID)
      const stream = spyOn(LLM, "stream").mockImplementation(async () =>
        streamOf([
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", text: "partial response" },
          { type: "tool-input-start", id: "unfinished", toolName: "read" },
          { type: "error", error: overflow() },
        ]),
      )
      try {
        const processor = SessionProcessor.create({
          assistantMessage: first,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
          contextRecovery: recovery,
        })
        expect(await processor.process({} as LLM.StreamInput)).toBe("compact")
        const persisted = await MessageV2.get({ sessionID: session.id, messageID: first.id })
        expect(persisted.info.role).toBe("assistant")
        if (persisted.info.role !== "assistant") throw new Error("Expected assistant message")
        expect(persisted.info.time.completed).toBeNumber()
        expect(persisted.parts.find((part) => part.type === "text")).toMatchObject({ text: "partial response" })
        expect(persisted.parts.find((part) => part.type === "tool")).toMatchObject({
          state: { status: "error", error: "Tool execution aborted" },
        })
        expect(processor.message.error).toBeUndefined()
        expect(recovery.attempts).toBe(1)

        const second = SessionProcessor.create({
          assistantMessage: await assistant(session.id, parentID),
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
          contextRecovery: recovery,
        })
        expect(await second.process({} as LLM.StreamInput)).toBe("stop")
        expect(second.message.error).toMatchObject({ name: "APIError", data: { statusCode: 400 } })
        expect(second.message.time.completed).toBeNumber()
      } finally {
        stream.mockRestore()
        await Session.remove(session.id)
      }
    },
  })
})

test("a compaction summary context error stops instead of requesting recursive compaction", async () => {
  await using tmp = await tmpdir({ config: { snapshot: false, model: "test/test" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const stream = spyOn(LLM, "stream").mockRejectedValue(overflow())
      try {
        const processor = SessionProcessor.create({
          assistantMessage: await assistant(session.id, Identifier.ascending("message"), true),
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })
        expect(await processor.process({} as LLM.StreamInput)).toBe("stop")
        expect(processor.message.error?.name).toBe("APIError")
        expect(processor.message.time.completed).toBeNumber()
      } finally {
        stream.mockRestore()
        await Session.remove(session.id)
      }
    },
  })
})

for (const variant of [
  "identical errors",
  "successful progress",
  "changed input",
  "new user turn",
  "invalid input",
] as const) {
  test(`cross-message failure detection respects ${variant}`, async () => {
    await using tmp = await tmpdir({ config: { snapshot: false, model: "test/test" } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        let parentID = Identifier.ascending("message")
        let events: unknown[] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async () => streamOf(events))
        const summary = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined)
        try {
          for (let index = 0; index < 3; index++) {
            if (variant === "new user turn" && index === 2) parentID = Identifier.ascending("message")
            const message = await assistant(session.id, parentID)
            const callID = `call_${index}`
            const invalid = variant === "invalid input"
            const input = invalid ? '{"bad":' : { path: variant === "changed input" ? `${index}.ts` : "missing.ts" }
            events = [
              { type: "start-step" },
              { type: "text-start", id: "note" },
              { type: "text-delta", id: "note", text: "Trying the tool" },
              { type: "text-end", id: "note" },
              { type: "tool-input-start", id: callID, toolName: "read" },
              {
                type: "tool-call",
                toolCallId: callID,
                toolName: "read",
                input,
                invalid,
                error: invalid ? new Error("invalid input") : undefined,
              },
              ...(invalid
                ? []
                : variant === "successful progress" && index === 1
                  ? [
                      {
                        type: "tool-result",
                        toolCallId: callID,
                        toolName: "read",
                        input,
                        output: { title: "read", output: "found content", metadata: {} },
                      },
                    ]
                  : [
                      {
                        type: "tool-error",
                        toolCallId: callID,
                        toolName: "read",
                        input,
                        error: new Error("file missing"),
                      },
                    ]),
              {
                type: "finish-step",
                finishReason: "tool-calls",
                usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
              },
            ]
            const processor = SessionProcessor.create({
              assistantMessage: message,
              sessionID: session.id,
              model,
              abort: new AbortController().signal,
            })
            expect(await processor.process({} as LLM.StreamInput)).toBe("continue")
          }
          expect(SessionProcessor.getDoomLoopCount(session.id)).toBe(
            variant === "identical errors" || variant === "invalid input" ? 1 : 0,
          )
        } finally {
          stream.mockRestore()
          summary.mockRestore()
          SessionProcessor.resetDoomLoopCount(session.id)
          await Session.remove(session.id)
        }
      },
    })
  })
}
