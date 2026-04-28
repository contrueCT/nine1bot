import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { Webhook } from "../../src/webhook/webhook"
import { tmpdir } from "../fixture/fixture"

function sourceWithGuards(
  requestGuards: Partial<Webhook.RequestGuards>,
  sourceID = `src_test_${Math.random().toString(36).slice(2)}`,
) {
  return Webhook.Source.parse({
    id: sourceID,
    name: "Guard test",
    enabled: true,
    projectID: "project_test",
    auth: {
      secretHash: "",
    },
    requestMapping: {},
    promptTemplate: "test",
    requestGuards: {
      ...Webhook.defaultRequestGuards(),
      ...requestGuards,
    },
    time: {
      created: Date.now(),
      updated: Date.now(),
    },
  })
}

function renderContext(source: Webhook.Source, now?: number): Webhook.GuardContext {
  return {
    source: {
      id: source.id,
      name: source.name,
    },
    project: {
      id: source.projectID,
      name: "Project",
      rootDirectory: "/tmp/project",
      worktree: "/tmp/project",
    },
    fields: {
      monitorID: "monitor-1",
    },
    body: {
      monitor: {
        id: "monitor-1",
      },
    },
    headers: {},
    query: {},
    now,
  }
}

describe("webhook secrets", () => {
  test("refresh replaces the stored secret hash", async () => {
    await using tmp = await tmpdir({ git: true })
    let sourceID: string | undefined
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const created = await Webhook.createSource({
            name: "Secret test",
            projectID: Instance.project.id,
          })
          sourceID = created.source.id
          const before = await Webhook.getSource(created.source.id)
          expect(Webhook.verifySecret(before, created.secret)).toBe(true)

          const refreshed = await Webhook.refreshSourceSecret(created.source.id)
          const after = await Webhook.getSource(created.source.id)
          expect(Webhook.verifySecret(after, created.secret)).toBe(false)
          expect(Webhook.verifySecret(after, refreshed.secret)).toBe(true)
        },
      })
    } finally {
      if (sourceID) {
        await Storage.remove(["webhook_source", sourceID])
      }
      if (projectID) {
        await Storage.remove(["project", projectID])
        await Storage.remove(["project_meta", projectID])
      }
    }
  })
})

