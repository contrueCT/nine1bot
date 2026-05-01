import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { ControllerAgentRunCompiler } from "../../src/runtime/controller/agent-run-compiler"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { ControllerTemplateResolver } from "../../src/runtime/controller/template-resolver"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"
import { SessionProfileCompiler } from "../../src/runtime/session/profile-compiler"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const originalDisablePluginInstall = process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL
const originalDisableGlobalConfig = process.env.OPENCODE_DISABLE_GLOBAL_CONFIG

beforeAll(() => {
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
})

afterAll(() => {
  restoreEnv("OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL", originalDisablePluginInstall)
  restoreEnv("OPENCODE_DISABLE_GLOBAL_CONFIG", originalDisableGlobalConfig)
})

afterEach(() => {
  RuntimeSourceRegistry.clearForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

async function writeAgent(root: string, file: string, input: {
  name: string
  description: string
  mode?: "primary" | "subagent" | "all"
}) {
  await Bun.write(
    path.join(root, file),
    `---
name: ${input.name}
description: ${input.description}
mode: ${input.mode ?? "primary"}
permission:
  read: allow
---

You are ${input.name}.
`,
  )
}

function registerAgentSource(input: {
  id: string
  directory: string
  visibility: "declared-only" | "recommendable" | "user-selectable"
}) {
  RuntimeSourceRegistry.registerOwner({
    owner: {
      id: "gitlab",
      kind: "platform",
      enabled: true,
    },
    sources: {
      agents: [{
        id: input.id,
        directory: input.directory,
        namespace: "gitlab",
        visibility: input.visibility,
        lifecycle: "platform-enabled",
      }],
    },
  })
}

test("platform agent visibility keeps declared and recommendable agents out of the default list", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const declaredDir = path.join(dir, "agents-declared")
      const recommendableDir = path.join(dir, "agents-recommendable")
      const selectableDir = path.join(dir, "agents-selectable")
      await writeAgent(declaredDir, "declared.agent.md", {
        name: "gitlab.declared",
        description: "Declared GitLab agent.",
      })
      await writeAgent(recommendableDir, "recommendable.agent.md", {
        name: "gitlab.recommendable",
        description: "Recommendable GitLab agent.",
      })
      await writeAgent(selectableDir, "selectable.agent.md", {
        name: "gitlab.selectable",
        description: "Selectable GitLab agent.",
      })
      return { declaredDir, recommendableDir, selectableDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      RuntimeSourceRegistry.registerOwner({
        owner: { id: "gitlab", kind: "platform", enabled: true },
        sources: {
          agents: [
            {
              id: "declared",
              directory: tmp.extra.declaredDir,
              visibility: "declared-only",
              lifecycle: "platform-enabled",
            },
            {
              id: "recommendable",
              directory: tmp.extra.recommendableDir,
              visibility: "recommendable",
              lifecycle: "platform-enabled",
            },
            {
              id: "selectable",
              directory: tmp.extra.selectableDir,
              visibility: "user-selectable",
              lifecycle: "platform-enabled",
            },
          ],
        },
      })

      expect((await Agent.list()).map((agent) => agent.name)).toContain("gitlab.selectable")
      expect((await Agent.list()).map((agent) => agent.name)).not.toContain("gitlab.recommendable")
      expect((await Agent.list()).map((agent) => agent.name)).not.toContain("gitlab.declared")
      expect((await Agent.list({ includeRecommendable: true })).map((agent) => agent.name)).toContain(
        "gitlab.recommendable",
      )
      expect((await Agent.list({ includeDeclaredOnly: true })).map((agent) => agent.name)).toEqual(
        expect.arrayContaining(["gitlab.declared", "gitlab.recommendable", "gitlab.selectable"]),
      )
      expect(await Agent.get("gitlab.declared")).toBeUndefined()
      expect(await Agent.get("gitlab.declared", { includeDeclaredOnly: true })).toMatchObject({
        name: "gitlab.declared",
        source: {
          owner: { id: "gitlab", kind: "platform" },
          sourceID: "declared",
          visibility: "declared-only",
        },
      })
      expect(await Agent.defaultAgent()).toBe("build")
    },
  })
})

test("platform agent source unregister invalidates agent lookup cache", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "GitLab review agent.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })

      expect(await Agent.get("gitlab.review", { includeDeclaredOnly: true })).toMatchObject({
        name: "gitlab.review",
      })

      RuntimeSourceRegistry.unregisterOwner("gitlab")

      expect(await Agent.get("gitlab.review", { includeDeclaredOnly: true })).toBeUndefined()
    },
  })
})

test("platform agent source normalizes frontmatter names", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await Bun.write(
        path.join(agentsDir, "trimmed.agent.md"),
        `---
name: " gitlab.trimmed "
description: Trimmed GitLab agent.
mode: primary
permission:
  read: allow
---

You are a trimmed platform agent.
`,
      )
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })

      expect(await Agent.get("gitlab.trimmed", { includeDeclaredOnly: true })).toMatchObject({
        name: "gitlab.trimmed",
      })
      expect(await Agent.get(" gitlab.trimmed ", { includeDeclaredOnly: true })).toBeUndefined()
    },
  })
})

