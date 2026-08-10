import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ToolCallOptions } from "ai"
import type {
  AnyPlatformToolDefinition,
  PlatformAdapterContribution,
  PlatformAdapterContext,
} from "../../../../../packages/platform-protocol/src"
import { PlatformAdapterManager } from "../../../../../packages/nine1bot/src/platform/manager"
import { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { ControllerTemplateResolver } from "../../src/runtime/controller/template-resolver"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import { SessionProfileCompiler } from "../../src/runtime/session/profile-compiler"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"
import { PlatformToolAssembly } from "../../src/runtime/tool/assembly"
import { RuntimeToolCatalog } from "../../src/runtime/tool/catalog"
import {
  RuntimeToolRegistrationError,
  RuntimeToolRegistry,
} from "../../src/runtime/tool/registry"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

const ownerID = "test-platform"
const toolID = "test_platform_lookup"
const secondToolID = "test_platform_lookup_v2"

describe("platform tool registration lifecycle", () => {
  beforeEach(resetRuntime)
  afterEach(async () => {
    resetRuntime()
    await Instance.disposeAll().catch(() => undefined)
  })

  test("keeps profiles stable while the platform runtime reloads, disables, and recovers", async () => {
    const fixtureSecret = "fixture-platform-secret-value"
    const contribution = testContribution(fixtureSecret)
    const manager = new PlatformAdapterManager({
      contributions: [contribution],
      config: {
        [ownerID]: {
          enabled: true,
          settings: {
            version: "one",
            includeV2: false,
          },
        },
      },
    })

    manager.registerRuntimeAdapters()
    expect(RuntimeToolRegistry.get(toolID)).toMatchObject({
      ownerID,
      generation: 1,
    })

    await using project = await tmpdir({
      git: true,
      config: {
        model: "test-provider/test-model",
      },
    })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const template = await ControllerTemplateResolver.resolve({
          entry: {
            source: "web",
            templateIds: ["test-platform-page"],
          },
        })
        const profile = await SessionProfileCompiler.compile({
          source: "new-session",
          profileTemplate: template.profileTemplate,
        })

        expect(template.resourcesPreview.registeredTools).toEqual([toolID])
        expect(profile.resources.registeredTools?.tools).toEqual([toolID])
        const serializedProfile = JSON.stringify(profile)
        for (const forbidden of [fixtureSecret, "inputSchema", "parse", "execute", "generation"]) {
          expect(serializedProfile).not.toContain(forbidden)
        }

        const firstTurn = await resolveProfile(profile, project.path)
        const firstReference = firstTurn.registeredTools.availableTools[0]
        expect(firstReference).toMatchObject({ id: toolID, ownerID, generation: 1 })
        const firstOutput = await executeReference(firstReference!, "raw-query")
        expect(firstOutput).toMatchObject({
          title: "Test lookup",
          output: "lookup:one:raw-query",
          metadata: { truncated: false },
        })

        await manager.updateConfig(ownerID, {
          settings: { includeV2: true },
        })
        expect(RuntimeToolRegistry.listOwner(ownerID).tools.map((tool) => tool.id).sort()).toEqual([
          toolID,
          secondToolID,
        ])
        const oldProfileAfterToolAdded = await resolveProfile(profile, project.path)
        expect(oldProfileAfterToolAdded.registeredTools.availableTools.map((tool) => tool.id)).toEqual([toolID])
        expect(oldProfileAfterToolAdded.registeredTools.availableTools[0]?.generation).toBe(2)

        await manager.updateConfig(ownerID, {
          settings: { version: "two" },
        })
        const reloadedTurn = await resolveProfile(profile, project.path)
        const reloadedReference = reloadedTurn.registeredTools.availableTools[0]
        expect(reloadedReference?.generation).toBe(3)
        expect(await executeReference(reloadedReference!, "next-query")).toMatchObject({
          title: "Test lookup",
          output: "lookup:two:next-query",
          metadata: { truncated: false },
        })

        await manager.updateConfig(ownerID, { enabled: false })
        const disabledReservation = RuntimeToolRegistry.lookupReservation(toolID)
        expect(disabledReservation).toMatchObject({
          ownerID,
          active: false,
        })
        const disabledTurn = await resolveProfile(profile, project.path)
        expect(disabledTurn.registeredTools.availableTools).toEqual([])
        expect(disabledTurn.failures).toContainEqual(expect.objectContaining({
          resourceType: "tool",
          resourceID: toolID,
          code: "tool-missing",
        }))

        expect(() => RuntimeToolRegistry.registerOwner({
          owner: { id: "test.platform", kind: "platform", enabled: true },
          tools: [lookupDefinition({
            secret: "other-owner-secret",
            version: "other",
          })],
        })).toThrow(RuntimeToolRegistrationError)
        expect(RuntimeToolRegistry.lookupReservation(toolID)).toMatchObject({ ownerID, active: false })

        await manager.updateConfig(ownerID, { enabled: true })
        const restoredTurn = await resolveProfile(profile, project.path)
        const restoredReference = restoredTurn.registeredTools.availableTools[0]
        expect(restoredReference).toMatchObject({ id: toolID, ownerID })
        expect(restoredReference!.generation).toBeGreaterThan(disabledReservation!.generation)
        expect(restoredTurn.registeredTools.availableTools.map((tool) => tool.id)).not.toContain(secondToolID)

        const catalog = await RuntimeToolCatalog.listSelectable({
          context: {
            sessionId: "catalog-test",
            projectId: Instance.project.id,
            directory: project.path,
            agent: profile.agent.name,
            templateIds: profile.sourceTemplateIds,
          },
          occupiedToolIDs: new Set(),
          isExposureDenied: async () => false,
        })
        const diagnosticJson = JSON.stringify({
          detail: await manager.getDetail(ownerID),
          profile,
          audit: restoredTurn.audit,
          catalog,
        })
        for (const forbidden of [
          fixtureSecret,
          "raw-query",
          "next-query",
          "lookup:one:raw-query",
          "lookup:two:next-query",
          "inputSchema",
          "execute",
        ]) {
          expect(diagnosticJson).not.toContain(forbidden)
        }
      },
    })

    manager.unregisterRuntimeAdapters()
  }, 30_000)

  test("assembles registered tools through the real session prompt and preserves native conflicts", async () => {
    RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [lookupDefinition({ secret: "fixture", version: "prompt" }, "demo_lookup")],
    })
    RuntimeToolRegistry.registerOwner({
      owner: { id: "display", kind: "platform", enabled: true },
      tools: [lookupDefinition({ secret: "fixture", version: "collision" }, "display_file")],
    })

    await using project = await tmpdir({
      git: true,
      config: { model: "test-provider/test-model" },
    })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "demo_lookup", pattern: "*", action: "allow" }],
        })
        const agent = await Agent.mustGet("build")
        const demo = resolvedReference("demo_lookup")
        const collision = resolvedReference("display_file")
        const resources = resolvedResources([demo, collision])

        const resolved = await SessionPrompt._testing.resolveTools({
          agent,
          session,
          model: testModel(),
          processor: {
            message: { id: "message_prompt_integration" },
            partFromToolCall: () => undefined,
          } as never,
          bypassAgentCheck: false,
          messages: [],
          resources,
          templateIds: ["test-platform-page"],
          abort: new AbortController().signal,
        })

        expect(resolved.tools.demo_lookup).toBeDefined()
        expect(await resolved.tools.demo_lookup!.execute!(
          { query: "wired" },
          toolOptions("call-prompt-integration"),
        )).toMatchObject({
          title: "Test lookup",
          output: "lookup:prompt:wired",
        })
        expect(resolved.tools.display_file).toBeDefined()
        expect(resolved.resources?.registeredTools.availableTools.map((tool) => tool.id)).toEqual(["demo_lookup"])
        expect(resolved.resources?.failures).toContainEqual(expect.objectContaining({
          resourceID: "display_file",
          code: "tool-conflict",
        }))
      },
    })
  }, 30_000)
})