describe("webhook guard logic", () => {
  test("accepts unix seconds, unix milliseconds, and ISO timestamp replay headers", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")
    const guard = {
      enabled: true,
      timestampHeader: "x-nine1bot-timestamp",
      maxSkewSeconds: 300,
    }

    expect(Webhook.evaluateReplayProtection(guard, { "x-nine1bot-timestamp": String(Math.floor(now / 1000)) }, now).allowed).toBe(true)
    expect(Webhook.evaluateReplayProtection(guard, { "x-nine1bot-timestamp": String(now) }, now).allowed).toBe(true)
    expect(Webhook.evaluateReplayProtection(guard, { "x-nine1bot-timestamp": new Date(now).toISOString() }, now).allowed).toBe(true)
  })

  test("rejects missing, invalid, and out-of-range replay timestamps", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")
    const guard = {
      enabled: true,
      timestampHeader: "x-nine1bot-timestamp",
      maxSkewSeconds: 300,
    }

    expect(Webhook.evaluateReplayProtection(guard, {}, now)).toMatchObject({
      allowed: false,
      httpStatus: 400,
      guardType: "replayProtection",
      error: "webhook_replay_timestamp_missing",
    })
    expect(Webhook.evaluateReplayProtection(guard, { "x-nine1bot-timestamp": "nope" }, now)).toMatchObject({
      allowed: false,
      httpStatus: 400,
      guardType: "replayProtection",
      error: "webhook_replay_timestamp_invalid",
    })
    expect(Webhook.evaluateReplayProtection(guard, { "x-nine1bot-timestamp": String(Math.floor((now - 301_000) / 1000)) }, now)).toMatchObject({
      allowed: false,
      httpStatus: 400,
      guardType: "replayProtection",
      error: "webhook_replay_timestamp_out_of_range",
    })
  })

  test("dedupes by rendered key template", async () => {
    const source = sourceWithGuards({
      dedupe: {
        enabled: true,
        keyTemplate: "{{fields.monitorID}}",
        ttlSeconds: 3600,
      },
      rateLimit: {
        enabled: false,
        maxRequests: 20,
        windowSeconds: 60,
      },
      cooldown: {
        enabled: false,
        seconds: 120,
      },
    })

    const first = await Webhook.evaluateRequestGuards(source, renderContext(source, 1000))
    const second = await Webhook.evaluateRequestGuards(source, renderContext(source, 2000))

    expect(first).toMatchObject({
      allowed: true,
      dedupeKey: "monitor-1",
    })
    expect(second).toMatchObject({
      allowed: false,
      httpStatus: 409,
      guardType: "dedupe",
      dedupeKey: "monitor-1",
    })
  })

  test("applies source-level fixed window rate limits", async () => {
    const source = sourceWithGuards({
      dedupe: {
        enabled: false,
        ttlSeconds: 3600,
      },
      rateLimit: {
        enabled: true,
        maxRequests: 1,
        windowSeconds: 60,
      },
      cooldown: {
        enabled: false,
        seconds: 120,
      },
    })

    const first = await Webhook.evaluateRequestGuards(source, renderContext(source, 1000))
    const second = await Webhook.evaluateRequestGuards(source, renderContext(source, 2000))

    expect(first.allowed).toBe(true)
    expect(second).toMatchObject({
      allowed: false,
      httpStatus: 429,
      guardType: "rateLimit",
      error: "webhook_rate_limited",
    })
  })

  test("blocks during cooldown after an accepted run is marked", async () => {
    const source = sourceWithGuards({
      dedupe: {
        enabled: false,
        ttlSeconds: 3600,
      },
      rateLimit: {
        enabled: false,
        maxRequests: 20,
        windowSeconds: 60,
      },
      cooldown: {
        enabled: true,
        seconds: 120,
      },
    })

    const first = await Webhook.evaluateRequestGuards(source, renderContext(source, 1000))
    await Webhook.markCooldown(source, "run_test", 1000)
    const second = await Webhook.evaluateRequestGuards(source, renderContext(source, 2000))

    expect(first.allowed).toBe(true)
    expect(second).toMatchObject({
      allowed: false,
      httpStatus: 429,
      guardType: "cooldown",
      error: "webhook_cooldown_active",
    })
  })

  test("allows a dedupe key again after the ttl expires", async () => {
    const source = sourceWithGuards({
      dedupe: {
        enabled: true,
        keyTemplate: "{{fields.monitorID}}",
        ttlSeconds: 1,
      },
      rateLimit: {
        enabled: false,
        maxRequests: 20,
        windowSeconds: 60,
      },
      cooldown: {
        enabled: false,
        seconds: 120,
      },
    })

    const first = await Webhook.evaluateRequestGuards(source, renderContext(source, 1000))
    const second = await Webhook.evaluateRequestGuards(source, renderContext(source, 2500))
    const third = await Webhook.evaluateRequestGuards(source, renderContext(source, 2600))

    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(true)
    expect(third).toMatchObject({
      allowed: false,
      httpStatus: 409,
      guardType: "dedupe",
    })
  })

  test("removes expired cooldown state lazily", async () => {
    const source = sourceWithGuards({
      dedupe: {
        enabled: false,
        ttlSeconds: 3600,
      },
      rateLimit: {
        enabled: false,
        maxRequests: 20,
        windowSeconds: 60,
      },
      cooldown: {
        enabled: true,
        seconds: 1,
      },
    })

    await Webhook.markCooldown(source, "run_test", 1000)
    const decision = await Webhook.evaluateRequestGuards(source, renderContext(source, 2500))
    const stored = await Storage.read(["webhook_guard", "cooldown", source.id]).catch(() => undefined)

    expect(decision.allowed).toBe(true)
    expect(stored).toBeUndefined()
  })
})
