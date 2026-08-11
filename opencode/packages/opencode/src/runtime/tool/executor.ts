import { Log } from "@/util/log"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import { Truncate } from "@/tool/truncation"
import { isPlatformToolRuntimeCode, type PlatformToolRuntimeCode } from "./errors"
import {
  PLATFORM_TOOL_AVAILABILITY_BUDGET_MS,
  type RuntimeToolCatalog,
} from "./catalog"
import { RuntimeToolRegistry } from "./registry"
import {
  sanitizePlatformToolDiagnostic,
  sanitizePlatformToolRecord,
  sanitizePlatformToolText,
} from "./sanitize"

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000
const MAX_EXECUTION_TIMEOUT_MS = 5 * 60_000
const BUSINESS_FAILURE_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/
const MAX_BUSINESS_FAILURE_CODE_LENGTH = 128

export namespace PlatformToolExecutor {
  const log = Log.create({ service: "runtime.platform-tool-executor" })

  export type Result = {
    title: string
    output: string
    metadata: Record<string, unknown>
  }

  export type BeforeHookPayload = {
    args: unknown
  }

  export type AuditEntry = {
    ownerID: string
    toolID: string
    generation: number
    declarationSource: "session-profile"
    permissionOutcome: "not-requested" | "allowed" | "denied" | "cancelled"
    durationMs: number
    status: "ok" | "failed"
    code?: string
  }

  export type TimeoutHandle = {
    signal: AbortSignal
    elapsed: Promise<void>
    dispose(): void
  }

  export type Input = {
    reference: RuntimeToolCatalog.ResolvedReference
    rawInput: unknown
    call: RuntimeToolRegistry.CallContext
    beforeHook?(payload: BeforeHookPayload): Promise<void>
    afterHook?(result: Result): Promise<void>
    askPermission(
      request: RuntimeToolRegistry.PermissionRequest,
      signal: AbortSignal,
    ): Promise<void>
    isExposureDenied(toolID: string): boolean | Promise<boolean>
    isPermissionDenied(request: RuntimeToolRegistry.PermissionRequest): boolean | Promise<boolean>
    turnDeadlineAt?: number
    availabilityBudgetMs?: number
    now?: () => number
    createTimeout?: (milliseconds: number) => TimeoutHandle
    publishFailure?: (failure: RuntimeResourceResolver.ResourceFailure) => void | Promise<void>
    clearFailure?: () => void
    writeAudit?: (entry: AuditEntry) => void | Promise<void>
  }

  type CanonicalResult = {
    status?: "failed" | "unavailable" | "auth-required"
    code?: string
    recoverable?: boolean
    action?: RuntimeToolRegistry.Availability["action"]
  }

  type AvailabilityResult =
    | { kind: "allowed" }
    | { kind: "cancelled" }
    | {
        kind: "blocked"
        code: PlatformToolRuntimeCode
        message: string
        recoverable: boolean
        status?: "failed" | "unavailable" | "auth-required"
        action?: RuntimeToolRegistry.Availability["action"]
        stage?: RuntimeResourceResolver.ResourceFailure["stage"]
      }