function testContribution(secret: string): PlatformAdapterContribution {
  return {
    descriptor: {
      id: ownerID,
      name: "Test Platform",
      packageName: "@nine1bot/platform-test",
      version: "0.0.0-test",
      defaultEnabled: true,
      capabilities: {
        templates: ["test-platform-page"],
        resources: true,
      },
    },
    runtime: {
      createAdapter: () => ({
        id: ownerID,
        resourceContributions: ({ templateIds }) => templateIds.includes("test-platform-page")
          ? {
              ...RuntimeResourceResolver.emptyResources(),
              registeredTools: {
                tools: [toolID],
                lifecycle: "session",
                mergeMode: "additive-only",
              },
            }
          : undefined,
      }),
      tools(context) {
        const client = fixtureClient(context, secret)
        const tools = [lookupDefinition(client)]
        if ((context.settings as Record<string, unknown>).includeV2 === true) {
          tools.push(lookupDefinition(client, secondToolID))
        }
        return tools
      },
    },
  }
}

function fixtureClient(context: PlatformAdapterContext, secret: string) {
  return {
    secret,
    version: String((context.settings as Record<string, unknown>).version ?? "one"),
  }
}

function lookupDefinition(
  client: { secret: string; version: string },
  id = toolID,
): AnyPlatformToolDefinition {
  return {
    id,
    description: `Look up a value with ${id}`,
    catalogVisibility: "user-selectable",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parse(input) {
      if (!input || typeof input !== "object" || typeof (input as { query?: unknown }).query !== "string") {
        throw new Error("invalid query")
      }
      return { query: (input as { query: string }).query }
    },
    async execute(input: { query: string }) {
      void client.secret
      return {
        status: "ok",
        title: "Test lookup",
        output: `lookup:${client.version}:${input.query}`,
      }
    },
  }
}

