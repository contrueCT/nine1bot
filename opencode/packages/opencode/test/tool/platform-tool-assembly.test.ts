import { afterEach, describe, expect, test } from "bun:test"
import type { ToolCallOptions } from "ai"
import type { Provider } from "../../src/provider/provider"
import type { RuntimeToolCatalog } from "../../src/runtime/tool/catalog"
import { PlatformToolAssembly } from "../../src/runtime/tool/assembly"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"
import { LLM } from "../../src/session/llm"

describe("PlatformToolAssembly", () => {
  afterEach(() => {
    RuntimeToolRegistry.clearForTesting()
  })

  test("keeps existing tools and silently filters every conflict and hard deny", async () => {
    const references = [
      reference("demo_unique"),
      reference("demo_native_conflict"),
      reference("demo_plugin_conflict"),
      reference("demo_mcp_conflict"),
      reference("demo_denied"),
    ]

    const result = await PlatformToolAssembly.create({
      references,
      occupiedToolIDs: new Set([
        "demo_native_conflict",
        "demo_plugin_conflict",
        "demo_mcp_conflict",
      ]),
      model: testModel(),
      isExposureDenied: async (toolID) => toolID === "demo_denied",
      executionInput() {
        throw new Error("not executed")
      },
    })

    expect(Object.keys(result.tools)).toEqual(["demo_unique"])
    expect(result.conflicts.map((item) => item.resourceID)).toEqual([
      "demo_mcp_conflict",
      "demo_native_conflict",
      "demo_plugin_conflict",
    ])
    expect(result.hardDeniedToolIDs).toEqual(["demo_denied"])
  })

  test("passes JSON Schema through the provider transform", async () => {
    const result = await PlatformToolAssembly.create({
      references: [reference("demo_schema", {
        inputSchema: {
          type: "object",
          properties: {
            nodes: { type: "array" },
          },
        },
      })],
      occupiedToolIDs: new Set(),
      model: testModel(),
      isExposureDenied: async () => false,
      executionInput() {
        throw new Error("not executed")
      },
    })

    const schema = (result.tools.demo_schema as any).inputSchema.jsonSchema
    expect(schema.properties.nodes.items).toBeDefined()
  })

  test("routes invocation through the executor with real hook identifiers", async () => {
    const events: string[] = []
    const registered = RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [{
        id: "demo_lookup",
        description: "Look up a demo item",
        catalogVisibility: "declared-only",
        inputSchema: { type: "object" },
        parse(input) {
          return input as { value: string }
        },
        async execute(input) {
          events.push(`execute:${input.value}`)
          return { status: "ok", title: "Lookup", output: input.value }
        },
      }],
    })
    const toolReference = RuntimeToolRegistry.get("demo_lookup")!
    const reference: RuntimeToolCatalog.ResolvedReference = {
      id: toolReference.id,
      ownerID: toolReference.ownerID,
      generation: registered.generation!,
      definition: toolReference.definition,
      availability: { status: "available" },
    }
    const result = await PlatformToolAssembly.create({
      references: [reference],
      occupiedToolIDs: new Set(),
      model: testModel(),
      isExposureDenied: async () => false,
      executionInput(current, rawInput, options) {
        const hook = {
          tool: current.id,
          sessionID: "session_test",
          callID: options.toolCallId,
        }
        return {
          reference: current,
          rawInput,
          call: {
            sessionId: hook.sessionID,
            projectId: "project_test",
            directory: "C:\\project",
            agent: "build",
            templateIds: ["browser-demo"],
            messageId: "message_test",
            callId: hook.callID,
            signal: options.abortSignal ?? new AbortController().signal,
            async reportProgress() {},
          },
          async beforeHook(payload) {
            events.push(`before:${hook.tool}:${hook.sessionID}:${hook.callID}`)
            payload.args = { value: "mutated" }
          },
          async afterHook() {
            events.push(`after:${hook.tool}:${hook.sessionID}:${hook.callID}`)
          },
          async askPermission() {
            events.push(`permission:${hook.tool}`)
          },
          async isExposureDenied() {
            return false
          },
        }
      },
    })

    const output = await result.tools.demo_lookup.execute?.(
      { value: "raw" },
      toolOptions("call_test"),
    )

    expect(output).toMatchObject({ output: "mutated" })
    expect(events).toEqual([
      "before:demo_lookup:session_test:call_test",
      "permission:demo_lookup",
      "execute:mutated",
      "after:demo_lookup:session_test:call_test",
    ])
  })

  test("keeps the model-boundary deny as a final defense for a registered tool ID", () => {
    const tools = {
      demo_lookup: {} as any,
      read: {} as any,
    }

    const filtered = LLM.filterToolsForModel({
      tools,
      userTools: {},
      ruleset: [{ permission: "demo_lookup", pattern: "*", action: "deny" }],
    })

    expect(Object.keys(filtered)).toEqual(["read"])
  })
})

function reference(
  id: string,
  overrides: Partial<RuntimeToolRegistry.Definition<any>> = {},
): RuntimeToolCatalog.ResolvedReference {
  return {
    id,
    ownerID: "demo",
    generation: 1,
    availability: { status: "available" },
    definition: {
      id,
      description: `Use ${id}`,
      catalogVisibility: "declared-only",
      inputSchema: { type: "object" },
      parse(input) {
        return input
      },
      async execute() {
        return { status: "ok", title: id, output: id }
      },
      ...overrides,
    },
  }
}

function testModel() {
  return {
    providerID: "google",
    api: { id: "gemini-3-pro" },
  } as Provider.Model
}

function toolOptions(toolCallId: string): ToolCallOptions {
  return {
    toolCallId,
    messages: [],
    abortSignal: new AbortController().signal,
  }
}