  export async function execute(input: Input): Promise<Result> {
    const now = input.now ?? Date.now
    const startedAt = now()
    let permissionOutcome: AuditEntry["permissionOutcome"] = "not-requested"
    let audited = false

    const writeAudit = async (status: AuditEntry["status"], code?: string) => {
      if (audited) return
      audited = true
      const entry: AuditEntry = {
        ownerID: input.reference.ownerID,
        toolID: input.reference.id,
        generation: input.reference.generation,
        declarationSource: "session-profile",
        permissionOutcome,
        durationMs: Math.max(0, now() - startedAt),
        status,
        ...(code ? { code } : {}),
      }
      try {
        if (input.writeAudit) await input.writeAudit(entry)
        else log.info("platform tool call", entry)
      } catch {
        log.warn("failed to write platform tool audit", {
          ownerID: entry.ownerID,
          toolID: entry.toolID,
          generation: entry.generation,
        })
      }
    }

    const finishFailure = async (options: {
      code: string
      message: string
      recoverable: boolean
      status?: "failed" | "unavailable" | "auth-required"
      action?: RuntimeToolRegistry.Availability["action"]
      publish?: boolean
      stage?: RuntimeResourceResolver.ResourceFailure["stage"]
    }) => {
      const status = options.status ?? "failed"
      const message = sanitizePlatformToolText(options.message)
      const action = normalizeAction(options.action)
      if (options.publish !== false) {
        await publishFailure(input, {
          resourceType: "tool",
          resourceID: input.reference.id,
          ownerID: input.reference.ownerID,
          generation: input.reference.generation,
          code: options.code,
          status: status === "auth-required" ? "auth-required" : status === "unavailable" ? "unavailable" : "degraded",
          stage: options.stage ?? (status === "auth-required" ? "auth" : "execute"),
          reason: options.code,
          message,
          recoverable: options.recoverable,
          ...(action ? { action } : {}),
        })
      }
      await writeAudit("failed", options.code)
      return failureResult({
        code: options.code,
        message,
        recoverable: options.recoverable,
        status,
        action,
      })
    }

    if (!isCurrent(input.reference)) {
      return finishFailure({
        code: "stale-generation",
        message: "The platform tool definition changed before execution. Retry on the next turn.",
        recoverable: true,
        status: "unavailable",
        publish: false,
      })
    }
    if (input.call.signal.aborted) {
      permissionOutcome = "cancelled"
      return finishFailure({
        code: "cancelled",
        message: "The platform tool call was cancelled.",
        recoverable: true,
        publish: false,
      })
    }
    if (await exposureDenied(input)) {
      permissionOutcome = "denied"
      return finishFailure({
        code: "permission-denied",
        message: "The platform tool is disabled by the current permission policy.",
        recoverable: false,
        publish: false,
      })
    }

    const hookPayload: BeforeHookPayload = { args: input.rawInput }
    if (input.beforeHook) {
      const preparation = await runWithDeadline(
        input,
        now,
        DEFAULT_EXECUTION_TIMEOUT_MS,
        () => input.beforeHook!(hookPayload),
      )
      if (preparation.kind === "cancelled") {
        permissionOutcome = "cancelled"
        return finishFailure({
          code: "cancelled",
          message: "The platform tool call was cancelled while preparing the call.",
          recoverable: true,
          publish: false,
        })
      }
      if (preparation.kind === "timeout") {
        return finishFailure({
          code: "execution-timeout",
          message: "The platform tool call timed out while preparing the call.",
          recoverable: true,
        })
      }
      if (preparation.kind === "threw") {
        return finishFailure({
          code: "execution-failed",
          message: "The platform tool could not prepare the call.",
          recoverable: false,
        })
      }
    }

    let parsed: unknown
    try {
      parsed = input.reference.definition.parse(hookPayload.args)
    } catch {
      return finishFailure({
        code: "invalid-input",
        message: "The platform tool input is invalid. Correct the arguments and retry.",
        recoverable: true,
        publish: false,
      })
    }

    const availability = await invocationAvailability(input)
    if (availability.kind === "cancelled") {
      permissionOutcome = "cancelled"
      return finishFailure({
        code: "cancelled",
        message: "The platform tool call was cancelled.",
        recoverable: true,
        publish: false,
      })
    }
    if (availability.kind === "blocked") {
      return finishFailure({
        code: availability.code,
        message: availability.message,
        recoverable: availability.recoverable,
        status: availability.status,
        action: availability.action,
        stage: availability.stage,
      })
    }

    const permission = resolvePermission(input.reference, parsed)
    if (!permission) {
      return finishFailure({
        code: "permission-resolution-failed",
        message: "The platform tool could not resolve a valid permission request.",
        recoverable: false,
      })
    }

    permissionOutcome = "allowed"
    const permissionWait = await waitForPermission(input, permission, now)
    if (permissionWait.kind === "cancelled") {
      permissionOutcome = "cancelled"
      return finishFailure({
        code: "cancelled",
        message: "The platform tool call was cancelled while waiting for permission.",
        recoverable: true,
        publish: false,
      })
    }
    if (permissionWait.kind === "timeout") {
      permissionOutcome = "cancelled"
      return finishFailure({
        code: "execution-timeout",
        message: "The platform tool call exceeded the current turn deadline while waiting for permission.",
        recoverable: true,
      })
    }
    if (permissionWait.kind === "rejected") {
      permissionOutcome = "denied"
      await writeAudit("failed", "permission-denied")
      throw permissionWait.error
    }

    if (await permissionDenied(input, permission)) {
      permissionOutcome = "denied"
      return finishFailure({
        code: "permission-denied",
        message: "The platform tool call is disabled by the current resource permission policy.",
        recoverable: false,
        publish: false,
      })
    }
    if (await exposureDenied(input)) {
      permissionOutcome = "denied"
      return finishFailure({
        code: "permission-denied",
        message: "The platform tool is disabled by the current permission policy.",
        recoverable: false,
        publish: false,
      })
    }
    if (!isCurrent(input.reference)) {
      return finishFailure({
        code: "stale-generation",
        message: "The platform tool definition changed while permission was pending. Retry on the next turn.",
        recoverable: true,
        status: "unavailable",
        publish: false,
      })
    }

    const currentAvailability = await invocationAvailability(input)
    if (currentAvailability.kind === "cancelled") {
      permissionOutcome = "cancelled"
      return finishFailure({
        code: "cancelled",
        message: "The platform tool call was cancelled.",
        recoverable: true,
        publish: false,
      })
    }
    if (currentAvailability.kind === "blocked") {
      return finishFailure({
        code: currentAvailability.code,
        message: currentAvailability.message,
        recoverable: currentAvailability.recoverable,
        status: currentAvailability.status,
        action: currentAvailability.action,
        stage: currentAvailability.stage,
      })
    }
    if (!isCurrent(input.reference)) {
      return finishFailure({
        code: "stale-generation",
        message: "The platform tool definition changed during the final availability check. Retry on the next turn.",
        recoverable: true,
        status: "unavailable",
        publish: false,
      })
    }

    const execution = await executeWithDeadline(input, parsed, now)
    if (execution.kind === "stale-generation") {
      return finishFailure({
        code: "stale-generation",
        message: "The platform tool definition changed before execution. Retry on the next turn.",
        recoverable: true,
        status: "unavailable",
        publish: false,
      })
    }
    if (execution.kind === "cancelled") {
      permissionOutcome = "cancelled"
      return finishFailure({
        code: "cancelled",
        message: "The platform tool call was cancelled.",
        recoverable: true,
        publish: false,
      })
    }
    if (execution.kind === "timeout") {
      return finishFailure({
        code: "execution-timeout",
        message: "The platform tool execution timed out.",
        recoverable: true,
      })
    }
    if (execution.kind === "threw") {
      return finishFailure({
        code: "execution-failed",
        message: "The platform tool execution failed.",
        recoverable: false,
      })
    }

    const normalized = await normalizePlatformResult(input.reference, execution.result).catch(() => undefined)
    if (!normalized) {
      return finishFailure({
        code: "execution-failed",
        message: "The platform tool returned an invalid result.",
        recoverable: false,
      })
    }

    if (input.afterHook) {
      const finalization = await runWithDeadline(
        input,
        now,
        DEFAULT_EXECUTION_TIMEOUT_MS,
        () => input.afterHook!(normalized.result),
      )
      if (finalization.kind === "cancelled") {
        permissionOutcome = "cancelled"
        return finishFailure({
          code: "cancelled",
          message: "The platform tool call was cancelled while finalizing the result.",
          recoverable: true,
          publish: false,
        })
      }
      if (finalization.kind === "timeout") {
        return finishFailure({
          code: "execution-timeout",
          message: "The platform tool call timed out while finalizing the result.",
          recoverable: true,
        })
      }
      if (finalization.kind === "threw") {
        return finishFailure({
          code: "execution-failed",
          message: "The platform tool result could not be finalized.",
          recoverable: false,
        })
      }
    }

    const final = await finalizeResult(normalized.result, normalized.canonical).catch(() => undefined)
    if (!final) {
      return finishFailure({
        code: "execution-failed",
        message: "The platform tool returned an invalid final result.",
        recoverable: false,
      })
    }

    if (normalized.canonical.code) {
      await publishFailure(input, {
        resourceType: "tool",
        resourceID: input.reference.id,
        ownerID: input.reference.ownerID,
        generation: input.reference.generation,
        code: normalized.canonical.code,
        status: normalized.canonical.status === "auth-required"
          ? "auth-required"
          : normalized.canonical.status === "unavailable"
            ? "unavailable"
            : "degraded",
        stage: normalized.canonical.status === "auth-required" ? "auth" : "execute",
        reason: normalized.canonical.code,
        message: `Platform tool "${input.reference.id}" reported failure code "${normalized.canonical.code}".`,
        recoverable: normalized.canonical.recoverable ?? false,
        ...(normalized.canonical.action ? { action: normalized.canonical.action } : {}),
      })
      await writeAudit("failed", normalized.canonical.code)
      return final
    }

    clearFailure(input)
    await writeAudit("ok")
    return final
  }

