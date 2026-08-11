import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import type { RuntimeToolCatalog } from "../../src/runtime/tool/catalog"
import { PlatformToolExecutor } from "../../src/runtime/tool/executor"
import { RuntimeToolRegistry } from "../../src/runtime/tool/registry"
import { tmpdir } from "../fixture/fixture"

describe("PlatformToolExecutor", () => {
  afterEach(() => {
    RuntimeToolRegistry.clearForTesting()
  })

  test("parses and authorizes arguments after the before hook mutation", async () => {
    const order: string[] = []
    const reference = registeredReference({
      parse(input) {
        order.push(`parse:${(input as { documentId: string }).documentId}`)
        return input as { documentId: string }
      },
      permission(input: { documentId: string }) {
        order.push(`permission:${input.documentId}`)
        return { permission: "demo_read", patterns: [input.documentId] }
      },
      async execute(input: { documentId: string }) {
        order.push(`execute:${input.documentId}`)
        return { status: "ok", title: "Read", output: "ok" }
      },
    })

    const result = await PlatformToolExecutor.execute(baseInput(reference, {
      rawInput: { documentId: "old" },
      beforeHook: async (payload) => {
        order.push("before")
        payload.args = { documentId: "new" }
      },
      askPermission: async (request) => {
        order.push(`ask:${request.patterns[0]}`)
      },
      afterHook: async () => {
        order.push("after")
      },
    }))

    expect(result.output).toBe("ok")
    expect(order).toEqual([
      "before",
      "parse:new",
      "permission:new",
      "ask:new",
      "execute:new",
      "after",
    ])
  })

  test("uses the tool ID wildcard permission by default", async () => {
    const reference = registeredReference()
    let permission: RuntimeToolRegistry.PermissionRequest | undefined

    const result = await PlatformToolExecutor.execute(baseInput(reference, {
      askPermission: async (request) => {
        permission = request
      },
    }))

    expect(result.output).toBe("ok")
    expect(permission).toEqual({
      permission: "demo_lookup",
      patterns: ["*"],
      always: ["*"],
    })
  })

  test("writes one argument-free audit record for each call", async () => {
    const reference = registeredReference()
    const audits: PlatformToolExecutor.AuditEntry[] = []
    await PlatformToolExecutor.execute(baseInput(reference, {
      rawInput: { fixture: "must-not-be-audited" },
      writeAudit: async (entry) => {
        audits.push(entry)
      },
    }))

    expect(audits).toEqual([
      expect.objectContaining({
        ownerID: "demo",
        toolID: "demo_lookup",
        generation: 1,
        declarationSource: "session-profile",
        permissionOutcome: "allowed",
        status: "ok",
      }),
    ])
    expect(JSON.stringify(audits)).not.toContain("must-not-be-audited")
  })

  test("rechecks generation after pending permission and never runs either definition", async () => {
    let oldExecutions = 0
    let newExecutions = 0
    let releasePermission: (() => void) | undefined
    let permissionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve
    })
    const reference = registeredReference({
      execute: async () => {
        oldExecutions += 1
        return { status: "ok", title: "old", output: "old" }
      },
    })

    const pending = PlatformToolExecutor.execute(baseInput(reference, {
      askPermission: async () => {
        permissionStarted?.()
        await new Promise<void>((resolve) => {
          releasePermission = resolve
        })
      },
    }))
    await started

    RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [definition({
        execute: async () => {
          newExecutions += 1
          return { status: "ok", title: "new", output: "new" }
        },
      })],
    })
    releasePermission?.()

    const result = await pending
    expect(failureCode(result)).toBe("stale-generation")
    expect(oldExecutions).toBe(0)
    expect(newExecutions).toBe(0)
  })

  test("rechecks invocation availability after pending permission before execution", async () => {
    let availabilityStatus: "available" | "auth-required" = "available"
    let availabilityChecks = 0
    let executions = 0
    let releasePermission: (() => void) | undefined
    let permissionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve
    })
    const reference = registeredReference({
      availability: () => {
        availabilityChecks += 1
        return availabilityStatus === "available"
          ? { status: "available" }
          : { status: "auth-required", reason: "expired-session" }
      },
      execute: async () => {
        executions += 1
        return { status: "ok", title: "unexpected", output: "unexpected" }
      },
    })

    const pending = PlatformToolExecutor.execute(baseInput(reference, {
      askPermission: async () => {
        permissionStarted?.()
        await new Promise<void>((resolve) => {
          releasePermission = resolve
        })
      },
    }))
    await started
    availabilityStatus = "auth-required"
    releasePermission?.()

    const result = await pending
    expect(failureCode(result)).toBe("auth-required")
    expect(availabilityChecks).toBe(2)
    expect(executions).toBe(0)
  })

  test("rechecks generation after the final asynchronous availability gate", async () => {
    let availabilityChecks = 0
    let oldExecutions = 0
    let newExecutions = 0
    let releaseAvailability: ((value: RuntimeToolRegistry.Availability) => void) | undefined
    let finalAvailabilityStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      finalAvailabilityStarted = resolve
    })
    const reference = registeredReference({
      async availability() {
        availabilityChecks += 1
        if (availabilityChecks === 1) return { status: "available" }
        finalAvailabilityStarted?.()
        return new Promise<RuntimeToolRegistry.Availability>((resolve) => {
          releaseAvailability = resolve
        })
      },
      execute: async () => {
        oldExecutions += 1
        return { status: "ok", title: "old", output: "old" }
      },
    })

    const pending = PlatformToolExecutor.execute(baseInput(reference))
    await started
    RuntimeToolRegistry.registerOwner({
      owner: { id: "demo", kind: "platform", enabled: true },
      tools: [definition({
        execute: async () => {
          newExecutions += 1
          return { status: "ok", title: "new", output: "new" }
        },
      })],
    })
    releaseAvailability?.({ status: "available" })

    const result = await pending
    expect(failureCode(result)).toBe("stale-generation")
    expect(availabilityChecks).toBe(2)
    expect(oldExecutions).toBe(0)
    expect(newExecutions).toBe(0)
  })

  test("does not yield between the final availability gate and implementation start", async () => {
    let available = true
    let availableAtExecution: boolean | undefined
    const reference = registeredReference({
      availability: () => ({ status: available ? "available" : "auth-required" }),
      execute: async () => {
        availableAtExecution = available
        return { status: "ok", title: "Demo", output: "ok" }
      },
    })

    const result = await PlatformToolExecutor.execute(baseInput(reference, {
      createTimeout: () => {
        const controller = new AbortController()
        queueMicrotask(() => {
          available = false
        })
        return {
          signal: controller.signal,
          elapsed: new Promise<void>(() => undefined),
          dispose: () => undefined,
        }
      },
    }))

    expect(result.output).toBe("ok")
    expect(availableAtExecution).toBe(true)
  })

  test("rechecks the resolved permission against current resource-level denies", async () => {
    let denied = false
    let executions = 0
    const reference = registeredReference({
      permission: () => ({
        permission: "demo_read",
        patterns: ["secret-document"],
      }),
      execute: async () => {
        executions += 1
        return { status: "ok", title: "unexpected", output: "unexpected" }
      },
    })

    const result = await PlatformToolExecutor.execute(baseInput(reference, {
      askPermission: async () => {
        denied = true
      },
      isPermissionDenied: async (request) => (
        denied &&
        request.permission === "demo_read" &&
        request.patterns.includes("secret-document")
      ),
    }))

    expect(failureCode(result)).toBe("permission-denied")
    expect(executions).toBe(0)
  })

  test("checks exposure before hooks and again after pending permission", async () => {
    const reference = registeredReference()
    let hooks = 0
    let asks = 0
    const deniedBefore = await PlatformToolExecutor.execute(baseInput(reference, {
      beforeHook: async () => {
        hooks += 1
      },
      askPermission: async () => {
        asks += 1
      },
      isExposureDenied: async () => true,
    }))
    expect(failureCode(deniedBefore)).toBe("permission-denied")
    expect(hooks).toBe(0)
    expect(asks).toBe(0)

    let denied = false
    let releasePermission: (() => void) | undefined
    let permissionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve
    })
    const pending = PlatformToolExecutor.execute(baseInput(reference, {
      isExposureDenied: async () => denied,
      askPermission: async () => {
        permissionStarted?.()
        await new Promise<void>((resolve) => {
          releasePermission = resolve
        })
      },
    }))
    await started
    denied = true
    releasePermission?.()

    const deniedAfter = await pending
    expect(failureCode(deniedAfter)).toBe("permission-denied")
  })

  test("fails closed for invalid input and permission resolution without leaking exceptions", async () => {
    const secret = "resolver-fixture-secret"
    const audits: unknown[] = []
    const published: unknown[] = []
    let executions = 0
    const invalidInput = registeredReference({
      parse() {
        throw new Error(`token=${secret}`)
      },
      execute: async () => {
        executions += 1
        return { status: "ok", title: "unexpected", output: "unexpected" }
      },
    })
    const parsed = await PlatformToolExecutor.execute(baseInput(invalidInput, {
      writeAudit: async (entry) => {
        audits.push(entry)
      },
      publishFailure: async (failure) => {
        published.push(failure)
      },
    }))
    expect(failureCode(parsed)).toBe("invalid-input")

    RuntimeToolRegistry.clearForTesting()
    const invalidPermission = registeredReference({
      permission() {
        throw new Error(`Authorization: Bearer ${secret}`)
      },
      execute: async () => {
        executions += 1
        return { status: "ok", title: "unexpected", output: "unexpected" }
      },
    })
    const permission = await PlatformToolExecutor.execute(baseInput(invalidPermission, {
      writeAudit: async (entry) => {
        audits.push(entry)
      },
      publishFailure: async (failure) => {
        published.push(failure)
      },
    }))

    expect(failureCode(permission)).toBe("permission-resolution-failed")
    expect(executions).toBe(0)
    expect(JSON.stringify({ parsed, permission, audits, published })).not.toContain(secret)
    expect(published).toEqual([
      expect.objectContaining({ code: "permission-resolution-failed", stage: "execute" }),
    ])

    RuntimeToolRegistry.clearForTesting()
    const emptyPermission = await PlatformToolExecutor.execute(baseInput(registeredReference({
      permission: () => ({ permission: "", patterns: [] }),
    })))
    expect(failureCode(emptyPermission)).toBe("permission-resolution-failed")
  })

  test("rethrows permission rejection without publishing a resource failure", async () => {
    const reference = registeredReference()
    let published = 0
    let executed = 0

    await expect(PlatformToolExecutor.execute(baseInput(reference, {
      askPermission: async () => {
        throw new PermissionNext.RejectedError()
      },
      publishFailure: async () => {
        published += 1
      },
      reference: {
        ...reference,
        definition: {
          ...reference.definition,
          execute: async () => {
            executed += 1
            return { status: "ok", title: "unexpected", output: "unexpected" }
          },
        },
      },
    }))).rejects.toBeInstanceOf(PermissionNext.RejectedError)

    expect(published).toBe(0)
    expect(executed).toBe(0)
  })

  test("fails closed when invocation availability throws, times out, or requires authentication", async () => {
    const cases: Array<{
      availability: RuntimeToolRegistry.Definition["availability"]
      expected: string
      expectedStage: "resolve" | "auth"
    }> = [
      {
        availability: () => {
          throw new Error("availability secret")
        },
        expected: "availability-check-failed",
        expectedStage: "resolve",
      },
      {
        availability: () => new Promise(() => {}),
        expected: "availability-check-failed",
        expectedStage: "resolve",
      },
      {
        availability: () => ({
          status: "auth-required",
          reason: "missing-auth",
          action: { type: "start-auth", label: "Authenticate demo" },
        }),
        expected: "auth-required",
        expectedStage: "auth",
      },
    ]

    for (const item of cases) {
      RuntimeToolRegistry.clearForTesting()
      let executions = 0
      const published: RuntimeResourceResolverFailure[] = []
      const reference = registeredReference({
        availability: item.availability,
        execute: async () => {
          executions += 1
          return { status: "ok", title: "unexpected", output: "unexpected" }
        },
      })
      const result = await PlatformToolExecutor.execute(baseInput(reference, {
        availabilityBudgetMs: 10,
        publishFailure: async (failure) => {
          published.push(failure)
        },
      }))
      expect(failureCode(result)).toBe(item.expected)
      expect(executions).toBe(0)
      expect(published).toEqual([
        expect.objectContaining({ code: item.expected, stage: item.expectedStage }),
      ])
    }
  })

  test("uses the minimum default, tool, and turn execution deadline", async () => {
    const cases = [
      { execution: undefined, turnDeadlineAt: undefined, now: 1_000, expected: 60_000 },
      { execution: { timeoutMs: 250 }, turnDeadlineAt: undefined, now: 1_000, expected: 250 },
      { execution: { timeoutMs: 250 }, turnDeadlineAt: 1_025, now: 1_000, expected: 25 },
    ] as const

    for (const item of cases) {
      RuntimeToolRegistry.clearForTesting()
      let executions = 0
      const reference = registeredReference({
        execution: item.execution,
        execute: async () => {
          executions += 1
          return new Promise(() => {})
        },
      })
      const observed: number[] = []
      let timeoutCalls = 0
      const result = await PlatformToolExecutor.execute(baseInput(reference, {
        turnDeadlineAt: item.turnDeadlineAt,
        now: () => item.now,
        createTimeout: (milliseconds) => {
          if (item.turnDeadlineAt !== undefined && timeoutCalls++ === 0) return dormantTimeout()
          return immediateTimeout(milliseconds, observed)
        },
      }))
      expect(observed).toEqual([item.expected])
      expect(failureCode(result)).toBe("execution-timeout")
      expect(executions).toBe(1)
    }
  })

  test("stops waiting when the session is cancelled even if the implementation ignores its signal", async () => {
    const controller = new AbortController()
    let executionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve
    })
    const reference = registeredReference({
      execute: async () => {
        executionStarted?.()
        return new Promise(() => {})
      },
    })
    const pending = PlatformToolExecutor.execute(baseInput(reference, {
      call: callContext(controller.signal),
    }))
    await started
    controller.abort()

    expect(failureCode(await pending)).toBe("cancelled")
  })

  test("stops waiting for a hanging before hook when the session is cancelled", async () => {
    const controller = new AbortController()
    let hookStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve
    })
    const pending = PlatformToolExecutor.execute(baseInput(registeredReference(), {
      call: callContext(controller.signal),
      beforeHook: async () => {
        hookStarted?.()
        return new Promise(() => {})
      },
    }))
    await started
    controller.abort()

    const result = await Promise.race([pending, Bun.sleep(1_000).then(() => undefined)])
    expect(result).toBeDefined()
    expect(failureCode(result!)).toBe("cancelled")
  })

  test("stops waiting for a hanging after hook at the turn deadline", async () => {
    const pending = PlatformToolExecutor.execute(baseInput(registeredReference(), {
      turnDeadlineAt: Date.now() + 30,
      afterHook: async () => new Promise(() => {}),
    }))

    const result = await Promise.race([pending, Bun.sleep(1_000).then(() => undefined)])
    expect(result).toBeDefined()
    expect(failureCode(result!)).toBe("execution-timeout")
  })

  test("cancels real pending permission requests on session abort and turn deadline", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const cancellationReasons: PermissionNext.CancellationReason[] = []
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Cancelled, (event) => {
          cancellationReasons.push(event.properties.reason)
        })
        try {
          for (const mode of ["cancel", "deadline"] as const) {
            RuntimeToolRegistry.clearForTesting()
            const controller = new AbortController()
            let expirePermissionDeadline: (() => void) | undefined
            let executions = 0
            const reference = registeredReference({
              permission: () => ({
                permission: "sandbox",
                patterns: ["*"],
                always: ["*"],
              }),
              execute: async () => {
                executions += 1
                return { status: "ok", title: "unexpected", output: "unexpected" }
              },
            })
            const pending = PlatformToolExecutor.execute(baseInput(reference, {
              call: {
                ...callContext(controller.signal),
                directory: project.path,
              },
              turnDeadlineAt: mode === "deadline" ? Date.now() + 60_000 : undefined,
              createTimeout: mode === "deadline"
                ? () => {
                    const deadline = new AbortController()
                    let resolveElapsed: (() => void) | undefined
                    const elapsed = new Promise<void>((resolve) => {
                      resolveElapsed = resolve
                    })
                    expirePermissionDeadline = () => {
                      deadline.abort(new DOMException("Platform tool deadline exceeded.", "TimeoutError"))
                      resolveElapsed?.()
                    }
                    return {
                      signal: deadline.signal,
                      elapsed,
                      dispose: () => undefined,
                    }
                  }
                : undefined,
              askPermission: (request, signal) => PermissionNext.ask({
                ...request,
                sessionID: "session_test",
                metadata: {},
                always: request.always ?? request.patterns,
                tool: {
                  messageID: "message_test",
                  callID: "call_test",
                },
                ruleset: [],
                signal,
              }),
            }))

            await waitForPendingPermission()
            if (mode === "cancel") controller.abort()
            else {
              expect(expirePermissionDeadline).toBeDefined()
              expirePermissionDeadline?.()
            }
            const result = await pending

            expect(failureCode(result)).toBe(mode === "cancel" ? "cancelled" : "execution-timeout")
            expect(executions).toBe(0)
            expect(await PermissionNext.list()).toEqual([])
            expect(cancellationReasons).toEqual(mode === "cancel" ? ["aborted"] : ["aborted", "timeout"])
          }
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("rejects thrown, malformed, and invalid-code platform results generically", async () => {
    const secret = "execute-fixture-secret"
    const implementations: Array<RuntimeToolRegistry.Definition["execute"]> = [
      async () => {
        throw new Error(`Bearer ${secret}`)
      },
      async () => ({ status: "ok", title: "missing-output" } as never),
      async () => ({
        status: "failed",
        code: "execution-failed",
        message: `token=${secret}`,
        recoverable: false,
      }),
      async () => ({
        status: "failed",
        code: "wrong-prefix",
        message: `token=${secret}`,
        recoverable: false,
      }),
      async () => ({
        status: "failed",
        code: `demo-Authorization: Bearer ${secret}`,
        message: "malformed business code",
        recoverable: false,
      }),
    ]

    for (const execute of implementations) {
      RuntimeToolRegistry.clearForTesting()
      const result = await PlatformToolExecutor.execute(baseInput(registeredReference({ execute })))
      expect(failureCode(result)).toBe("execution-failed")
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  test("accepts owner-prefixed business failures and keeps their message sanitized", async () => {
    const secret = "business-result-secret"
    const published: RuntimeResourceResolverFailure[] = []
    const reference = registeredReference({
      execute: async () => ({
        status: "failed",
        code: "demo-document-not-found",
        message: `Document missing; token=${secret}`,
        recoverable: true,
      }),
    })

    const result = await PlatformToolExecutor.execute(baseInput(reference, {
      publishFailure: async (failure) => {
        published.push(failure)
      },
    }))

    expect(failureCode(result)).toBe("demo-document-not-found")
    expect(result.output).toContain("token=[REDACTED]")
    expect(JSON.stringify({ result, published })).not.toContain(secret)
    expect(published).toEqual([
      expect.objectContaining({
        code: "demo-document-not-found",
        stage: "execute",
      }),
    ])
  })

  test("sanitizes and truncates progress and post-hook result mutations", async () => {
    const secret = "result-fixture-secret"
    const progress: unknown[] = []
    const cyclic: Record<string, unknown> = { safe: "value", token: secret }
    cyclic.self = cyclic
    const reference = registeredReference({
      execute: async (_input, ctx) => {
        await ctx.reportProgress({
          title: `Authorization: Bearer ${secret}`,
          metadata: cyclic,
        })
        return {
          status: "ok",
          title: `token=${secret}`,
          output: `Authorization: Bearer ${secret}\n${"x".repeat(60 * 1024)}`,
          metadata: {
            huge: "x".repeat(40 * 1024),
            secret,
            fn: () => secret,
            cycle: cyclic,
            attachments: [secret],
          },
        }
      },
    })

    const result = await PlatformToolExecutor.execute(baseInput(reference, {
      call: {
        ...callContext(),
        reportProgress: async (item) => {
          progress.push(item)
        },
      },
      afterHook: async (output) => {
        output.title = `password=${secret}`
        output.output = `token=${secret}\n${"y".repeat(60 * 1024)}`
        output.metadata = {
          ...output.metadata,
          cookie: secret,
          files: [secret],
        }
        Object.assign(output, { attachments: [secret] })
      },
    }))

    expect(Object.keys(result).sort()).toEqual(["metadata", "output", "title"])
    expect(JSON.stringify({ result, progress })).not.toContain(secret)
    expect(result.title).toBe("password=[REDACTED]")
    expect(result.metadata.truncated).toBe(true)
    expect(result.metadata).not.toHaveProperty("files")
    expect(result).not.toHaveProperty("attachments")
    expect(progress).toHaveLength(1)
  })
})

function baseInput(
  reference: RuntimeToolCatalog.ResolvedReference,
  overrides: Partial<PlatformToolExecutor.Input> = {},
): PlatformToolExecutor.Input {
  return {
    reference,
    rawInput: {},
    call: callContext(),
    askPermission: async () => undefined,
    isExposureDenied: async () => false,
    isPermissionDenied: async () => false,
    publishFailure: async () => undefined,
    clearFailure: () => undefined,
    writeAudit: async () => undefined,
    ...overrides,
  }
}

function registeredReference(
  overrides: Partial<RuntimeToolRegistry.Definition> = {},
): RuntimeToolCatalog.ResolvedReference {
  RuntimeToolRegistry.registerOwner({
    owner: { id: "demo", kind: "platform", enabled: true },
    tools: [definition(overrides)],
  })
  const reference = RuntimeToolRegistry.get("demo_lookup")!
  return {
    id: reference.id,
    ownerID: reference.ownerID,
    generation: reference.generation,
    definition: reference.definition,
    availability: { status: "available" },
  }
}

function definition(
  overrides: Partial<RuntimeToolRegistry.Definition> = {},
): RuntimeToolRegistry.Definition {
  return {
    id: "demo_lookup",
    description: "Look up a demo record.",
    catalogVisibility: "declared-only",
    inputSchema: { type: "object" },
    parse: (input) => input,
    execute: async () => ({
      status: "ok",
      title: "Demo",
      output: "ok",
    }),
    ...overrides,
  }
}

function callContext(signal = new AbortController().signal): RuntimeToolRegistry.CallContext {
  return {
    sessionId: "session_test",
    projectId: "project_test",
    directory: "C:\\test",
    agent: "build",
    templateIds: ["test"],
    messageId: "message_test",
    callId: "call_test",
    signal,
    reportProgress: async () => undefined,
  }
}

function failureCode(result: PlatformToolExecutor.Result) {
  return typeof result.metadata.code === "string" ? result.metadata.code : undefined
}

function immediateTimeout(milliseconds: number, observed: number[]): PlatformToolExecutor.TimeoutHandle {
  observed.push(milliseconds)
  const controller = new AbortController()
  return {
    signal: controller.signal,
    elapsed: Promise.resolve().then(() => {
      controller.abort()
    }),
    dispose: () => undefined,
  }
}

function dormantTimeout(): PlatformToolExecutor.TimeoutHandle {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    elapsed: new Promise<void>(() => undefined),
    dispose: () => undefined,
  }
}

async function waitForPendingPermission() {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await PermissionNext.list()).length > 0) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for a pending permission request.")
}

type RuntimeResourceResolverFailure = Parameters<NonNullable<PlatformToolExecutor.Input["publishFailure"]>>[0]
