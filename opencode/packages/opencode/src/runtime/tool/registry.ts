import Ajv, { type AnySchema } from "ajv"
import { sanitizePlatformToolDiagnostic } from "./sanitize"

const TOOL_ID = /^[a-z][a-z0-9_]*$/
const OWNER_PREFIX = /^[a-z][a-z0-9_]*$/
const MAX_TIMEOUT_MS = 5 * 60 * 1000
const SAFE_INVALID_ID = "[invalid-tool-id]"
const jsonSchemaValidator = new Ajv({ allErrors: true, strict: false })

export class RuntimeToolRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RuntimeToolRegistrationError"
  }
}

export class RuntimeToolSelectionError extends Error {
  constructor(
    readonly invalid: Array<{
      id: string
      reason: "missing" | "inactive" | "declared-only"
    }>,
  ) {
    super(`Invalid registered tool selection: ${invalid.map((item) => `${item.id} (${item.reason})`).join(", ")}`)
    this.name = "RuntimeToolSelectionError"
  }
}

export namespace RuntimeToolRegistry {
  export type Owner = {
    id: string
    kind: "platform" | "capability" | "core"
    enabled: boolean
  }

  export type PermissionRequest = {
    permission: string
    patterns: string[]
    always?: string[]
  }

  export type ResolveContext = {
    sessionId: string
    projectId?: string
    directory: string
    agent: string
    templateIds: string[]
  }

  export type CallContext = ResolveContext & {
    messageId: string
    callId?: string
    signal: AbortSignal
    reportProgress(progress: {
      title?: string
      metadata?: Record<string, unknown>
    }): Promise<void>
  }

  export type Availability = {
    status: "unknown" | "available" | "degraded" | "unavailable" | "auth-required"
    reason?: string
    checkedAt?: number
    error?: string
    action?: {
      type: "open-settings" | "start-auth" | "retry"
      label: string
    }
  }

  export type Result =
    | {
        status: "ok"
        title: string
        output: string
        metadata?: Record<string, unknown>
      }
    | {
        status: "failed" | "unavailable" | "auth-required"
        code: string
        message: string
        recoverable: boolean
        action?: Availability["action"]
      }

  export type Definition<TInput = unknown> = {
    id: string
    description: string
    catalogVisibility: "declared-only" | "user-selectable"
    inputSchema: Record<string, unknown>
    parse(input: unknown): TInput
    permission?(input: TInput): PermissionRequest
    availability?(ctx: ResolveContext): Availability | Promise<Availability>
    execution?: { timeoutMs?: number }
    execute(input: TInput, ctx: CallContext): Promise<Result>
  }

  export type ToolReference = {
    id: string
    ownerID: string
    owner: Owner
    prefix: string
    generation: number
    definition: Readonly<Definition<any>>
  }

  export type ToolSummary = {
    id: string
    ownerID: string
    description: string
    catalogVisibility: "declared-only" | "user-selectable"
    generation: number
    enabled: boolean
  }

  export type OwnerSummary = {
    owner?: Owner
    prefix?: string
    generation?: number
    tools: ToolSummary[]
  }

  export type PreparedOwner = {
    baseRevision: number
    owner: Readonly<Owner>
    prefix: string
    generation: number
    tools: ReadonlyMap<string, Readonly<Definition<any>>>
  }

  export type OwnerEntry = {
    owner: Readonly<Owner>
    prefix: string
    generation: number
    tools: ReadonlyMap<string, Readonly<Definition<any>>>
    historicalIDs: ReadonlySet<string>
  }

  export type OwnerTombstone = {
    ownerID: string
    prefix: string
    generation: number
    historicalIDs: ReadonlySet<string>
  }

  export type OwnerSnapshot = {
    revision: number
    ownerID: string
    active?: OwnerEntry
    tombstone?: OwnerTombstone
    reserved: Array<[string, string]>
    prefixOwner?: string
  }

