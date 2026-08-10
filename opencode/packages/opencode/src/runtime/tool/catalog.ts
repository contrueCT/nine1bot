import type { ResourceAvailability } from "@/runtime/protocol/agent-run-spec"
import type { PlatformToolRuntimeCode } from "./errors"
import { RuntimeToolRegistry } from "./registry"
import { sanitizePlatformToolDiagnostic } from "./sanitize"

const DEFAULT_AVAILABILITY_BUDGET_MS = 500
const AVAILABILITY_TIMEOUT = Symbol("platform-tool-availability-timeout")
const TOOL_ID = /^[a-z][a-z0-9_]*$/
const SAFE_INVALID_ID = "[invalid-tool-id]"

export namespace RuntimeToolCatalog {
  export type ResolvedReference = {
    id: string
    ownerID: string
    generation: number
    definition: Readonly<RuntimeToolRegistry.Definition<any>>
    availability: RuntimeToolRegistry.Availability
  }

  export type ToolSummary = {
    id: string
    ownerId: string
    description: string
    catalogVisibility: "declared-only" | "user-selectable"
    status: "registered" | "unavailable" | "auth-required" | "conflict" | "error"
    generation: number
    unavailableReason?: string
    action?: RuntimeToolRegistry.Availability["action"]
  }

  export type ToolFailure = {
    resourceType: "tool"
    resourceID: string
    ownerID?: string
    generation?: number
    code?: PlatformToolRuntimeCode
    status: "degraded" | "unavailable" | "auth-required"
    stage: "resolve" | "auth"
    reason?: string
    message: string
    recoverable: boolean
    action?: RuntimeToolRegistry.Availability["action"]
  }

  export type ResolveInput = {
    ids: string[]
    context: RuntimeToolRegistry.ResolveContext
    occupiedToolIDs?: ReadonlySet<string>
    isExposureDenied?: (toolID: string) => boolean | Promise<boolean>
    budgetMs?: number
  }

  export type Resolved = {
    declared: string[]
    available: ResolvedReference[]
    availability: Record<string, ResourceAvailability>
    failures: ToolFailure[]
    summaries: ToolSummary[]
  }

  type Candidate = {
    id: string
    reference: RuntimeToolRegistry.ToolReference
  }

  type AvailabilityCheck = {
    availability: RuntimeToolRegistry.Availability
    callbackFailed: boolean
  }

