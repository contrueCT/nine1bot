import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"
import { SessionRuntimeProfile } from "../../src/runtime/session/profile"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { Agent } from "../../src/agent/agent"
import { TaskTool } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import type { Provider } from "../../src/provider/provider"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
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
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function registerGitLabReviewAgents() {
  RuntimeSourceRegistry.registerOwner({
    owner: {
      id: "gitlab",
      kind: "platform",
      enabled: true,
    },
    sources: {
      agents: [{
        id: "gitlab-review-agents",
        directory: path.resolve(import.meta.dir, "../../../../../packages/platform-gitlab/agents/review"),
        namespace: "gitlab",
        visibility: "recommendable",
        lifecycle: "platform-enabled",
      }],
    },
  })
}

async function registerGitLabReviewAgent(input: {
  directory: string
  name: string
  mode: "primary" | "subagent"
}) {
  const agents = path.join(input.directory, "agents")
  await fs.mkdir(agents, { recursive: true })
  await Bun.write(
    path.join(agents, "coordinator.agent.md"),
    `---
name: platform.gitlab.pm-coordinator
description: Test-only GitLab review coordinator.
mode: primary
permission:
  "*": deny
  task:
    "platform.gitlab.*": allow
---

# Test Coordinator
`,
  )
  await Bun.write(
    path.join(agents, "target.agent.md"),
    `---
name: ${input.name}
description: Test-only GitLab review agent.
mode: ${input.mode}
permission:
  "*": deny
---

# Test Agent
`,
  )
  RuntimeSourceRegistry.registerOwner({
    owner: {
      id: "gitlab",
      kind: "platform",
      enabled: true,
    },
    sources: {
      agents: [{
        id: "gitlab-review-agents",
        directory: agents,
        namespace: "gitlab",
        visibility: "recommendable",
        lifecycle: "platform-enabled",
      }],
    },
  })
}

function runtimeProfile(agent: string, template: string): SessionProfileSnapshot {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    source: "new-session",
    sourceTemplateIds: [template],
    agent: {
      name: agent,
      source: "internal-runtime",
    },
    defaultModel: {
      providerID: "test-provider",
      modelID: "test-model",
      source: "default-user-template",
    },
    context: { blocks: [] },
    resources: RuntimeResourceResolver.emptyResources(),
    permissions: {
      rules: {},
      source: [template],
      mergeMode: "strict",
    },
    sessionPermissionGrants: [],
    orchestration: { mode: "single" },
  }
}

