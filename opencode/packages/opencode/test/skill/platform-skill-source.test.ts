import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import path from "path"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { SkillTool } from "../../src/tool/skill"
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

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function testProfile(skillNames: string[]): SessionProfileSnapshot {
  return {
    id: "profile_platform_skill_test",
    sessionId: "session_platform_skill_test",
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
    resources: {
      builtinTools: {},
      mcp: {
        servers: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      skills: {
        skills: skillNames,
        lifecycle: "session",
        mergeMode: "additive-only",
      },
    },
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

async function writeSkill(root: string, name: string, description: string) {
  await Bun.write(
    path.join(root, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}

Platform skill instructions.
`,
  )
}

function registerPlatformSkillSource(directory: string) {
  RuntimeSourceRegistry.registerOwner({
    owner: {
      id: "gitlab",
      kind: "platform",
      enabled: true,
    },
    sources: {
      skills: [{
        id: "gitlab-skills",
        directory,
        namespace: "gitlab",
        visibility: "declared-only",
        lifecycle: "platform-enabled",
      }],
    },
  })
}

beforeEach(() => {
  RuntimeSourceRegistry.clearForTesting()
})

afterEach(() => {
  RuntimeSourceRegistry.clearForTesting()
})

test("declared-only platform skills are hidden from default skill lists", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const platformSkills = path.join(dir, "platform-skills")
      await writeSkill(platformSkills, "gitlab-review", "Review GitLab changes.")
      return { platformSkills }
    },
  })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        registerPlatformSkillSource(tmp.extra.platformSkills)

        expect(await Skill.get("gitlab-review")).toBeUndefined()
        expect((await Skill.all()).map((skill) => skill.name)).not.toContain("gitlab-review")
        expect((await Skill.all({ includeDeclaredOnly: true })).map((skill) => skill.name)).toContain("gitlab-review")

        const resources = await RuntimeResourceResolver.compileProfileResources()
        expect(resources.skills.skills).not.toContain("gitlab-review")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("declared-only platform skills resolve when profile explicitly declares them", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const platformSkills = path.join(dir, "platform-skills")
      await writeSkill(platformSkills, "gitlab-review", "Review GitLab changes.")
      return { platformSkills }
    },
  })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        registerPlatformSkillSource(tmp.extra.platformSkills)

        const resolved = await RuntimeResourceResolver.resolve({
          sessionID: "session_platform_skill_test",
          profile: testProfile(["gitlab-review"]),
          emitFailures: false,
          emitResolved: false,
        })

        expect(resolved.skills.availableSkills.map((skill) => skill.name)).toEqual(["gitlab-review"])

        const skillTool = await SkillTool.init({ skills: resolved.skills.availableSkills })
        expect(skillTool.description).toContain("gitlab-review")

        const result = await skillTool.execute(
          { name: "gitlab-review" },
          {
            sessionID: "session_platform_skill_test",
            messageID: "message_platform_skill_test",
            agent: "build",
            abort: new AbortController().signal,
            cwd: tmp.path,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        expect(result.title).toBe("Loaded skill: gitlab-review")
        expect(result.output).toContain("Platform skill instructions.")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("unregistered platform skill sources become unavailable for declared profiles", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const platformSkills = path.join(dir, "platform-skills")
      await writeSkill(platformSkills, "gitlab-review", "Review GitLab changes.")
      return { platformSkills }
    },
  })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        registerPlatformSkillSource(tmp.extra.platformSkills)

        const profile = testProfile(["gitlab-review"])
        const first = await RuntimeResourceResolver.resolve({
          sessionID: "session_platform_skill_test",
          profile,
          emitFailures: false,
          emitResolved: false,
        })
        expect(first.skills.availableSkills.map((skill) => skill.name)).toEqual(["gitlab-review"])

        RuntimeSourceRegistry.unregisterOwner("gitlab")

        const second = await RuntimeResourceResolver.resolve({
          sessionID: "session_platform_skill_test",
          profile,
          emitFailures: false,
          emitResolved: false,
        })
        expect(second.skills.availableSkills).toEqual([])
        expect(second.skills.availability["gitlab-review"].reason).toBe("disabled-by-current-config")
        expect(second.failures).toContainEqual(expect.objectContaining({
          resourceType: "skill",
          resourceID: "gitlab-review",
          reason: "disabled-by-current-config",
        }))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})