  export async function resolveDeclared(input: ResolveInput): Promise<Resolved> {
    const declared = uniqueSorted(input.ids.map(safeToolID))
    const availability: Record<string, ResourceAvailability> = {}
    const failures: ToolFailure[] = []
    const summaries: ToolSummary[] = []
    const candidates: Candidate[] = []

    for (const id of declared) {
      const reference = RuntimeToolRegistry.get(id)
      if (!reference || !reference.owner.enabled) {
        const reservation = RuntimeToolRegistry.lookupReservation(id)
        const state = resourceAvailability("unavailable", "tool-missing")
        availability[id] = state
        failures.push({
          resourceType: "tool",
          resourceID: id,
          ownerID: reference?.ownerID ?? reservation?.ownerID,
          generation: reference?.generation ?? reservation?.generation,
          code: "tool-missing",
          status: "unavailable",
          stage: "resolve",
          reason: "tool-missing",
          message: `Registered tool "${id}" is unavailable in the current runtime.`,
          recoverable: true,
        })
        continue
      }

      if (input.occupiedToolIDs?.has(id)) {
        const state = resourceAvailability("unavailable", "tool-conflict")
        availability[id] = state
        failures.push({
          resourceType: "tool",
          resourceID: id,
          ownerID: reference.ownerID,
          generation: reference.generation,
          code: "tool-conflict",
          status: "unavailable",
          stage: "resolve",
          reason: "tool-conflict",
          message: `Registered tool "${id}" conflicts with an existing runtime tool.`,
          recoverable: false,
        })
        summaries.push(summary(reference, state, "conflict"))
        continue
      }

      candidates.push({ id, reference })
    }

    const exposure = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        denied: await exposureDenied(input.isExposureDenied, candidate.id),
      })),
    )
    const allowed: Candidate[] = []
    for (const item of exposure) {
      if (item.denied) {
        availability[item.candidate.id] = resourceAvailability("unavailable", "permission-denied")
        continue
      }
      allowed.push(item.candidate)
    }

    const checks = await checkAvailability(allowed, input.context, input.budgetMs)
    const available: ResolvedReference[] = []
    for (const item of checks) {
      const { id, reference } = item.candidate
      const state = toResourceAvailability(item.check.availability)
      availability[id] = state

      if (isVisibleStatus(state.status)) {
        available.push({
          id,
          ownerID: reference.ownerID,
          generation: reference.generation,
          definition: reference.definition,
          availability: item.check.availability,
        })
        summaries.push(summary(reference, state, item.check.callbackFailed ? "error" : "registered"))
        if (item.check.callbackFailed) {
          failures.push({
            resourceType: "tool",
            resourceID: id,
            ownerID: reference.ownerID,
            generation: reference.generation,
            code: "availability-check-failed",
            status: "degraded",
            stage: "resolve",
            reason: "availability-callback-failed",
            message: `Registered tool "${id}" availability check failed.`,
            recoverable: true,
          })
        }
        continue
      }

      if (state.status === "auth-required") {
        failures.push({
          resourceType: "tool",
          resourceID: id,
          ownerID: reference.ownerID,
          generation: reference.generation,
          code: "auth-required",
          status: "auth-required",
          stage: "auth",
          reason: state.reason ?? "authentication-required",
          message: safeFailureMessage(id, "requires authentication", state.reason),
          recoverable: true,
          action: state.action,
        })
        summaries.push(summary(reference, state, "auth-required"))
        continue
      }

      failures.push({
        resourceType: "tool",
        resourceID: id,
        ownerID: reference.ownerID,
        generation: reference.generation,
        status: "unavailable",
        stage: "resolve",
        reason: state.reason ?? "tool-unavailable",
        message: safeFailureMessage(id, "is unavailable", state.reason),
        recoverable: true,
        action: state.action,
      })
      summaries.push(summary(reference, state, "unavailable"))
    }

    return {
      declared,
      available: available.sort((left, right) => left.id.localeCompare(right.id)),
      availability,
      failures: failures.sort((left, right) => left.resourceID.localeCompare(right.resourceID)),
      summaries: summaries.sort((left, right) => left.id.localeCompare(right.id)),
    }
  }

  export async function listSelectable(
    input: Omit<ResolveInput, "ids">,
  ): Promise<ToolSummary[]> {
    const ids = RuntimeToolRegistry.list()
      .filter((tool) => tool.enabled && tool.catalogVisibility === "user-selectable")
      .map((tool) => tool.id)
    return (await resolveDeclared({ ...input, ids })).summaries
  }

  async function checkAvailability(
    candidates: Candidate[],
    context: RuntimeToolRegistry.ResolveContext,
    budgetOverride?: number,
  ) {
    if (candidates.length === 0) return []
    const budgetMs = normalizeBudget(budgetOverride)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof AVAILABILITY_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(AVAILABILITY_TIMEOUT), budgetMs)
    })

    const checks = candidates.map(async (candidate) => {
      const callback = candidate.reference.definition.availability
      const check = callback
        ? Promise.resolve()
            .then(() => callback(context))
            .then(normalizeAvailability)
            .catch(() => callbackFailure())
        : Promise.resolve(availableByDefault())
      const result = await Promise.race([check, timeout])
      return {
        candidate,
        check: result === AVAILABILITY_TIMEOUT ? availabilityTimeout() : result,
      }
    })

    try {
      return await Promise.all(checks)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function normalizeAvailability(input: unknown): AvailabilityCheck {
    if (!isRecord(input) || !isAvailabilityStatus(input.status)) return callbackFailure()
    if (input.reason !== undefined && typeof input.reason !== "string") return callbackFailure()
    if (input.error !== undefined && typeof input.error !== "string") return callbackFailure()
    if (input.checkedAt !== undefined && (typeof input.checkedAt !== "number" || !Number.isFinite(input.checkedAt))) {
      return callbackFailure()
    }
    if (input.action !== undefined && !isAction(input.action)) return callbackFailure()

    return {
      callbackFailed: false,
      availability: {
        status: input.status,
        ...(input.reason !== undefined ? { reason: sanitizePlatformToolDiagnostic(input.reason) } : {}),
        ...(input.checkedAt !== undefined ? { checkedAt: Math.max(0, Math.trunc(input.checkedAt)) } : { checkedAt: Date.now() }),
        ...(input.action
          ? {
              action: {
                type: input.action.type,
                label: sanitizePlatformToolDiagnostic(input.action.label),
              },
            }
          : {}),
      },
    }
  }

  function availableByDefault(): AvailabilityCheck {
    return {
      callbackFailed: false,
      availability: {
        status: "available",
        checkedAt: Date.now(),
      },
    }
  }

  function callbackFailure(): AvailabilityCheck {
    return {
      callbackFailed: true,
      availability: {
        status: "degraded",
        reason: "availability-callback-failed",
        checkedAt: Date.now(),
      },
    }
  }

  function availabilityTimeout(): AvailabilityCheck {
    return {
      callbackFailed: false,
      availability: {
        status: "unknown",
        reason: "availability-budget-exceeded",
        checkedAt: Date.now(),
      },
    }
  }

  function resourceAvailability(
    status: ResourceAvailability["status"],
    reason?: string,
  ): ResourceAvailability {
    return {
      declared: true,
      status,
      ...(reason ? { reason: sanitizePlatformToolDiagnostic(reason) } : {}),
      checkedAt: Date.now(),
    }
  }

  function toResourceAvailability(input: RuntimeToolRegistry.Availability): ResourceAvailability {
    return {
      declared: true,
      status: input.status,
      ...(input.reason ? { reason: sanitizePlatformToolDiagnostic(input.reason) } : {}),
      ...(input.checkedAt !== undefined ? { checkedAt: input.checkedAt } : {}),
      ...(input.action
        ? {
            action: {
              type: input.action.type,
              label: sanitizePlatformToolDiagnostic(input.action.label),
            },
          }
        : {}),
    }
  }

  function summary(
    reference: RuntimeToolRegistry.ToolReference,
    availability: ResourceAvailability,
    status: ToolSummary["status"],
  ): ToolSummary {
    return {
      id: reference.id,
      ownerId: reference.ownerID,
      description: reference.definition.description,
      catalogVisibility: reference.definition.catalogVisibility,
      status,
      generation: reference.generation,
      ...(availability.reason ? { unavailableReason: availability.reason } : {}),
      ...(availability.action ? { action: availability.action } : {}),
    }
  }

  async function exposureDenied(
    check: ResolveInput["isExposureDenied"],
    toolID: string,
  ) {
    if (!check) return false
    try {
      return (await check(toolID)) === true
    } catch {
      return true
    }
  }

  function safeFailureMessage(toolID: string, state: string, reason?: string) {
    const suffix = reason ? ` (${sanitizePlatformToolDiagnostic(reason)})` : ""
    return `Registered tool "${toolID}" ${state}${suffix}.`
  }

  function isVisibleStatus(status: ResourceAvailability["status"]) {
    return status === "available" || status === "unknown" || status === "degraded"
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

  function isAction(value: unknown): value is NonNullable<RuntimeToolRegistry.Availability["action"]> {
    if (!isRecord(value) || typeof value.label !== "string" || !value.label.trim()) return false
    return value.type === "open-settings" || value.type === "start-auth" || value.type === "retry"
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  function normalizeBudget(value?: number) {
    if (value === undefined) return DEFAULT_AVAILABILITY_BUDGET_MS
    if (!Number.isFinite(value)) return DEFAULT_AVAILABILITY_BUDGET_MS
    return Math.max(1, Math.trunc(value))
  }

  function safeToolID(value: unknown) {
    return typeof value === "string" && TOOL_ID.test(value) ? value : SAFE_INVALID_ID
  }

  function uniqueSorted(values: string[]) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right))
  }
}