  const owners = new Map<string, OwnerEntry>()
  const ownerTombstones = new Map<string, OwnerTombstone>()
  const activeTools = new Map<string, { ownerID: string; definition: Readonly<Definition<any>> }>()
  const reservedIDs = new Map<string, string>()
  const prefixOwners = new Map<string, string>()
  let revision = 0

  export function prepareOwner(input: {
    owner: Owner
    tools: Definition<any>[]
  }): PreparedOwner {
    const owner = normalizeOwner(input.owner)
    if (!Array.isArray(input.tools)) {
      throw registrationError("invalid-tools", "Runtime tool owner tools must be an array.")
    }

    const prefix = ownerPrefix(owner.id)
    const prefixOwner = prefixOwners.get(prefix)
    if (prefixOwner && prefixOwner !== owner.id) {
      throw registrationError("owner-prefix-collision", "Runtime tool owner prefix collision.")
    }

    const previous = owners.get(owner.id)
    const tombstone = ownerTombstones.get(owner.id)
    const generation = (previous?.generation ?? tombstone?.generation ?? 0) + 1
    const seen = new Set<string>()
    const tools = new Map<string, Readonly<Definition<any>>>()

    for (const candidate of input.tools as unknown[]) {
      const normalized = normalizeDefinition(candidate, owner.id, prefix, seen)
      tools.set(normalized.id, normalized)
    }

    return Object.freeze({
      baseRevision: revision,
      owner,
      prefix,
      generation,
      tools,
    })
  }

  export function commitOwner(prepared: PreparedOwner): OwnerSummary {
    if (prepared.baseRevision !== revision) {
      throw registrationError("stale-preparation", "Runtime tool owner has a stale preparation.")
    }

    const previous = owners.get(prepared.owner.id)
    const tombstone = ownerTombstones.get(prepared.owner.id)
    const expectedGeneration = (previous?.generation ?? tombstone?.generation ?? 0) + 1
    if (prepared.generation !== expectedGeneration) {
      throw registrationError("stale-preparation", "Runtime tool owner has a stale preparation.")
    }

    for (const toolID of previous?.tools.keys() ?? []) {
      activeTools.delete(toolID)
    }

    const historicalIDs = new Set(previous?.historicalIDs ?? tombstone?.historicalIDs ?? [])
    for (const toolID of prepared.tools.keys()) historicalIDs.add(toolID)
    const entry: OwnerEntry = {
      owner: prepared.owner,
      prefix: prepared.prefix,
      generation: prepared.generation,
      tools: new Map(prepared.tools),
      historicalIDs,
    }

    owners.set(prepared.owner.id, entry)
    ownerTombstones.delete(prepared.owner.id)
    prefixOwners.set(prepared.prefix, prepared.owner.id)
    for (const [toolID, definition] of prepared.tools) {
      reservedIDs.set(toolID, prepared.owner.id)
      activeTools.set(toolID, { ownerID: prepared.owner.id, definition })
    }
    revision++
    return listOwner(prepared.owner.id)
  }

  export function registerOwner(input: {
    owner: Owner
    tools: Definition<any>[]
  }) {
    return commitOwner(prepareOwner(input))
  }

  export function unregisterOwner(ownerID: string) {
    const previous = owners.get(ownerID)
    if (!previous) return false

    owners.delete(ownerID)
    for (const toolID of previous.tools.keys()) activeTools.delete(toolID)
    ownerTombstones.set(ownerID, {
      ownerID,
      prefix: previous.prefix,
      generation: previous.generation + 1,
      historicalIDs: new Set(previous.historicalIDs),
    })
    revision++
    return true
  }

  export function get(toolID: string): ToolReference | undefined {
    const active = activeTools.get(toolID)
    if (!active) return undefined
    const owner = owners.get(active.ownerID)
    if (!owner) return undefined
    return {
      id: toolID,
      ownerID: active.ownerID,
      owner: { ...owner.owner },
      prefix: owner.prefix,
      generation: owner.generation,
      definition: active.definition,
    }
  }

