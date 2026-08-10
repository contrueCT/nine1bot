import { afterEach, describe, expect, test } from "bun:test"
import { RuntimeToolCatalog } from "../../src/runtime/tool/catalog"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"

describe("RuntimeToolCatalog", () => {
  afterEach(() => {
    RuntimeToolRegistry.clearForTesting()
  })

  test("resolves available, degraded, unknown, auth-required, and conflicting tools with one budget", async () => {
    const started: string[] = []
    register("demo", [
      definition("demo_ready", {
        availability: () => {
          started.push("demo_ready")
          return { status: "available" }
        },
      }),
      definition("demo_degraded", {
        availability: () => {
          started.push("demo_degraded")
          return { status: "degraded", reason: "cached-health" }
        },
      }),
      definition("demo_slow", {
        availability: () => {
          started.push("demo_slow")
          return new Promise(() => {})
        },
      }),
      definition("demo_auth", {
        availability: () => {
          started.push("demo_auth")
          return {
            status: "auth-required",
            reason: "missing-token",
            action: { type: "start-auth", label: "Authenticate demo" },
          }
        },
      }),
      definition("demo_unavailable", {
        availability: () => {
          started.push("demo_unavailable")
          return { status: "unavailable", reason: "service-disabled" }
        },
      }),
      definition("demo_conflict"),
    ])

    const resolved = await RuntimeToolCatalog.resolveDeclared({
      ids: [
        "demo_ready",
        "demo_degraded",
        "demo_slow",
        "demo_auth",
        "demo_unavailable",
        "demo_conflict",
      ],
      context: resolveContext(),
      occupiedToolIDs: new Set(["demo_conflict"]),
      budgetMs: 20,
    })

    expect(started.sort()).toEqual([
      "demo_auth",
      "demo_degraded",
      "demo_ready",
      "demo_slow",
      "demo_unavailable",
    ])
    expect(resolved.available.map((item) => item.id)).toEqual([
      "demo_degraded",
      "demo_ready",
      "demo_slow",
    ])
    expect(resolved.availability.demo_slow).toMatchObject({
      declared: true,
      status: "unknown",
      reason: "availability-budget-exceeded",
    })
    expect(resolved.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceID: "demo_auth",
        ownerID: "demo",
        generation: 1,
        code: "auth-required",
        stage: "auth",
      }),
      expect.objectContaining({
        resourceID: "demo_conflict",
        code: "tool-conflict",
        stage: "resolve",
      }),
      expect.objectContaining({
        resourceID: "demo_unavailable",
        status: "unavailable",
        stage: "resolve",
      }),
    ]))
    expect(resolved.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "demo_auth", status: "auth-required" }),
      expect.objectContaining({ id: "demo_conflict", status: "conflict" }),
      expect.objectContaining({ id: "demo_slow", status: "registered" }),
      expect.objectContaining({ id: "demo_unavailable", status: "unavailable" }),
    ]))
  })

  test("does not inspect undeclared tools and reports tombstoned owner identity for missing tools", async () => {
    let undeclaredChecks = 0
    register("demo", [
      definition("demo_undeclared", {
        availability: () => {
          undeclaredChecks += 1
          return { status: "available" }
        },
      }),
    ])
    register("gone", [definition("gone_missing")])
    RuntimeToolRegistry.unregisterOwner("gone")

    const resolved = await RuntimeToolCatalog.resolveDeclared({
      ids: ["gone_missing", "gone_missing"],
      context: resolveContext(),
    })

    expect(undeclaredChecks).toBe(0)
    expect(resolved.declared).toEqual(["gone_missing"])
    expect(resolved.available).toEqual([])
    expect(resolved.failures).toEqual([
      expect.objectContaining({
        resourceID: "gone_missing",
        ownerID: "gone",
        generation: 2,
        code: "tool-missing",
      }),
    ])
  })

  test("keeps callback failures visible as degraded, hides hard denies, and redacts diagnostics", async () => {
    const secret = "catalog-fixture-secret"
    register("demo", [
      definition("demo_throw", {
        availability: () => {
          throw new Error(`Bearer ${secret}`)
        },
      }),
      definition("demo_invalid", {
        availability: () => ({ status: "invalid" as "available" }),
      }),
      definition("demo_degraded", {
        availability: () => ({
          status: "degraded",
          reason: `token=${secret}`,
          error: `Authorization: Bearer ${secret}`,
        }),
      }),
      definition("demo_denied"),
      definition("demo_declared", { catalogVisibility: "declared-only" }),
    ])

    const resolved = await RuntimeToolCatalog.resolveDeclared({
      ids: ["demo_throw", "demo_invalid", "demo_degraded", "demo_denied"],
      context: resolveContext(),
      isExposureDenied: async (id) => id === "demo_denied",
    })

    expect(resolved.available.map((item) => item.id)).toEqual([
      "demo_degraded",
      "demo_invalid",
      "demo_throw",
    ])
    expect(resolved.failures.filter((failure) => failure.resourceID === "demo_denied")).toEqual([])
    expect(resolved.summaries.find((item) => item.id === "demo_throw")?.status).toBe("error")
    expect(resolved.summaries.find((item) => item.id === "demo_invalid")?.status).toBe("error")
    expect(JSON.stringify(resolved)).not.toContain(secret)
    expect(resolved.availability.demo_degraded.reason).toBe("token=[REDACTED]")

    const selectable = await RuntimeToolCatalog.listSelectable({
      context: resolveContext(),
      isExposureDenied: async (id) => id === "demo_denied",
    })
    expect(selectable.map((item) => item.id)).not.toContain("demo_declared")
    expect(selectable.map((item) => item.id)).not.toContain("demo_denied")
    expect(selectable.find((item) => item.id === "demo_throw")?.status).toBe("error")
  })
})

function register(ownerID: string, tools: RuntimeToolRegistry.Definition[]) {
  RuntimeToolRegistry.registerOwner({
    owner: { id: ownerID, kind: "platform", enabled: true },
    tools,
  })
}

function definition(
  id: string,
  overrides: Partial<RuntimeToolRegistry.Definition> = {},
): RuntimeToolRegistry.Definition {
  return {
    id,
    description: `Fixture tool ${id}.`,
    catalogVisibility: "user-selectable",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    parse: (input) => input,
    execute: async () => ({
      status: "ok",
      title: id,
      output: "ok",
    }),
    ...overrides,
  }
}

function resolveContext(): RuntimeToolRegistry.ResolveContext {
  return {
    sessionId: "session_test",
    projectId: "project_test",
    directory: "C:\\test",
    agent: "build",
    templateIds: ["test"],
  }
}
