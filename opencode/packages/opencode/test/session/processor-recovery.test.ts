import { expect, spyOn, test } from "bun:test"
import { APICallError, streamText } from "ai"
import type { LanguageModelV2 } from "@ai-sdk/provider"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRetry } from "../../src/session/retry"
import { ToolRegistry } from "../../src/tool/registry"
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

for (const outcome of ["compact", "retry", "stop", "success", "overflow", "cancel-retry"] as const) {
  test(`real SDK ${outcome} retires only discarded attempts before a pending tool resumes`, async () => {
    await using tmp = await tmpdir({ config: { snapshot: false, model: "test/test" } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const parent = new AbortController()
        const started = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const settled = Promise.withResolvers<void>()
        let effects = 0
        let resourceCancellations = 0
        let sdkSignal: AbortSignal | undefined
        let streams = 0
        const successful = outcome === "success" || outcome === "overflow"
        const processor = SessionProcessor.create({
          assistantMessage: await assistant(session.id, Identifier.ascending("message")),
          sessionID: session.id,
          model,
          abort: parent.signal,
        })
        const registry = spyOn(ToolRegistry, "resolve").mockResolvedValue({
          declaredIDs: ["pending_tool"],
          conflicts: [],
          tools: [
            {
              id: "pending_tool",
              description: "Pending test tool",
              parameters: z.object({}),
              async execute(_args: unknown, ctx: { abort: AbortSignal }) {
                effects++
                ctx.abort.addEventListener(
                  "abort",
                  () => {
                    resourceCancellations++
                  },
                  { once: true },
                )
                return { title: "Resource started", output: "Resource started", metadata: {} }
              },
            },
          ],
        } as never)
        const mcp = spyOn(MCP, "tools").mockResolvedValue({})
        const sleep = spyOn(SessionRetry, "sleep").mockImplementation(async () => {
          if (outcome === "cancel-retry") parent.abort(new DOMException("Cancelled during retry", "AbortError"))
        })
        const summary = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined)
        const hooks = await Plugin.list()
        const hook = {
          "tool.execute.before": async () => {
            started.resolve()
            await resume.promise
          },
        }
        hooks.push(hook)
        const tools = (
          await SessionPrompt._testing.resolveTools({
            agent: { name: "build", permission: [] } as unknown as Agent.Info,
            model,
            session,
            processor,
            bypassAgentCheck: false,
            messages: [],
            templateIds: [],
            abort: parent.signal,
          })
        ).tools
        const execute = tools.pending_tool.execute!
        tools.pending_tool.execute = async (args, options) => {
          sdkSignal = options.abortSignal
          try {
            return await execute(args, options)
          } finally {
            settled.resolve()
          }
        }
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          const index = streams++
          if (index > 0) {
            expect(sdkSignal?.aborted).toBe(true)
            expect((await MessageV2.parts(processor.message.id)).find((part) => part.type === "tool")).toMatchObject({
              state: { status: "error" },
            })
          }
          const provider: LanguageModelV2 = {
            specificationVersion: "v2",
            provider: "test",
            modelId: "test",
            supportedUrls: {},
            doGenerate: async () => {
              throw new Error("Streaming only")
            },
            doStream: async () => ({
              stream: new ReadableStream({
                async start(controller) {
                  if (index === 0) {
                    controller.enqueue({ type: "tool-input-start", id: "pending_call", toolName: "pending_tool" })
                    controller.enqueue({ type: "tool-input-delta", id: "pending_call", delta: "{}" })
                    controller.enqueue({ type: "tool-input-end", id: "pending_call" })
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: "pending_call",
                      toolName: "pending_tool",
                      input: "{}",
                    })
                    await started.promise
                    if (!successful) {
                      controller.enqueue({
                        type: "error",
                        error:
                          outcome === "compact"
                            ? overflow()
                            : new APICallError({
                                message: "Provider attempt failed",
                                url: "https://example.invalid",
                                requestBodyValues: {},
                                statusCode: outcome === "retry" || outcome === "cancel-retry" ? 503 : 400,
                                isRetryable: outcome === "retry" || outcome === "cancel-retry",
                              }),
                      })
                      controller.close()
                      return
                    }
                  }
                  controller.enqueue({
                    type: "finish",
                    finishReason: index === 0 ? "tool-calls" : "stop",
                    usage: {
                      inputTokens: outcome === "overflow" ? 100_000 : 5,
                      outputTokens: 5,
                      totalTokens: outcome === "overflow" ? 100_005 : 10,
                    },
                  })
                  controller.close()
                },
              }),
            }),
          }
          return streamText({
            model: provider,
            tools,
            abortSignal: input.abort,
            prompt: "Run the pending tool",
            maxRetries: 0,
            onError: () => {},
          }) as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          const processing = processor.process({} as LLM.StreamInput)
          await started.promise
          if (successful) resume.resolve()
          const expected =
            outcome === "retry" || outcome === "success"
              ? "continue"
              : outcome === "overflow"
                ? "compact"
                : outcome === "cancel-retry"
                  ? "stop"
                  : outcome
          expect(await processing).toBe(expected)
          expect(processor.message.time.completed).toBeNumber()
          expect(parent.signal.aborted).toBe(outcome === "cancel-retry")
          expect(sdkSignal?.aborted).toBe(!successful)
          expect(streams).toBe(outcome === "retry" ? 2 : 1)
          resume.resolve()
          await settled.promise
          expect(effects).toBe(successful ? 1 : 0)
          expect(resourceCancellations).toBe(0)
          const part = (await MessageV2.parts(processor.message.id)).find((part) => part.type === "tool")
          expect(part).toMatchObject({ state: { status: successful ? "completed" : "error" } })
          if (!successful) expect(processor.partFromToolCall("pending_call")).toBeUndefined()
        } finally {
          resume.resolve()
          hooks.splice(hooks.indexOf(hook), 1)
          stream.mockRestore()
          registry.mockRestore()
          mcp.mockRestore()
          sleep.mockRestore()
          summary.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })
}
