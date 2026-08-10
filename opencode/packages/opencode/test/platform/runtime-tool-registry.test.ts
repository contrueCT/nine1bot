import { beforeEach, describe, expect, test } from "bun:test"
import {
  RuntimeToolRegistrationError,
  RuntimeToolRegistry,
  RuntimeToolSelectionError,
} from "../../src/runtime/tool/registry"
import { sanitizePlatformToolDiagnostic } from "../../src/runtime/tool/sanitize"

type TestInput = {
  query: string
}

function definition(
  id: string,
  overrides: Partial<RuntimeToolRegistry.Definition<TestInput>> = {},
): RuntimeToolRegistry.Definition<TestInput> {
  return {
    id,
    description: `Look up ${id}`,
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
      return input as TestInput
    },
    async execute() {
      return {
        status: "ok",
        title: "Lookup",
        output: "ok",
      }
    },
    ...overrides,
  }
}

function register(ownerID: string, tools: RuntimeToolRegistry.Definition<any>[]) {
  return RuntimeToolRegistry.registerOwner({
    owner: { id: ownerID, kind: "platform", enabled: true },
    tools,
  })
}

beforeEach(() => {
  RuntimeToolRegistry.clearForTesting()
})

describe("RuntimeToolRegistry", () => {
  test("publishes a valid owner group atomically at generation one", () => {
    const before = RuntimeToolRegistry.version()
    register("demo", [definition("demo_lookup"), definition("demo_update")])

    expect(RuntimeToolRegistry.listOwner("demo")).toMatchObject({
      owner: { id: "demo", kind: "platform", enabled: true },
      prefix: "demo",
      generation: 1,
      tools: [{ id: "demo_lookup" }, { id: "demo_update" }],
    })
    expect(RuntimeToolRegistry.get("demo_lookup")).toMatchObject({
      id: "demo_lookup",
      ownerID: "demo",
      generation: 1,
    })
    expect(RuntimeToolRegistry.version()).toBe(before + 1)
  })

  test("prepares without publishing and rejects a stale prepared group", () => {
    const before = RuntimeToolRegistry.version()
    const prepared = RuntimeToolRegistry.prepareOwner({
      owner: { id: "prepared", kind: "platform", enabled: true },
      tools: [definition("prepared_lookup")],
    })

    expect(prepared).toMatchObject({ baseRevision: before, prefix: "prepared", generation: 1 })
    expect(RuntimeToolRegistry.get("prepared_lookup")).toBeUndefined()
    expect(RuntimeToolRegistry.version()).toBe(before)

    register("other", [definition("other_lookup")])
    expect(() => RuntimeToolRegistry.commitOwner(prepared)).toThrow(RuntimeToolRegistrationError)
    expect(() => RuntimeToolRegistry.commitOwner(prepared)).toThrow("stale preparation")
    expect(RuntimeToolRegistry.get("prepared_lookup")).toBeUndefined()
  })

  test("keeps the previous group and generation when replacement validation fails", () => {
    register("demo", [definition("demo_lookup")])
    const revision = RuntimeToolRegistry.version()

    expect(() =>
      register("demo", [definition("demo_lookup"), definition("bad_id")]),
    ).toThrow("owner prefix")

    expect(RuntimeToolRegistry.get("demo_lookup")?.generation).toBe(1)
    expect(RuntimeToolRegistry.listOwner("demo").tools.map((tool) => tool.id)).toEqual(["demo_lookup"])
    expect(RuntimeToolRegistry.version()).toBe(revision)
  })

  test("increments generation for replace, unregister, and re-register", () => {
    const before = RuntimeToolRegistry.version()
    register("demo", [definition("demo_lookup")])
    expect(RuntimeToolRegistry.get("demo_lookup")?.generation).toBe(1)

    register("demo", [definition("demo_lookup", { description: "Replacement" })])
    expect(RuntimeToolRegistry.get("demo_lookup")?.generation).toBe(2)

    expect(RuntimeToolRegistry.unregisterOwner("demo")).toBe(true)
    expect(RuntimeToolRegistry.get("demo_lookup")).toBeUndefined()
    expect(RuntimeToolRegistry.lookupReservation("demo_lookup")).toEqual({
      ownerID: "demo",
      generation: 3,
      active: false,
    })

    register("demo", [definition("demo_lookup")])
    expect(RuntimeToolRegistry.get("demo_lookup")?.generation).toBe(4)
    expect(RuntimeToolRegistry.version()).toBe(before + 4)
  })

  test("reserves historical IDs for the original owner after unregister", () => {
    register("demo", [definition("demo_lookup")])
    expect(RuntimeToolRegistry.unregisterOwner("demo")).toBe(true)

    expect(() =>
      register("other", [{ ...definition("other_lookup"), id: "demo_lookup" }]),
    ).toThrow("reserved")

    register("demo", [definition("demo_lookup")])
    expect(RuntimeToolRegistry.get("demo_lookup")?.generation).toBe(3)
  })

  test("keeps IDs removed by replacement reserved for their original owner", () => {
    register("demo", [definition("demo_lookup"), definition("demo_update")])
    register("demo", [definition("demo_lookup")])

    expect(RuntimeToolRegistry.get("demo_update")).toBeUndefined()
    expect(RuntimeToolRegistry.lookupReservation("demo_update")).toEqual({
      ownerID: "demo",
      generation: 2,
      active: false,
    })
    expect(() =>
      register("other", [{ ...definition("other_update"), id: "demo_update" }]),
    ).toThrow("reserved")

    register("demo", [definition("demo_lookup"), definition("demo_update")])
    expect(RuntimeToolRegistry.get("demo_update")?.generation).toBe(3)
  })

  test("rejects duplicate IDs without publishing any part of the group", () => {
    const before = RuntimeToolRegistry.version()
    expect(() => register("duplicate", [definition("duplicate_lookup"), definition("duplicate_lookup")])).toThrow(
      "duplicate tool ID",
    )

    expect(RuntimeToolRegistry.listOwner("duplicate").tools).toEqual([])
    expect(RuntimeToolRegistry.version()).toBe(before)
  })

  test("rejects owners that normalize to an already reserved prefix", () => {
    register("demo-one", [definition("demo_one_lookup")])

    expect(() => register("demo_one", [definition("demo_one_update")])).toThrow("owner prefix collision")
    expect(RuntimeToolRegistry.get("demo_one_update")).toBeUndefined()
  })

  test("rejects an active tool ID owned by another group", () => {
    register("demo", [definition("demo_lookup")])

    expect(() =>
      register("other", [{ ...definition("other_lookup"), id: "demo_lookup" }]),
    ).toThrow("active tool ID collision")
    expect(RuntimeToolRegistry.get("demo_lookup")?.ownerID).toBe("demo")
  })

  test("rejects non-JSON and schema-invalid input schemas", () => {
    const cycle: Record<string, unknown> = { type: "object" }
    cycle.self = cycle

    const cases: Array<{ name: string; schema: Record<string, unknown> }> = [
      { name: "cycle", schema: cycle },
      { name: "function", schema: { type: "object", invalid: () => undefined } },
      { name: "undefined", schema: { type: "object", invalid: undefined } },
      { name: "bigint", schema: { type: "object", invalid: 1n } },
      { name: "non-finite number", schema: { type: "number", maximum: Number.POSITIVE_INFINITY } },
      { name: "invalid JSON Schema", schema: { type: 42 } },
    ]

    for (const item of cases) {
      expect(() =>
        register("schema", [definition("schema_lookup", { inputSchema: item.schema })]),
      ).toThrow(RuntimeToolRegistrationError)
      expect(RuntimeToolRegistry.listOwner("schema").tools, item.name).toEqual([])
    }
  })

  test("rejects blank descriptions and suspected credentials in model-facing contracts", () => {
    expect(() => register("description", [definition("description_lookup", { description: "   " })])).toThrow(
      "description",
    )
    expect(() =>
      register("description", [
        definition("description_lookup", { description: "Authorization: Bearer fixture-description-secret" }),
      ]),
    ).toThrow("sensitive")
    expect(() =>
      register("schema", [
        definition("schema_lookup", {
          inputSchema: { type: "object", description: "token=fixture-schema-secret" },
        }),
      ]),
    ).toThrow("sensitive")
  })

  test("rejects missing function fields and invalid visibility", () => {
    const missingParser = { ...definition("fields_lookup"), parse: undefined } as unknown as RuntimeToolRegistry.Definition
    const missingExecute = {
      ...definition("fields_lookup"),
      execute: undefined,
    } as unknown as RuntimeToolRegistry.Definition
    const invalidVisibility = {
      ...definition("fields_lookup"),
      catalogVisibility: "public",
    } as unknown as RuntimeToolRegistry.Definition

    expect(() => register("fields", [missingParser])).toThrow("parse")
    expect(() => register("fields", [missingExecute])).toThrow("execute")
    expect(() => register("fields", [invalidVisibility])).toThrow("catalog visibility")
  })

  test("rejects zero, fractional, and over-limit timeouts", () => {
    for (const timeoutMs of [0, 1.5, 300_001]) {
      expect(() =>
        register("timeout", [definition("timeout_lookup", { execution: { timeoutMs } })]),
      ).toThrow("timeout")
      expect(RuntimeToolRegistry.listOwner("timeout").tools).toEqual([])
    }
  })

  test("stores immutable schema snapshots and returns cloned summaries", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    }
    register("clone", [definition("clone_lookup", { inputSchema: schema })])
    schema.properties.query.type = "number"

    const reference = RuntimeToolRegistry.get("clone_lookup")
    expect(reference?.definition.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
      },
    })
    expect(Object.isFrozen(reference?.definition.inputSchema)).toBe(true)
    expect(Object.isFrozen((reference?.definition.inputSchema.properties as Record<string, unknown>).query)).toBe(
      true,
    )

    const first = RuntimeToolRegistry.listOwner("clone")
    ;(first.owner as RuntimeToolRegistry.Owner).id = "mutated"
    first.tools[0]!.description = "mutated"

    expect(RuntimeToolRegistry.listOwner("clone")).toMatchObject({
      owner: { id: "clone" },
      tools: [{ id: "clone_lookup", description: "Look up clone_lookup" }],
    })
    expect(RuntimeToolRegistry.list()).toMatchObject([{ id: "clone_lookup", ownerID: "clone" }])
  })

  test("captures and restores an exact owner snapshot and revision", () => {
    register("snapshot", [definition("snapshot_lookup")])
    const captured = RuntimeToolRegistry.captureOwner("snapshot")
    const capturedRevision = RuntimeToolRegistry.version()

    register("snapshot", [definition("snapshot_update")])
    expect(RuntimeToolRegistry.get("snapshot_lookup")).toBeUndefined()
    expect(RuntimeToolRegistry.get("snapshot_update")?.generation).toBe(2)

    RuntimeToolRegistry.restoreOwner(captured)
    expect(RuntimeToolRegistry.version()).toBe(capturedRevision)
    expect(RuntimeToolRegistry.get("snapshot_lookup")?.generation).toBe(1)
    expect(RuntimeToolRegistry.get("snapshot_update")).toBeUndefined()
    expect(RuntimeToolRegistry.lookupReservation("snapshot_update")).toBeUndefined()
  })

  test("restores an absent owner without leaving new reservations", () => {
    const before = RuntimeToolRegistry.version()
    const captured = RuntimeToolRegistry.captureOwner("absent")
    register("absent", [definition("absent_lookup")])

    RuntimeToolRegistry.restoreOwner(captured)
    expect(RuntimeToolRegistry.version()).toBe(before)
    expect(RuntimeToolRegistry.get("absent_lookup")).toBeUndefined()
    expect(RuntimeToolRegistry.lookupReservation("absent_lookup")).toBeUndefined()
    expect(RuntimeToolRegistry.listOwner("absent").tools).toEqual([])
  })

  test("validates owner declarations and user-selectable choices", () => {
    register("selection", [
      definition("selection_declared", { catalogVisibility: "declared-only" }),
      definition("selection_selectable"),
    ])

    expect(() => RuntimeToolRegistry.assertOwned("selection", ["selection_declared", "selection_selectable"])).not.toThrow()
    expect(() => RuntimeToolRegistry.assertOwned("other", ["selection_selectable"])).toThrow(
      RuntimeToolRegistrationError,
    )
    expect(() => RuntimeToolRegistry.assertUserSelectable(["selection_selectable"])).not.toThrow()

    try {
      RuntimeToolRegistry.assertUserSelectable(["selection_declared", "selection_missing"])
      throw new Error("Expected a selection error")
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeToolSelectionError)
      expect((error as RuntimeToolSelectionError).invalid).toEqual([
        { id: "selection_declared", reason: "declared-only" },
        { id: "selection_missing", reason: "missing" },
      ])
    }

    RuntimeToolRegistry.unregisterOwner("selection")
    expect(() => RuntimeToolRegistry.assertUserSelectable(["selection_selectable"])).toThrow("inactive")
  })

  test("selection errors do not echo malformed credential-like IDs", () => {
    try {
      RuntimeToolRegistry.assertUserSelectable(["token=fixture-selection-secret"])
      throw new Error("Expected a selection error")
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeToolSelectionError)
      expect(JSON.stringify(error)).not.toContain("fixture-selection-secret")
      expect((error as RuntimeToolSelectionError).invalid).toEqual([
        { id: "[invalid-tool-id]", reason: "missing" },
      ])
    }
  })

  test("no-op unregister leaves the revision unchanged", () => {
    const before = RuntimeToolRegistry.version()
    expect(RuntimeToolRegistry.unregisterOwner("missing")).toBe(false)
    expect(RuntimeToolRegistry.version()).toBe(before)
  })
})

test("sanitizes credential-bearing diagnostics without changing safe text", () => {
  const secret = "fixture-runtime-tool-secret"
  const sanitized = sanitizePlatformToolDiagnostic(
    `Authorization: Bearer ${secret}\nCookie: session=${secret}\ntoken=${secret}\nsafe message`,
  )

  expect(sanitized).not.toContain(secret)
  expect(sanitized).toContain("[REDACTED]")
  expect(sanitizePlatformToolDiagnostic("safe message")).toBe("safe message")
})