  function isCurrent(reference: RuntimeToolCatalog.ResolvedReference) {
    const current = RuntimeToolRegistry.get(reference.id)
    return Boolean(
      current &&
      current.ownerID === reference.ownerID &&
      current.generation === reference.generation &&
      current.owner.enabled,
    )
  }

  async function exposureDenied(input: Input) {
    try {
      return (await input.isExposureDenied(input.reference.id)) === true
    } catch {
      return true
    }
  }

  async function permissionDenied(
    input: Input,
    request: RuntimeToolRegistry.PermissionRequest,
  ) {
    try {
      return (await input.isPermissionDenied(request)) === true
    } catch {
      return true
    }
  }

  async function invocationAvailability(input: Input): Promise<AvailabilityResult> {
    const callback = input.reference.definition.availability
    if (!callback) return { kind: "allowed" }
    if (input.call.signal.aborted) return { kind: "cancelled" }

    const budgetMs = normalizePositiveDuration(
      input.availabilityBudgetMs,
      PLATFORM_TOOL_AVAILABILITY_BUDGET_MS,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budgetMs)
    })
    const cancellation = watchAbort(input.call.signal)
    const check = Promise.resolve()
      .then(() => callback(resolveContext(input.call)))
      .then((value) => ({ kind: "value" as const, value }))
      .catch(() => ({ kind: "invalid" as const }))

    try {
      const outcome = await Promise.race([
        check,
        timeout.then(() => ({ kind: "timeout" as const })),
        cancellation.promise.then(() => ({ kind: "cancelled" as const })),
      ])
      if (outcome.kind === "cancelled") return { kind: "cancelled" }
      if (outcome.kind === "timeout" || outcome.kind === "invalid") {
        return {
          kind: "blocked",
          code: "availability-check-failed",
          message: "The platform tool availability check failed.",
          recoverable: true,
          stage: "resolve",
        }
      }

      let availability: RuntimeToolRegistry.Availability | undefined
      try {
        availability = normalizeAvailability(outcome.value)
      } catch {
        availability = undefined
      }
      if (!availability) {
        return {
          kind: "blocked",
          code: "availability-check-failed",
          message: "The platform tool availability check returned an invalid result.",
          recoverable: true,
          stage: "resolve",
        }
      }
      if (
        availability.status === "available" ||
        availability.status === "unknown" ||
        availability.status === "degraded"
      ) {
        return { kind: "allowed" }
      }
      if (availability.status === "auth-required") {
        return {
          kind: "blocked",
          code: "auth-required",
          message: availability.reason
            ? `The platform tool requires authentication (${availability.reason}).`
            : "The platform tool requires authentication.",
          recoverable: true,
          status: "auth-required",
          action: availability.action,
          stage: "auth",
        }
      }
      return {
        kind: "blocked",
        code: "tool-missing",
        message: availability.reason
          ? `The platform tool is currently unavailable (${availability.reason}).`
          : "The platform tool is currently unavailable.",
        recoverable: true,
        status: "unavailable",
        action: availability.action,
        stage: "resolve",
      }
    } finally {
      if (timer) clearTimeout(timer)
      cancellation.dispose()
    }
  }

  function resolvePermission(
    reference: RuntimeToolCatalog.ResolvedReference,
    parsed: unknown,
  ): RuntimeToolRegistry.PermissionRequest | undefined {
    try {
      const candidate = reference.definition.permission
        ? reference.definition.permission(parsed)
        : { permission: reference.id, patterns: ["*"], always: ["*"] }
      if (!isRecord(candidate)) return undefined
      if (typeof candidate.permission !== "string" || !candidate.permission.trim()) return undefined
      if (!isNonEmptyStringArray(candidate.patterns)) return undefined
      if (candidate.always !== undefined && !isNonEmptyStringArray(candidate.always)) return undefined
      return {
        permission: candidate.permission,
        patterns: [...candidate.patterns],
        ...(candidate.always !== undefined ? { always: [...candidate.always] } : {}),
      }
    } catch {
      return undefined
    }
  }

  async function waitForPermission(
    input: Input,
    permission: RuntimeToolRegistry.PermissionRequest,
    now: () => number,
  ): Promise<
    | { kind: "allowed" }
    | { kind: "cancelled" }
    | { kind: "timeout" }
    | { kind: "rejected"; error: unknown }
  > {
    if (input.call.signal.aborted) return { kind: "cancelled" }
    const turnRemaining = input.turnDeadlineAt === undefined ? undefined : input.turnDeadlineAt - now()
    if (turnRemaining !== undefined && turnRemaining <= 0) return { kind: "timeout" }

    const turnTimeout = turnRemaining === undefined
      ? undefined
      : (input.createTimeout ?? defaultTimeout)(Math.max(1, turnRemaining))
    const combined = combineSignals([
      input.call.signal,
      ...(turnTimeout ? [turnTimeout.signal] : []),
    ])
    const cancellation = watchAbort(input.call.signal)
    const asked = Promise.resolve()
      .then(() => input.askPermission(permission, combined.signal))
      .then(
        () => ({ kind: "allowed" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      )

    try {
      const outcome = await Promise.race([
        asked,
        cancellation.promise.then(() => ({ kind: "cancelled" as const })),
        ...(turnTimeout ? [turnTimeout.elapsed.then(() => ({ kind: "timeout" as const }))] : []),
      ])
      if (input.call.signal.aborted) return { kind: "cancelled" }
      if (turnTimeout?.signal.aborted && outcome.kind === "rejected") return { kind: "timeout" }
      return outcome
    } finally {
      cancellation.dispose()
      combined.dispose()
      turnTimeout?.dispose()
    }
  }

  async function executeWithDeadline(input: Input, parsed: unknown, now: () => number) {
    const toolLimit = input.reference.definition.execution?.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
    const execution = await runWithDeadline(input, now, toolLimit, async (signal) => {
      if (!isCurrent(input.reference)) return { kind: "stale-generation" as const }
      const call: RuntimeToolRegistry.CallContext = {
        ...input.call,
        signal,
        reportProgress: async (progress) => {
          await input.call.reportProgress({
            ...(progress.title !== undefined
              ? { title: sanitizePlatformToolDiagnostic(progress.title) }
              : {}),
            ...(progress.metadata !== undefined
              ? { metadata: sanitizePlatformToolRecord(progress.metadata) }
              : {}),
          })
        },
      }
      return {
        kind: "executed" as const,
        result: await input.reference.definition.execute(parsed, call),
      }
    })
    if (execution.kind !== "result") return execution
    if (execution.result.kind === "stale-generation") return { kind: "stale-generation" as const }
    return { kind: "result" as const, result: execution.result.result }
  }

  async function runWithDeadline<T>(
    input: Input,
    now: () => number,
    timeoutLimitMs: number,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<
    | { kind: "result"; result: T }
    | { kind: "threw" }
    | { kind: "timeout" }
    | { kind: "cancelled" }
  > {
    if (input.call.signal.aborted) return { kind: "cancelled" }
    const turnRemaining = input.turnDeadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : input.turnDeadlineAt - now()
    if (turnRemaining <= 0) return { kind: "timeout" }

    const effectiveTimeoutMs = Math.min(timeoutLimitMs, MAX_EXECUTION_TIMEOUT_MS, turnRemaining)
    const timeout = (input.createTimeout ?? defaultTimeout)(Math.max(1, effectiveTimeoutMs))
    const combined = combineSignals([input.call.signal, timeout.signal])
    const cancellation = watchAbort(input.call.signal)
    const pending = (async () => task(combined.signal))()
      .then(
        (result) => ({ kind: "result" as const, result }),
        () => ({ kind: "threw" as const }),
      )

    try {
      const outcome = await Promise.race([
        pending,
        timeout.elapsed.then(() => ({ kind: "timeout" as const })),
        cancellation.promise.then(() => ({ kind: "cancelled" as const })),
      ])
      if (input.call.signal.aborted) return { kind: "cancelled" }
      return outcome
    } finally {
      cancellation.dispose()
      combined.dispose()
      timeout.dispose()
    }
  }

  async function normalizePlatformResult(
    reference: RuntimeToolCatalog.ResolvedReference,
    input: unknown,
  ): Promise<{ result: Result; canonical: CanonicalResult } | undefined> {
    if (!isRecord(input) || typeof input.status !== "string") return undefined
    if (input.status === "ok") {
      if (typeof input.title !== "string" || typeof input.output !== "string") return undefined
      const canonical: CanonicalResult = {}
      return {
        result: await finalizeResult({
          title: input.title,
          output: input.output,
          metadata: sanitizePlatformToolRecord(input.metadata),
        }, canonical),
        canonical,
      }
    }

    if (input.status !== "failed" && input.status !== "unavailable" && input.status !== "auth-required") {
      return undefined
    }
    if (
      typeof input.code !== "string" ||
      !input.code.trim() ||
      typeof input.message !== "string" ||
      typeof input.recoverable !== "boolean"
    ) {
      return undefined
    }
    const businessPrefix = `${reference.ownerID.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-`
    if (
      input.code.length > MAX_BUSINESS_FAILURE_CODE_LENGTH ||
      !BUSINESS_FAILURE_CODE.test(input.code) ||
      isPlatformToolRuntimeCode(input.code) ||
      !input.code.startsWith(businessPrefix)
    ) {
      return undefined
    }
    const action = normalizeAction(input.action)
    if (input.action !== undefined && !action) return undefined
    const canonical: CanonicalResult = {
      status: input.status,
      code: input.code,
      recoverable: input.recoverable,
      ...(action ? { action } : {}),
    }
    return {
      result: await finalizeResult({
        title: input.status === "auth-required" ? "Authentication required" : "Platform tool failed",
        output: input.message,
        metadata: {},
      }, canonical),
      canonical,
    }
  }

  async function finalizeResult(input: Result, canonical: CanonicalResult): Promise<Result> {
    if (typeof input.title !== "string" || typeof input.output !== "string") {
      throw new Error("Invalid platform tool result text.")
    }
    const title = sanitizePlatformToolDiagnostic(input.title)
    const truncated = await Truncate.output(sanitizePlatformToolText(input.output))
    const metadata = sanitizePlatformToolRecord(input.metadata)
    delete metadata.status
    delete metadata.code
    delete metadata.recoverable
    delete metadata.action
    delete metadata.truncated
    delete metadata.outputPath
    return {
      title,
      output: truncated.content,
      metadata: {
        ...metadata,
        ...(canonical.status ? { status: canonical.status } : {}),
        ...(canonical.code ? { code: canonical.code } : {}),
        ...(canonical.recoverable !== undefined ? { recoverable: canonical.recoverable } : {}),
        ...(canonical.action ? { action: canonical.action } : {}),
        truncated: truncated.truncated,
        ...(truncated.truncated ? { outputPath: truncated.outputPath } : {}),
      },
    }
  }

  function failureResult(input: {
    code: string
    message: string
    recoverable: boolean
    status: "failed" | "unavailable" | "auth-required"
    action?: RuntimeToolRegistry.Availability["action"]
  }): Result {
    return {
      title: input.status === "auth-required" ? "Authentication required" : "Platform tool failed",
      output: sanitizePlatformToolText(input.message),
      metadata: {
        status: input.status,
        code: input.code,
        recoverable: input.recoverable,
        ...(input.action ? { action: input.action } : {}),
        truncated: false,
      },
    }
  }

  async function publishFailure(input: Input, failure: RuntimeResourceResolver.ResourceFailure) {
    try {
      if (input.publishFailure) await input.publishFailure(failure)
      else {
        await RuntimeResourceResolver.publishToolFailure({
          sessionID: input.call.sessionId,
          failure,
        })
      }
    } catch {
      log.warn("failed to publish platform tool execution failure", {
        ownerID: input.reference.ownerID,
        toolID: input.reference.id,
        generation: input.reference.generation,
        code: failure.code,
      })
    }
  }

  function clearFailure(input: Input) {
    try {
      if (input.clearFailure) input.clearFailure()
      else RuntimeResourceResolver.clearToolFailure(input.call.sessionId, input.reference.id)
    } catch {
      log.warn("failed to clear platform tool failure state", {
        ownerID: input.reference.ownerID,
        toolID: input.reference.id,
        generation: input.reference.generation,
      })
    }
  }

  function normalizeAvailability(input: unknown): RuntimeToolRegistry.Availability | undefined {
    if (!isRecord(input) || !isAvailabilityStatus(input.status)) return undefined
    if (input.reason !== undefined && typeof input.reason !== "string") return undefined
    if (input.action !== undefined && !normalizeAction(input.action)) return undefined
    return {
      status: input.status,
      ...(input.reason !== undefined ? { reason: sanitizePlatformToolDiagnostic(input.reason) } : {}),
      ...(input.action ? { action: normalizeAction(input.action) } : {}),
    }
  }

  function normalizeAction(input: unknown): RuntimeToolRegistry.Availability["action"] | undefined {
    if (!isRecord(input) || typeof input.label !== "string" || !input.label.trim()) return undefined
    if (input.type !== "open-settings" && input.type !== "start-auth" && input.type !== "retry") return undefined
    return {
      type: input.type,
      label: sanitizePlatformToolDiagnostic(input.label),
    }
  }

  function resolveContext(call: RuntimeToolRegistry.CallContext): RuntimeToolRegistry.ResolveContext {
    return {
      sessionId: call.sessionId,
      projectId: call.projectId,
      directory: call.directory,
      agent: call.agent,
      templateIds: [...call.templateIds],
    }
  }

  function defaultTimeout(milliseconds: number): TimeoutHandle {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException("Platform tool deadline exceeded.", "TimeoutError"))
        resolve()
      }, milliseconds)
    })
    return {
      signal: controller.signal,
      elapsed,
      dispose() {
        if (timer) clearTimeout(timer)
      },
    }
  }

  function combineSignals(signals: AbortSignal[]) {
    const controller = new AbortController()
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        break
      }
      const listener = () => {
        if (!controller.signal.aborted) controller.abort(signal.reason)
      }
      signal.addEventListener("abort", listener, { once: true })
      listeners.push({ signal, listener })
    }
    return {
      signal: controller.signal,
      dispose() {
        for (const item of listeners) item.signal.removeEventListener("abort", item.listener)
      },
    }
  }

  function watchAbort(signal: AbortSignal) {
    let listener: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      listener = resolve
      signal.addEventListener("abort", listener, { once: true })
    })
    return {
      promise,
      dispose() {
        if (listener) signal.removeEventListener("abort", listener)
      },
    }
  }

  function normalizePositiveDuration(value: number | undefined, fallback: number) {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
    return Math.max(1, Math.trunc(value))
  }

  function isAvailabilityStatus(value: unknown): value is RuntimeToolRegistry.Availability["status"] {
    return (
      value === "unknown" ||
      value === "available" ||
      value === "degraded" ||
      value === "unavailable" ||
      value === "auth-required"
    )
  }

  function isNonEmptyStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim())
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }
}