  export function lookupReservation(toolID: string): {
    ownerID: string
    generation: number
    active: boolean
  } | undefined {
    const ownerID = reservedIDs.get(toolID)
    if (!ownerID) return undefined
    const owner = owners.get(ownerID)
    const tombstone = ownerTombstones.get(ownerID)
    const generation = owner?.generation ?? tombstone?.generation
    if (generation === undefined) return undefined
    return {
      ownerID,
      generation,
      active: activeTools.get(toolID)?.ownerID === ownerID,
    }
  }

  export function listOwner(ownerID: string): OwnerSummary {
    const entry = owners.get(ownerID)
    const tombstone = ownerTombstones.get(ownerID)
    if (!entry) {
      return {
        prefix: tombstone?.prefix,
        generation: tombstone?.generation,
        tools: [],
      }
    }
    return {
      owner: { ...entry.owner },
      prefix: entry.prefix,
      generation: entry.generation,
      tools: Array.from(entry.tools.values(), (definition) => summary(entry, definition)),
    }
  }

  export function list(): ToolSummary[] {
    return Array.from(owners.values()).flatMap((entry) =>
      Array.from(entry.tools.values(), (definition) => summary(entry, definition)),
    )
  }

  export function version() {
    return revision
  }

  export function captureOwner(ownerID: string): OwnerSnapshot {
    const active = owners.get(ownerID)
    const tombstone = ownerTombstones.get(ownerID)
    const prefix = active?.prefix ?? tombstone?.prefix
    return {
      revision,
      ownerID,
      active: active ? cloneOwnerEntry(active) : undefined,
      tombstone: tombstone ? cloneTombstone(tombstone) : undefined,
      reserved: Array.from(reservedIDs.entries()).filter(([, reservedOwner]) => reservedOwner === ownerID),
      prefixOwner: prefix ? prefixOwners.get(prefix) : undefined,
    }
  }

  export function restoreOwner(snapshot: OwnerSnapshot) {
    const current = owners.get(snapshot.ownerID)
    if (current) {
      for (const toolID of current.tools.keys()) activeTools.delete(toolID)
    }
    owners.delete(snapshot.ownerID)
    ownerTombstones.delete(snapshot.ownerID)

    for (const [toolID, ownerID] of reservedIDs) {
      if (ownerID === snapshot.ownerID) reservedIDs.delete(toolID)
    }
    for (const [prefix, ownerID] of prefixOwners) {
      if (ownerID === snapshot.ownerID) prefixOwners.delete(prefix)
    }

    if (snapshot.active) {
      const active = cloneOwnerEntry(snapshot.active)
      owners.set(snapshot.ownerID, active)
      for (const [toolID, definition] of active.tools) {
        activeTools.set(toolID, { ownerID: snapshot.ownerID, definition })
      }
    }
    if (snapshot.tombstone) ownerTombstones.set(snapshot.ownerID, cloneTombstone(snapshot.tombstone))
    for (const [toolID, ownerID] of snapshot.reserved) reservedIDs.set(toolID, ownerID)

    const prefix = snapshot.active?.prefix ?? snapshot.tombstone?.prefix
    if (prefix && snapshot.prefixOwner) prefixOwners.set(prefix, snapshot.prefixOwner)
    revision = snapshot.revision
  }

  export function assertOwned(ownerID: string, toolIDs: string[]) {
    for (const toolID of toolIDs) {
      const reference = get(toolID)
      if (!reference || reference.ownerID !== ownerID || !reference.owner.enabled) {
        throw registrationError("tool-ownership", "Registered tool declaration is not active for its owner.")
      }
    }
  }

  export function assertUserSelectable(toolIDs: string[]) {
    const invalid: RuntimeToolSelectionError["invalid"] = []
    const seen = new Set<string>()
    for (const candidate of toolIDs) {
      const safeID = typeof candidate === "string" && TOOL_ID.test(candidate) ? candidate : SAFE_INVALID_ID
      if (seen.has(safeID)) continue
      seen.add(safeID)

      const reference = typeof candidate === "string" ? get(candidate) : undefined
      if (!reference) {
        invalid.push({
          id: safeID,
          reason: typeof candidate === "string" && lookupReservation(candidate) ? "inactive" : "missing",
        })
        continue
      }
      if (!reference.owner.enabled) {
        invalid.push({ id: safeID, reason: "inactive" })
        continue
      }
      if (reference.definition.catalogVisibility !== "user-selectable") {
        invalid.push({ id: safeID, reason: "declared-only" })
      }
    }
    if (invalid.length > 0) throw new RuntimeToolSelectionError(invalid)
  }