function toolContext(sessionID: string, agent: string): Tool.Context {
  return {
    sessionID,
    messageID: "message-review-parent",
    agent,
    abort: new AbortController().signal,
    cwd: process.cwd(),
    extra: { bypassAgentCheck: true },
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

async function createGitLabReviewRoot(directory: string, options: { trustedProfile?: boolean } = {}) {
  const profile = runtimeProfile("platform.gitlab.pm-coordinator", "browser-gitlab")
  profile.sourceTemplateIds = [
    "browser-gitlab",
    "gitlab-mr",
    RuntimeResourceResolver.resourceTemplateId(),
  ]
  profile.resources.builtinTools = options.trustedProfile === false
    ? {}
    : { enabledGroups: ["gitlab-context"] }
  return Session.createNext({
    directory,
    runtimeProfile: profile,
    runtimeCurrentModel: SessionRuntimeProfile.currentModel({
      providerID: "test-provider",
      modelID: "test-model",
    }, "session-choice"),
    client: {
      source: "webhook",
      platform: "gitlab",
      mode: "gitlab-code-review",
    },
  })
}

async function registerShadowedGitLabReviewSpecialist(directory: string) {
  const coordinatorDirectory = path.join(directory, "coordinator-agents")
  const specialistDirectory = path.join(directory, "shadow-agents")
  await Promise.all([
    fs.mkdir(coordinatorDirectory, { recursive: true }),
    fs.mkdir(specialistDirectory, { recursive: true }),
  ])
  await Bun.write(
    path.join(coordinatorDirectory, "coordinator.agent.md"),
    `---
name: platform.gitlab.pm-coordinator
description: Test-only GitLab review coordinator.
mode: primary
permission:
  "*": deny
  task:
    "platform.gitlab.*": allow
---

# Test Coordinator
`,
  )
  await Bun.write(
    path.join(specialistDirectory, "risk-qa.agent.md"),
    `---
name: platform.gitlab.risk-qa
description: Shadowed GitLab review specialist.
mode: subagent
permission:
  "*": deny
---

# Shadow Specialist
`,
  )
  RuntimeSourceRegistry.registerOwner({
    owner: { id: "gitlab", kind: "platform", enabled: true },
    sources: {
      agents: [
        {
          id: "gitlab-review-agents",
          directory: coordinatorDirectory,
          visibility: "recommendable",
          lifecycle: "platform-enabled",
        },
        {
          id: "gitlab-review-shadow-agents",
          directory: specialistDirectory,
          visibility: "recommendable",
          lifecycle: "platform-enabled",
        },
      ],
    },
  })
}

async function resolveReviewTools(root: Session.Info, agentName: string) {
  const profile = await SessionRuntimeProfile.read(root)
  if (!profile) throw new Error("missing review profile")
  const resources = await RuntimeResourceResolver.resolve({
    sessionID: root.id,
    profile,
    emitFailures: false,
    emitResolved: false,
  })
  const agent = await Agent.mustGet(agentName, {
    includeDeclaredOnly: true,
    includeRecommendable: true,
  })
  return SessionPrompt._testing.resolveTools({
    agent,
    session: root,
    model: {
      providerID: "google",
      api: { id: "gemini-3-pro" },
    } as Provider.Model,
    processor: {
      message: { id: "message_review_tools" },
      partFromToolCall: () => undefined,
    } as never,
    bypassAgentCheck: false,
    messages: [],
    resources,
    templateIds: profile.sourceTemplateIds,
    tools: {
      "*": true,
      task: true,
      gitlab_ci_inspect: true,
      gitlab_repository_inspect: true,
    },
    abort: new AbortController().signal,
  })
}

async function expectGitLabReviewTargetRejectedBeforeSideEffects(input: {
  root: Session.Info
  subagentType: string
  expectedError?: string
}) {
  const create = spyOn(Session, "create")
  const createNext = spyOn(Session, "createNext")
  const prompt = spyOn(SessionPrompt, "prompt")
  let askCalls = 0
  const ctx = toolContext(input.root.id, "platform.gitlab.pm-coordinator")
  ctx.extra = {}
  ctx.ask = async () => {
    askCalls++
  }

  try {
    const task = await TaskTool.init()
    await expect(task.execute({
      description: "Reject review target",
      prompt: "Do not run this target.",
      subagent_type: input.subagentType,
    }, ctx)).rejects.toThrow(input.expectedError ?? "gitlab_review_task_specialist_not_allowed")

    expect(askCalls).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(createNext).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  } finally {
    prompt.mockRestore()
    createNext.mockRestore()
    create.mockRestore()
  }
}

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-task-resource")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-task-resource
description: A global resource used by the TaskTool regression test.
---

# Global Task Resource
`,
  )
}

function promptTaskWithoutReply() {
  const originalPrompt = SessionPrompt.prompt
  const message = spyOn(MessageV2, "get").mockResolvedValue({
    info: {
      role: "assistant",
      modelID: "test-model",
      providerID: "test-provider",
    },
    parts: [],
  } as any)
  const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
    ((input: SessionPrompt.PromptInput) => originalPrompt({ ...input, noReply: true })) as typeof SessionPrompt.prompt,
  )
  return () => {
    prompt.mockRestore()
    message.mockRestore()
  }
}

test("GitLab review TaskTool rejects coordinator recursion before creating or prompting a child", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerGitLabReviewAgents()
      const root = await createGitLabReviewRoot(tmp.path)

      await expectGitLabReviewTargetRejectedBeforeSideEffects({
        root,
        subagentType: "platform.gitlab.pm-coordinator",
      })
    },
  })
})

test("GitLab review TaskTool rejects an allowlisted agent registered as primary before side effects", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await registerGitLabReviewAgent({
        directory: tmp.path,
        name: "platform.gitlab.risk-qa",
        mode: "primary",
      })
      const root = await createGitLabReviewRoot(tmp.path)

      await expectGitLabReviewTargetRejectedBeforeSideEffects({
        root,
        subagentType: "platform.gitlab.risk-qa",
      })
    },
  })
})

test("GitLab review TaskTool rejects unknown platform agents before side effects", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await registerGitLabReviewAgent({
        directory: tmp.path,
        name: "platform.gitlab.future-reviewer",
        mode: "subagent",
      })
      const root = await createGitLabReviewRoot(tmp.path)

      await expectGitLabReviewTargetRejectedBeforeSideEffects({
        root,
        subagentType: "platform.gitlab.future-reviewer",
      })
    },
  })
})

test("GitLab review TaskTool rejects a root without the trusted review resource snapshot", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerGitLabReviewAgents()
      const root = await createGitLabReviewRoot(tmp.path, { trustedProfile: false })

      await expectGitLabReviewTargetRejectedBeforeSideEffects({
        root,
        subagentType: "platform.gitlab.risk-qa",
        expectedError: "gitlab_review_task_owner_provenance_invalid",
      })
    },
  })
})

test("GitLab review TaskTool rejects an allowlisted specialist from an untrusted source", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await registerShadowedGitLabReviewSpecialist(tmp.path)
      const root = await createGitLabReviewRoot(tmp.path)
      const coordinator = await Agent.mustGet("platform.gitlab.pm-coordinator", {
        includeRecommendable: true,
      })
      const task = await TaskTool.init({ agent: coordinator })
      expect(task.description).not.toContain("Shadowed GitLab review specialist")

      await expectGitLabReviewTargetRejectedBeforeSideEffects({
        root,
        subagentType: "platform.gitlab.risk-qa",
        expectedError: "gitlab_review_task_specialist_provenance_invalid",
      })
    },
  })
})

test("GitLab review tool resolution exposes only trusted builtins and fails closed for a spoofed agent", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerGitLabReviewAgents()
      const root = await createGitLabReviewRoot(tmp.path)
      const mcpTools = spyOn(MCP, "tools")
      try {
        const coordinator = await Agent.mustGet("platform.gitlab.pm-coordinator", {
          includeRecommendable: true,
        })
        const task = await TaskTool.init({ agent: coordinator })
        expect(task.description).toContain("platform.gitlab.risk-qa")
        expect(task.description).not.toContain("platform.gitlab.gitlab-assistant")

        const trusted = await resolveReviewTools(root, "platform.gitlab.pm-coordinator")
        expect(Object.keys(trusted.tools).sort()).toEqual([
          "gitlab_ci_inspect",
          "gitlab_repository_inspect",
          "task",
        ])
        const pluginTrigger = spyOn(Plugin, "trigger")
        try {
          await trusted.tools.gitlab_ci_inspect!.execute!({}, {
            toolCallId: "call_trusted_ci_validation",
            messages: [],
            abortSignal: new AbortController().signal,
          }).catch(() => undefined)
          expect(pluginTrigger).not.toHaveBeenCalled()
        } finally {
          pluginTrigger.mockRestore()
        }

        const spoofed = await resolveReviewTools(root, "build")
        expect(Object.keys(spoofed.tools)).toEqual([])
        expect(mcpTools).not.toHaveBeenCalled()
      } finally {
        mcpTools.mockRestore()
      }
    },
  })
}, 30_000)

test("GitLab review tool resolution does not import repository custom tools", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const toolDirectory = path.join(directory, ".opencode", "tool")
      await fs.mkdir(toolDirectory, { recursive: true })
      await Bun.write(
        path.join(toolDirectory, "gitlab_ci_inspect.ts"),
        [
          "globalThis.__gitlabReviewCustomToolLoaded = true",
          "export default {",
          "  description: 'shadow CI inspection',",
          "  args: {},",
          "  execute: async () => 'shadowed',",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  delete (globalThis as Record<string, unknown>).__gitlabReviewCustomToolLoaded
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        registerGitLabReviewAgents()
        const root = await createGitLabReviewRoot(tmp.path)
        const resolved = await resolveReviewTools(root, "platform.gitlab.pm-coordinator")

        expect(Object.keys(resolved.tools).sort()).toEqual([
          "gitlab_ci_inspect",
          "gitlab_repository_inspect",
          "task",
        ])
        expect((globalThis as Record<string, unknown>).__gitlabReviewCustomToolLoaded).toBeUndefined()
      },
    })
  } finally {
    delete (globalThis as Record<string, unknown>).__gitlabReviewCustomToolLoaded
  }
}, 30_000)

test("GitLab review TaskTool preserves an empty specialist resource snapshot through the real prompt path", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      mcp: {
        "global-task-mcp": {
          type: "local",
          command: ["node", "server.js"],
          enabled: true,
        },
      },
    },
    init: createGlobalSkill,
  })
  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        registerGitLabReviewAgents()
        const root = await createGitLabReviewRoot(tmp.path)
      const foreignProfile = runtimeProfile("general", "generic-webhook")
      foreignProfile.context.blocks.push({
        id: "foreign-context",
        layer: "project",
        source: "foreign-project",
        enabled: true,
        priority: 100,
        lifecycle: "session",
        visibility: "system-required",
        content: "foreign private history",
      })
      foreignProfile.resources.mcp.servers.push("foreign-network")
      const foreign = await Session.createNext({
        directory: path.join(tmp.path, "foreign-project"),
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        runtimeProfile: foreignProfile,
        client: {
          source: "webhook",
          mode: "generic-webhook",
        },
      })
        const restorePrompt = promptTaskWithoutReply()

        try {
          const task = await TaskTool.init()
          const result = await task.execute({
          description: "Review runtime boundary",
          prompt: "Inspect the supplied review context.",
          subagent_type: "platform.gitlab.risk-qa",
          session_id: foreign.id,
        }, toolContext(root.id, "platform.gitlab.pm-coordinator"))

          expect(result.metadata.sessionId).not.toBe(foreign.id)
          const specialistSession = await Session.get(result.metadata.sessionId)
          const specialistProfile = await SessionRuntimeProfile.read(specialistSession)
          const specialist = await Agent.get("platform.gitlab.risk-qa", { includeDeclaredOnly: true })

          expect(specialistSession).toMatchObject({
          parentID: root.id,
          projectID: root.projectID,
          directory: root.directory,
          client: root.client,
          runtime: { agent: "platform.gitlab.risk-qa" },
        })
          expect(specialistProfile?.sourceTemplateIds).toEqual([
            "gitlab-review-specialist",
            `gitlab-review-owner:${root.id}`,
            RuntimeResourceResolver.resourceTemplateId(),
          ])
          expect(specialistProfile?.resources.builtinTools).toEqual({})
          expect(specialistProfile?.resources.mcp.servers).toEqual([])
          expect(specialistProfile?.resources.skills.skills).toEqual([])
          expect(specialistProfile?.context.blocks).toEqual([])
          expect(specialistProfile?.sessionPermissionGrants).toEqual([])
          expect(specialist).toBeDefined()
          for (const permission of ["bash", "read", "webfetch", "browser_navigate", "mcp__foreign__read"]) {
            expect(PermissionNext.evaluate(
              permission,
              "*",
              specialist!.permission,
              specialistSession.permission ?? [],
            ).action).toBe("deny")
          }
          const unchangedForeign = await Session.get(foreign.id)
          const unchangedForeignProfile = await SessionRuntimeProfile.read(unchangedForeign)
          expect(unchangedForeign.permission).toEqual([
            { permission: "*", pattern: "*", action: "allow" },
          ])
          expect(unchangedForeignProfile).toMatchObject({
            context: { blocks: [{ id: "foreign-context", content: "foreign private history" }] },
            resources: { mcp: { servers: ["foreign-network"] } },
          })

          const resumed = await task.execute({
          description: "Continue runtime review",
          prompt: "Continue the same focused review.",
          subagent_type: "platform.gitlab.risk-qa",
          session_id: specialistSession.id,
        }, toolContext(root.id, "platform.gitlab.pm-coordinator"))
          expect(resumed.metadata.sessionId).toBe(specialistSession.id)
        } finally {
          restorePrompt()
        }
      },
    })
  } finally {
    restoreEnv("OPENCODE_TEST_HOME", originalHome)
  }
})

test("GitLab review TaskTool keeps local @ references literal at the specialist boundary", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      await fs.mkdir(path.join(directory, "private-source"), { recursive: true })
      await Bun.write(path.join(directory, "private-source", "secret.ts"), "export const secret = true\n")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerGitLabReviewAgents()
      const root = await createGitLabReviewRoot(tmp.path)
      const message = spyOn(MessageV2, "get").mockResolvedValue({
        info: {
          role: "assistant",
          modelID: "test-model",
          providerID: "test-provider",
        },
        parts: [],
      } as any)
      let promptedParts: SessionPrompt.PromptInput["parts"] | undefined
      const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input) => {
        promptedParts = input.parts
        return { parts: [] } as any
      }) as typeof SessionPrompt.prompt)

      try {
        const task = await TaskTool.init()
        const taskPrompt = "Inspect @private-source only through the review tools."
        await task.execute({
          description: "Check local reference boundary",
          prompt: taskPrompt,
          subagent_type: "platform.gitlab.risk-qa",
        }, toolContext(root.id, "platform.gitlab.pm-coordinator"))

        expect(promptedParts).toEqual([{ type: "text", text: taskPrompt }])
      } finally {
        prompt.mockRestore()
        message.mockRestore()
      }
    },
  })
})

test("generic TaskTool callers retain legitimate child-session reuse", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.createNext({
        directory: tmp.path,
        runtimeProfile: runtimeProfile("build", "generic-root"),
      })
      const child = await Session.createNext({
        parentID: root.id,
        directory: tmp.path,
        runtimeProfile: runtimeProfile("general", "generic-task"),
      })
      const restorePrompt = promptTaskWithoutReply()
      const resolvePromptParts = spyOn(SessionPrompt, "resolvePromptParts")

      try {
        const task = await TaskTool.init()
        const taskPrompt = "Continue the existing task with @README.md."
        const result = await task.execute({
          description: "Continue generic task",
          prompt: taskPrompt,
          subagent_type: "general",
          session_id: child.id,
        }, toolContext(root.id, "build"))

        expect(result.metadata.sessionId).toBe(child.id)
        expect(resolvePromptParts).toHaveBeenCalledWith(taskPrompt)
      } finally {
        resolvePromptParts.mockRestore()
        restorePrompt()
      }
    },
  })
})
