import { test, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"
import { tmpdir } from "../fixture/fixture"

function testProfile(resources: SessionProfileSnapshot["resources"]): SessionProfileSnapshot {
  return {
    id: "profile_test",
    sessionId: "session_test",
    createdAt: Date.now(),
    source: "new-session",
    sourceTemplateIds: ["test", RuntimeResourceResolver.resourceTemplateId()],
    agent: {
      name: "build",
      source: "default-user-template",
    },
    defaultModel: {
      providerID: "test",
      modelID: "test",
      source: "default-user-template",
    },
    context: {
      blocks: [],
    },
    resources,
    permissions: {
      rules: {},
      source: ["test"],
      mergeMode: "strict",
    },
    sessionPermissionGrants: [],
    orchestration: {
      mode: "single",
    },
  }
}

test("normalizes a missing registered tool resource to an empty session resource", () => {
  expect(RuntimeResourceResolver.emptyResources().registeredTools).toEqual({
    tools: [],
    lifecycle: "session",
    mergeMode: "additive-only",
  })
})

test("compileProfileResources freezes only enabled MCP server names", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      mcp: {
        enabled_server: {
          type: "local",
          command: ["node", "server.js"],
          enabled: true,
        },
        disabled_server: {
          type: "local",
          command: ["node", "server.js"],
          enabled: false,
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const resources = await RuntimeResourceResolver.compileProfileResources()
      expect(resources.mcp.servers).toContain("enabled_server")
      expect(resources.mcp.servers).not.toContain("disabled_server")
    },
  })
})

test("resolve applies current config as a live gate for declared MCP servers and skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      mcp: {
        disabled_server: {
          type: "local",
          command: ["node", "server.js"],
          enabled: false,
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const profile = testProfile({
        builtinTools: {},
        mcp: {
          servers: ["disabled_server", "missing_server"],
          lifecycle: "session",
          mergeMode: "additive-only",
        },
        skills: {
          skills: ["missing-skill-for-resource-resolver-test"],
          lifecycle: "session",
          mergeMode: "additive-only",
        },
      })

      const resolved = await RuntimeResourceResolver.resolve({
        sessionID: "session_test",
        profile,
      })

      expect(resolved.mcp.availableServers).toEqual([])
      expect(resolved.mcp.availability.disabled_server.reason).toBe("disabled-by-current-config")
      expect(resolved.mcp.availability.missing_server.reason).toBe("disabled-by-current-config")
      expect(resolved.skills.availableSkills).toEqual([])
      expect(resolved.skills.availability["missing-skill-for-resource-resolver-test"].reason).toBe(
        "disabled-by-current-config",
      )
    },
  })
})

test("deduplicates identical tool failures and resets after a successful state change", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      RuntimeToolRegistry.registerOwner({
        owner: { id: "demo", kind: "platform", enabled: true },
        tools: [toolDefinition("demo_lookup")],
      })
      RuntimeToolRegistry.unregisterOwner("demo")

      const profile = testProfile({
        builtinTools: {},
        registeredTools: {
          tools: ["demo_lookup", "demo_lookup"],
          lifecycle: "session",
          mergeMode: "additive-only",
        },
        mcp: {
          servers: [],
          lifecycle: "session",
          mergeMode: "additive-only",
        },
        skills: {
          skills: [],
          lifecycle: "session",
          mergeMode: "additive-only",
        },
      })
      const events: Array<Record<string, unknown>> = []
      const unsubscribe = Bus.subscribe(RuntimeResourceResolver.Failed, (event) => {
        if (event.properties.resourceType === "tool") events.push(event.properties)
      })

      try {
        const first = await RuntimeResourceResolver.resolve({
          sessionID: "session_tool_failure",
          profile,
          emitResolved: false,
        })
        await RuntimeResourceResolver.resolve({
          sessionID: "session_tool_failure",
          profile,
          emitResolved: false,
        })

        expect(first.registeredTools.declaredTools).toEqual(["demo_lookup"])
        expect(first.registeredTools.availableTools).toEqual([])
        expect(events).toEqual([
          expect.objectContaining({
            resourceID: "demo_lookup",
            ownerID: "demo",
            generation: 2,
            code: "tool-missing",
          }),
        ])

        RuntimeToolRegistry.registerOwner({
          owner: { id: "demo", kind: "platform", enabled: true },
          tools: [toolDefinition("demo_lookup")],
        })
        const available = await RuntimeResourceResolver.resolve({
          sessionID: "session_tool_failure",
          profile,
          emitResolved: false,
        })
        expect(available.registeredTools.availableTools.map((tool) => tool.id)).toEqual(["demo_lookup"])
        expect(events).toHaveLength(1)

        RuntimeToolRegistry.unregisterOwner("demo")
        await RuntimeResourceResolver.resolve({
          sessionID: "session_tool_failure",
          profile,
          emitResolved: false,
        })
        expect(events).toHaveLength(2)
        expect(events[1]).toEqual(expect.objectContaining({
          resourceID: "demo_lookup",
          ownerID: "demo",
          generation: 4,
          code: "tool-missing",
        }))
      } finally {
        unsubscribe()
        RuntimeToolRegistry.clearForTesting()
      }
    },
  })
})

test("redacts platform diagnostics before publishing registered tool failures", async () => {
  const secret = "resource-event-secret"
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      RuntimeToolRegistry.registerOwner({
        owner: { id: "eventdemo", kind: "platform", enabled: true },
        tools: [{
          ...toolDefinition("eventdemo_auth"),
          availability: () => ({
            status: "auth-required",
            reason: `token=${secret}`,
            action: {
              type: "start-auth",
              label: `Authenticate with Authorization: Bearer ${secret}`,
            },
          }),
        }],
      })
      const profile = testProfile({
        builtinTools: {},
        registeredTools: {
          tools: ["eventdemo_auth"],
          lifecycle: "session",
          mergeMode: "additive-only",
        },
        mcp: { servers: [], lifecycle: "session", mergeMode: "additive-only" },
        skills: { skills: [], lifecycle: "session", mergeMode: "additive-only" },
      })
      const events: Array<Record<string, unknown>> = []
      const unsubscribe = Bus.subscribe(RuntimeResourceResolver.Failed, (event) => {
        if (event.properties.resourceType === "tool") events.push(event.properties)
      })

      try {
        await RuntimeResourceResolver.resolve({
          sessionID: "session_tool_redaction",
          profile,
          emitResolved: false,
        })

        expect(events).toHaveLength(1)
        expect(JSON.stringify(events)).not.toContain(secret)
        expect(JSON.stringify(events)).toContain("[REDACTED]")
      } finally {
        unsubscribe()
        RuntimeToolRegistry.clearForTesting()
      }
    },
  })
})

function toolDefinition(id: string): RuntimeToolRegistry.Definition {
  return {
    id,
    description: `Fixture tool ${id}.`,
    catalogVisibility: "declared-only",
    inputSchema: { type: "object" },
    parse: (input) => input,
    execute: async () => ({
      status: "ok",
      title: id,
      output: "ok",
    }),
  }
}