  export function clearForTesting() {
    const changed =
      owners.size > 0 ||
      ownerTombstones.size > 0 ||
      activeTools.size > 0 ||
      reservedIDs.size > 0 ||
      prefixOwners.size > 0
    owners.clear()
    ownerTombstones.clear()
    activeTools.clear()
    reservedIDs.clear()
    prefixOwners.clear()
    if (changed) revision++
  }

  function normalizeOwner(input: unknown): Readonly<Owner> {
    if (!isRecord(input)) throw registrationError("invalid-owner", "Runtime tool owner must be an object.")
    if (typeof input.id !== "string" || !input.id.trim() || input.id !== input.id.trim()) {
      throw registrationError("invalid-owner", "Runtime tool owner ID must be a non-empty trimmed string.")
    }
    const prefix = ownerPrefix(input.id)
    if (!OWNER_PREFIX.test(prefix)) {
      throw registrationError("invalid-owner", "Runtime tool owner prefix is invalid.")
    }
    if (input.kind !== "platform" && input.kind !== "capability" && input.kind !== "core") {
      throw registrationError("invalid-owner", "Runtime tool owner kind is invalid.")
    }
    if (typeof input.enabled !== "boolean") {
      throw registrationError("invalid-owner", "Runtime tool owner enabled state is invalid.")
    }
    return Object.freeze({
      id: input.id,
      kind: input.kind,
      enabled: input.enabled,
    })
  }

  function normalizeDefinition(
    input: unknown,
    ownerID: string,
    prefix: string,
    seen: Set<string>,
  ): Readonly<Definition<any>> {
    if (!isRecord(input)) throw registrationError("invalid-definition", "Runtime tool definition must be an object.")
    if (typeof input.id !== "string" || !TOOL_ID.test(input.id)) {
      throw registrationError("invalid-id", "Runtime tool ID is invalid.")
    }
    if (seen.has(input.id)) {
      throw registrationError("duplicate-id", "Runtime tool owner contains a duplicate tool ID.")
    }
    seen.add(input.id)

    const active = activeTools.get(input.id)
    if (active && active.ownerID !== ownerID) {
      throw registrationError("active-id-collision", "Runtime tool has an active tool ID collision.")
    }
    const reservation = reservedIDs.get(input.id)
    if (reservation && reservation !== ownerID) {
      throw registrationError("reserved-id", "Runtime tool ID is reserved by another owner.")
    }
    if (!input.id.startsWith(`${prefix}_`)) {
      throw registrationError("owner-prefix", "Runtime tool ID must use its owner prefix.")
    }

    if (typeof input.description !== "string" || !input.description.trim()) {
      throw registrationError("invalid-description", "Runtime tool description must be non-empty.")
    }
    if (sanitizePlatformToolDiagnostic(input.description) !== input.description) {
      throw registrationError("sensitive-contract", "Runtime tool model contract contains sensitive text.")
    }
    if (input.catalogVisibility !== "declared-only" && input.catalogVisibility !== "user-selectable") {
      throw registrationError("invalid-visibility", "Runtime tool catalog visibility is invalid.")
    }
    if (typeof input.parse !== "function") {
      throw registrationError("invalid-parser", "Runtime tool parse function is required.")
    }
    if (input.permission !== undefined && typeof input.permission !== "function") {
      throw registrationError("invalid-permission", "Runtime tool permission resolver must be a function.")
    }
    if (input.availability !== undefined && typeof input.availability !== "function") {
      throw registrationError("invalid-availability", "Runtime tool availability resolver must be a function.")
    }
    if (typeof input.execute !== "function") {
      throw registrationError("invalid-execute", "Runtime tool execute function is required.")
    }

    const inputSchema = normalizeSchema(input.inputSchema)
    const execution = normalizeExecution(input.execution)
    return Object.freeze({
      id: input.id,
      description: input.description,
      catalogVisibility: input.catalogVisibility,
      inputSchema,
      parse: input.parse as Definition["parse"],
      permission: input.permission as Definition["permission"],
      availability: input.availability as Definition["availability"],
      execution,
      execute: input.execute as Definition["execute"],
    })
  }

