import { expect, spyOn, test } from "bun:test"
import { streamText, tool, simulateReadableStream, NoSuchToolError } from "ai"
import type { LanguageModelV2 } from "@ai-sdk/provider"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { LLM } from "../../src/session/llm"
import { SessionSummary } from "../../src/session/summary"
import type { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"

test("tool repair stays within the supplied catalog and preserves an available fallback", async () => {
  const request: Parameters<typeof LLM.repairToolCall>[0] = {
    system: undefined, messages: [], inputSchema: () => ({ type: "object" }),
    toolCall: { type: "tool-call", toolCallId: "call", toolName: "GITLAB_CI_INSPECT", input: '{"action":"list"}' },
    error: new NoSuchToolError({ toolName: "GITLAB_CI_INSPECT" }),
    tools: { gitlab_ci_inspect: tool({ inputSchema: z.object({ action: z.literal("list") }) }) },
  }
  expect(await LLM.repairToolCall(request)).toEqual({ ...request.toolCall, toolName: "gitlab_ci_inspect" })
  const unavailable = { ...request, tools: {} }
  expect(await LLM.repairToolCall(unavailable)).toBeNull()
  const fallback = await LLM.repairToolCall({ ...unavailable, tools: { invalid: tool({ inputSchema: z.object({ tool: z.string(), error: z.string() }) }) } })
  expect(fallback?.toolName).toBe("invalid")
  expect(JSON.parse(fallback!.input)).toEqual({ tool: request.toolCall.toolName, error: request.error.message })
})

test("invalid SDK tool inputs remain tool errors and a corrected call can complete", async () => {
  await using directory = await tmpdir({ config: { snapshot: false, model: "test/test" } })
  await Instance.provide({
    directory: directory.path,
    fn: async () => {
      const session = await Session.create({})
      RuntimeSourceRegistry.registerOwner({
        owner: { id: "gitlab", kind: "platform", enabled: true },
        sources: { agents: [{
          id: "gitlab-review-agents",
          directory: path.resolve(import.meta.dir, "../../../../../packages/platform-gitlab/agents/review"),
          namespace: "gitlab", visibility: "recommendable", lifecycle: "platform-enabled",
        }] },
      })
      const model = {
        id: "test", providerID: "test",
        api: { id: "test", npm: "@ai-sdk/openai-compatible", url: "https://example.invalid" },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 100000, input: 90000, output: 1000 },
      } as Provider.Model
      const message: MessageV2.Assistant = {
        id: Identifier.ascending("message"), parentID: Identifier.ascending("message"),
        sessionID: session.id, role: "assistant", agent: "platform.gitlab.pm-coordinator", mode: "build",
        modelID: model.id, providerID: model.providerID,
        path: { cwd: directory.path, root: directory.path },
        time: { created: Date.now() }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      await Session.updateMessage(message)
      const invalidInputs = ['{"action":', '"not an object"', 'null', '[]', '{"action":"wrong"}', '{"action":', '{"action":', '{"action":']
      const calls = [...invalidInputs, '{"action":"list"}']
      let executions = 0
      const tools = {
        gitlab_ci_inspect: tool({
          inputSchema: z.object({ action: z.literal("list") }).strict(),
          execute: async () => {
            executions++
            return { title: "CI", output: "CI evidence", metadata: {} }
          },
        }),
      }
      const mockModel: LanguageModelV2 = {
        specificationVersion: "v2", provider: "test", modelId: "test", supportedUrls: {},
        doGenerate: async () => { throw new Error("Streaming only") },
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              ...calls.flatMap((input, index) => [
                { type: "tool-input-start" as const, id: `call-${index}`, toolName: "gitlab_ci_inspect" },
                { type: "tool-input-delta" as const, id: `call-${index}`, delta: input },
                { type: "tool-input-end" as const, id: `call-${index}` },
                { type: "tool-call" as const, toolCallId: `call-${index}`, toolName: "gitlab_ci_inspect", input },
              ]),
              { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
            ],
          }),
        }),
      }
      const stream = spyOn(LLM, "stream").mockImplementation(async () => streamText({
        model: mockModel, tools, prompt: "Inspect CI", maxRetries: 0,
        experimental_repairToolCall: LLM.repairToolCall,
      }) as unknown as Awaited<ReturnType<typeof LLM.stream>>)
      const summary = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined)
      try {
        const processor = SessionProcessor.create({ assistantMessage: message, sessionID: session.id, model, abort: new AbortController().signal })
        expect(await processor.process({} as LLM.StreamInput)).toBe("continue")
        expect(processor.message.error).toBeUndefined()
        expect(executions).toBe(1)
        expect(SessionProcessor.getDoomLoopCount(session.id)).toBe(1)
        const parts = (await MessageV2.parts(message.id)).filter((p): p is MessageV2.ToolPart => p.type === "tool")
        expect(parts).toHaveLength(calls.length)
        for (const [index] of invalidInputs.entries()) {
          const part = parts.find((p) => p.callID === `call-${index}`)!
          expect(part.state.status).toBe("error")
          expect(typeof part.state.input).toBe("object")
          expect(Array.isArray(part.state.input)).toBe(false)
          if (part.state.status === "error") expect(part.state.error).toContain("Invalid input for tool gitlab_ci_inspect")
        }
        expect(parts.find((p) => p.callID === `call-${invalidInputs.length}`)?.state).toMatchObject({
          status: "completed", input: { action: "list" }, output: "CI evidence",
        })
      } finally {
        stream.mockRestore()
        summary.mockRestore()
        SessionProcessor.resetDoomLoopCount(session.id)
        await Session.remove(session.id)
        RuntimeSourceRegistry.clearForTesting()
      }
    },
  })
})
