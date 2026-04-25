import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
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