  function normalizeSchema(input: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(input)) {
      throw registrationError("invalid-schema", "Runtime tool input schema must be a JSON object.")
    }
    const cloned = cloneJson(input, new WeakSet<object>()) as Record<string, unknown>
    if (!validateJsonSchema(cloned)) {
      throw registrationError("invalid-schema", "Runtime tool input schema is not valid JSON Schema.")
    }
    return deepFreeze(cloned)
  }

  function normalizeExecution(input: unknown): Readonly<{ timeoutMs?: number }> | undefined {
    if (input === undefined) return undefined
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "timeoutMs")) {
      throw registrationError("invalid-timeout", "Runtime tool execution timeout is invalid.")
    }
    if (
      input.timeoutMs !== undefined &&
      (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS)
    ) {
      throw registrationError("invalid-timeout", "Runtime tool execution timeout is invalid.")
    }
    return Object.freeze(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  }

  function cloneJson(input: unknown, stack: WeakSet<object>): unknown {
    if (input === null || typeof input === "boolean") return input
    if (typeof input === "string") {
      if (sanitizePlatformToolDiagnostic(input) !== input) {
        throw registrationError("sensitive-contract", "Runtime tool model contract contains sensitive text.")
      }
      return input
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw registrationError("invalid-schema", "Runtime tool input schema is not JSON.")
      return input
    }
    if (typeof input !== "object") {
      throw registrationError("invalid-schema", "Runtime tool input schema is not JSON.")
    }
    if (stack.has(input)) throw registrationError("invalid-schema", "Runtime tool input schema contains a cycle.")
    stack.add(input)
    try {
      if (Array.isArray(input)) return input.map((item) => cloneJson(item, stack))
      if (!isRecord(input)) throw registrationError("invalid-schema", "Runtime tool input schema is not JSON.")
      if (Reflect.ownKeys(input).some((key) => typeof key === "symbol")) {
        throw registrationError("invalid-schema", "Runtime tool input schema is not JSON.")
      }
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cloneJson(value, stack)]))
    } finally {
      stack.delete(input)
    }
  }

  function deepFreeze<T>(input: T): T {
    if (!input || typeof input !== "object" || Object.isFrozen(input)) return input
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value)
    return Object.freeze(input)
  }

  function validateJsonSchema(schema: unknown) {
    try {
      return jsonSchemaValidator.validateSchema(schema as AnySchema)
    } catch {
      return false
    }
  }

  function summary(entry: OwnerEntry, definition: Readonly<Definition<any>>): ToolSummary {
    return {
      id: definition.id,
      ownerID: entry.owner.id,
      description: definition.description,
      catalogVisibility: definition.catalogVisibility,
      generation: entry.generation,
      enabled: entry.owner.enabled,
    }
  }

  function cloneOwnerEntry(entry: OwnerEntry): OwnerEntry {
    return {
      owner: Object.freeze({ ...entry.owner }),
      prefix: entry.prefix,
      generation: entry.generation,
      tools: new Map(entry.tools),
      historicalIDs: new Set(entry.historicalIDs),
    }
  }

  function cloneTombstone(tombstone: OwnerTombstone): OwnerTombstone {
    return {
      ownerID: tombstone.ownerID,
      prefix: tombstone.prefix,
      generation: tombstone.generation,
      historicalIDs: new Set(tombstone.historicalIDs),
    }
  }

  function ownerPrefix(ownerID: string) {
    return ownerID
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  }

  function isRecord(value: unknown): value is Record<string, any> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }

  function registrationError(code: string, message: string) {
    return new RuntimeToolRegistrationError(code, message)
  }
}