async function resolveProfile(
  profile: Awaited<ReturnType<typeof SessionProfileCompiler.compile>>,
  directory: string,
) {
  return RuntimeResourceResolver.resolve({
    sessionID: "platform-tool-lifecycle",
    profile,
    projectID: Instance.project.id,
    directory,
    agent: profile.agent.name,
    templateIds: profile.sourceTemplateIds,
    emitFailures: false,
    emitResolved: false,
  })
}

async function executeReference(
  reference: RuntimeToolCatalog.ResolvedReference,
  query: string,
) {
  const assembly = await PlatformToolAssembly.create({
    references: [reference],
    occupiedToolIDs: new Set(),
    model: testModel(),
    isExposureDenied: async () => false,
    executionInput(current, rawInput, options) {
      return {
        reference: current,
        rawInput,
        call: {
          sessionId: "platform-tool-lifecycle",
          projectId: Instance.project.id,
          directory: Instance.directory,
          agent: "build",
          templateIds: ["test-platform-page"],
          messageId: "message-test",
          callId: options.toolCallId,
          signal: options.abortSignal ?? new AbortController().signal,
          async reportProgress() {},
        },
        async askPermission() {},
        async isExposureDenied() {
          return false
        },
        async isPermissionDenied() {
          return false
        },
      }
    },
  })
  return assembly.tools[reference.id]!.execute!({ query }, toolOptions(`call-${reference.generation}`))
}

function testModel() {
  return {
    providerID: "google",
    api: { id: "gemini-3-pro" },
  } as Provider.Model
}

function resolvedReference(id: string): RuntimeToolCatalog.ResolvedReference {
  const registered = RuntimeToolRegistry.get(id)
  if (!registered) throw new Error(`Missing registered tool fixture: ${id}`)
  return {
    id: registered.id,
    ownerID: registered.ownerID,
    generation: registered.generation,
    definition: registered.definition,
    availability: { status: "available" },
  }
}

function resolvedResources(
  references: RuntimeToolCatalog.ResolvedReference[],
): RuntimeResourceResolver.Resolved {
  const ids = references.map((reference) => reference.id)
  const availability = Object.fromEntries(ids.map((id) => [id, {
    declared: true,
    status: "available" as const,
    checkedAt: Date.now(),
  }]))
  return {
    builtinTools: {},
    registeredTools: {
      declaredTools: ids,
      availableTools: references,
      availability,
    },
    mcp: {
      declaredServers: [],
      availableServers: [],
      availability: {},
    },
    skills: {
      declaredSkills: [],
      availableSkills: [],
      availability: {},
    },
    failures: [],
    audit: {
      declared: { mcp: [], skills: [], registeredTools: ids },
      resolved: { mcp: [], skills: [], registeredTools: ids },
      unavailable: [],
    },
  }
}

function toolOptions(toolCallId: string): ToolCallOptions {
  return {
    toolCallId,
    messages: [],
    abortSignal: new AbortController().signal,
  }
}

function resetRuntime() {
  RuntimeToolRegistry.clearForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
  RuntimeSourceRegistry.clearForTesting()
}