test("platform agent cache is cleared when the current instance is disposed", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "First description.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })

      expect(await Agent.get("gitlab.review", { includeDeclaredOnly: true })).toMatchObject({
        description: "First description.",
      })

      await writeAgent(tmp.extra.agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "Second description.",
      })
      await Instance.dispose()

      expect(await Agent.get("gitlab.review", { includeDeclaredOnly: true })).toMatchObject({
        description: "Second description.",
      })
    },
  })
})

test("session choice can freeze a declared-only platform agent into the profile", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "GitLab review agent.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })

      const profile = await SessionProfileCompiler.compile({
        source: "new-session",
        agentName: "gitlab.review",
      })

      expect(profile.agent).toEqual({
        name: "gitlab.review",
        source: "session-choice",
      })
    },
  })
})

test("template resolver validates platform recommended agents", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "GitLab review agent.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      RuntimePlatformAdapterRegistry.register({
        id: "gitlab",
        recommendedAgent: () => "gitlab.review",
      })
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "recommendable",
      })

      const accepted = await ControllerTemplateResolver.resolve({
        entry: {
          source: "browser-extension",
          platform: "gitlab",
          templateIds: ["browser-gitlab"],
        },
      })
      expect(accepted.recommendedAgent).toBe("gitlab.review")
      expect(accepted.audit.agentRecommendation).toEqual(expect.objectContaining({
        requested: "gitlab.review",
        resolved: "gitlab.review",
        accepted: true,
        platform: "gitlab",
      }))

      RuntimeSourceRegistry.unregisterOwner("gitlab")

      const rejected = await ControllerTemplateResolver.resolve({
        entry: {
          source: "browser-extension",
          platform: "gitlab",
          templateIds: ["browser-gitlab"],
        },
      })
      expect(rejected.recommendedAgent).toBe("build")
      expect(rejected.audit.agentRecommendation).toEqual(expect.objectContaining({
        requested: "gitlab.review",
        resolved: "build",
        accepted: false,
        platform: "gitlab",
        reason: "not-found",
      }))
    },
  })
})

test("controller compiler fails closed when a profiled platform agent source is disabled", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "GitLab review agent.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })
      const profile = await SessionProfileCompiler.compile({
        source: "new-session",
        agentName: "gitlab.review",
      })
      const session = await Session.createNext({
        directory: tmp.path,
        runtimeProfile: profile,
      })
      const events: Array<{ type: string; properties: unknown }> = []
      const unsubscribe = Bus.subscribe(Agent.Unavailable, (event) => {
        events.push(event)
      })

      try {
        RuntimeSourceRegistry.unregisterOwner("gitlab")

        await expect(ControllerAgentRunCompiler.compileSpec({
          session,
          turnSnapshotId: "turn_platform_agent_unavailable",
          body: {
            parts: [{ type: "text", text: "hello" }],
            entry: {
              source: "browser-extension",
              platform: "gitlab",
            },
          },
        })).rejects.toThrow("AgentUnavailableError")

        expect(events).toEqual([
          expect.objectContaining({
            type: "runtime.agent.unavailable",
            properties: expect.objectContaining({
              sessionID: session.id,
              turnSnapshotId: "turn_platform_agent_unavailable",
              agent: "gitlab.review",
              reason: "missing-source",
            }),
          }),
        ])
      } finally {
        unsubscribe()
      }
    },
  })
})

test("direct prompt agent override cannot select declared-only platform agents", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "GitLab review agent.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })
      const session = await Session.createNext({
        directory: tmp.path,
      })

      try {
        await expect(SessionPrompt.prompt({
          sessionID: session.id,
          agent: "gitlab.review",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })).rejects.toThrow("Agent not found: gitlab.review")

        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})

test("controller prompt can persist the frozen declared-only platform agent", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentsDir = path.join(dir, "agents")
      await writeAgent(agentsDir, "review.agent.md", {
        name: "gitlab.review",
        description: "GitLab review agent.",
      })
      return { agentsDir }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerAgentSource({
        id: "gitlab-agents",
        directory: tmp.extra.agentsDir,
        visibility: "declared-only",
      })
      const profile = await SessionProfileCompiler.compile({
        source: "new-session",
        agentName: "gitlab.review",
      })
      const session = await Session.createNext({
        directory: tmp.path,
        runtimeProfile: profile,
      })

      try {
        const prompt = await ControllerAgentRunCompiler.compilePrompt({
          session,
          turnSnapshotId: "turn_platform_agent_prompt",
          body: {
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
            entry: {
              source: "browser-extension",
              platform: "gitlab",
            },
          },
        })
        const message = await SessionPrompt.prompt(prompt)

        expect(message.info.agent).toBe("gitlab.review")
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})
