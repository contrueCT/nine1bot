import { describe, expect, test, beforeEach } from "bun:test"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"

describe("RuntimeSourceRegistry", () => {
  beforeEach(() => {
    RuntimeSourceRegistry.clearForTesting()
  })

  test("registers agent and skill sources by owner", () => {
    RuntimeSourceRegistry.registerOwner({
      owner: {
        id: "demo",
        kind: "platform",
        enabled: true,
      },
      sources: {
        agents: [{
          id: "demo-agents",
          directory: "/tmp/demo/agents",
          namespace: "demo.agent",
          visibility: "recommendable",
          lifecycle: "platform-enabled",
        }],
        skills: [{
          id: "demo-skills",
          directory: "/tmp/demo/skills",
          namespace: "demo.skill",
          visibility: "declared-only",
          lifecycle: "platform-enabled",
        }],
      },
    })

    expect(RuntimeSourceRegistry.listOwner("demo")).toMatchObject({
      owner: {
        id: "demo",
        kind: "platform",
        enabled: true,
      },
      agents: [{
        id: "demo-agents",
        directory: "/tmp/demo/agents",
        namespace: "demo.agent",
        visibility: "recommendable",
        lifecycle: "platform-enabled",
        owner: {
          id: "demo",
        },
      }],
      skills: [{
        id: "demo-skills",
        directory: "/tmp/demo/skills",
        namespace: "demo.skill",
        visibility: "declared-only",
        lifecycle: "platform-enabled",
        owner: {
          id: "demo",
        },
      }],
    })

    expect(RuntimeSourceRegistry.list().agents.map((source) => source.id)).toEqual(["demo-agents"])
    expect(RuntimeSourceRegistry.list().skills.map((source) => source.id)).toEqual(["demo-skills"])
  })

  test("overwrites an owner registration", () => {
    RuntimeSourceRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      sources: {
        agents: [{
          id: "old-agents",
          directory: "/tmp/old",
          visibility: "declared-only",
          lifecycle: "platform-enabled",
        }],
      },
    })

    RuntimeSourceRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      sources: {
        skills: [{
          id: "new-skills",
          directory: "/tmp/new",
          visibility: "default",
          lifecycle: "platform-enabled",
        }],
      },
    })

    expect(RuntimeSourceRegistry.listOwner("demo").agents).toEqual([])
    expect(RuntimeSourceRegistry.listOwner("demo").skills.map((source) => source.id)).toEqual(["new-skills"])
  })

  test("unregisters all sources for an owner", () => {
    RuntimeSourceRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      sources: {
        agents: [{
          id: "demo-agents",
          directory: "/tmp/demo/agents",
          visibility: "user-selectable",
          lifecycle: "platform-enabled",
        }],
        skills: [{
          id: "demo-skills",
          directory: "/tmp/demo/skills",
          visibility: "declared-only",
          lifecycle: "platform-enabled",
        }],
      },
    })

    RuntimeSourceRegistry.unregisterOwner("demo")

    expect(RuntimeSourceRegistry.listOwner("demo")).toEqual({
      owner: undefined,
      agents: [],
      skills: [],
    })
    expect(RuntimeSourceRegistry.list()).toEqual({
      agents: [],
      skills: [],
    })
  })

  test("tracks registry version for cache invalidation", () => {
    const initial = RuntimeSourceRegistry.version()

    RuntimeSourceRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      sources: {
        skills: [{
          id: "demo-skills",
          directory: "/tmp/demo/skills",
          visibility: "declared-only",
          lifecycle: "platform-enabled",
        }],
      },
    })
    expect(RuntimeSourceRegistry.version()).toBe(initial + 1)

    RuntimeSourceRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      sources: {},
    })
    expect(RuntimeSourceRegistry.version()).toBe(initial + 2)

    RuntimeSourceRegistry.unregisterOwner("demo")
    expect(RuntimeSourceRegistry.version()).toBe(initial + 3)

    RuntimeSourceRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      sources: {},
    })
    RuntimeSourceRegistry.clearForTesting()
    expect(RuntimeSourceRegistry.version()).toBe(initial + 5)
  })
})
