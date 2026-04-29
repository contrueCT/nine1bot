import { createHash, randomBytes, timingSafeEqual } from "crypto"
import { ulid } from "ulid"
import z from "zod"
import { Project } from "@/project/project"
import { Storage } from "@/storage/storage"

export namespace Webhook {
  const SENSITIVE_HEADER_RE = /authorization|cookie|token|api[-_]?key|secret/i
  const MAX_SUMMARY_STRING = 1000
  const MAX_SUMMARY_ARRAY = 20
  const MAX_SUMMARY_KEYS = 50
  const MAX_DEDUPE_KEY_PREVIEW = 200

  const sourceLocks = new Map<string, Promise<void>>()

  export const RequestMapping = z.record(z.string(), z.string()).default({})
  export type RequestMapping = z.infer<typeof RequestMapping>

  export const ModelChoice = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })
  export type ModelChoice = z.infer<typeof ModelChoice>

  export const RuntimeProfile = z
    .object({
      modelMode: z.enum(["default", "custom"]).default("default"),
      model: ModelChoice.optional(),
      resourcesMode: z.enum(["default", "default-plus-selected"]).default("default"),
      mcpServers: z.array(z.string()).default([]),
    })
    .default(() => defaultRuntimeProfile())
  export type RuntimeProfile = z.infer<typeof RuntimeProfile>

  export const PermissionPolicy = z
    .object({
      mode: z.enum(["default", "full"]).default("default"),
    })
    .default(() => defaultPermissionPolicy())
  export type PermissionPolicy = z.infer<typeof PermissionPolicy>

  export const RequestGuards = z
    .object({
      dedupe: z
        .object({
          enabled: z.boolean().default(false),
          keyTemplate: z.string().optional(),
          ttlSeconds: z.coerce.number().int().positive().default(3600),
        })
        .default(() => defaultRequestGuards().dedupe),
      rateLimit: z
        .object({
          enabled: z.boolean().default(true),
          maxRequests: z.coerce.number().int().positive().default(20),
          windowSeconds: z.coerce.number().int().positive().default(60),
        })
        .default(() => defaultRequestGuards().rateLimit),
      cooldown: z
        .object({
          enabled: z.boolean().default(true),
          seconds: z.coerce.number().int().nonnegative().default(120),
        })
        .default(() => defaultRequestGuards().cooldown),
      replayProtection: z
        .object({
          enabled: z.boolean().default(false),
          timestampHeader: z.string().optional(),
          maxSkewSeconds: z.coerce.number().int().positive().default(300),
        })
        .default(() => defaultRequestGuards().replayProtection),
    })
    .default(() => defaultRequestGuards())
  export type RequestGuards = z.infer<typeof RequestGuards>

  export const GuardType = z.enum(["dedupe", "rateLimit", "cooldown", "replayProtection"])
  export type GuardType = z.infer<typeof GuardType>

  export const Source = z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    projectID: z.string(),
    auth: z.object({
      secretHash: z.string(),
    }),
    requestMapping: RequestMapping,
    promptTemplate: z.string(),
    runtimeProfile: RuntimeProfile,
    permissionPolicy: PermissionPolicy,
    requestGuards: RequestGuards,
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
    deletedAt: z.number().optional(),
  })
  export type Source = z.infer<typeof Source>

  export const PublicSource = Source.omit({ auth: true }).extend({
    secretMasked: z.string(),
  })
  export type PublicSource = z.infer<typeof PublicSource>

  export const RunStatus = z.enum(["received", "accepted", "running", "succeeded", "failed", "rejected"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const Run = z.object({
    id: z.string(),
    sourceID: z.string(),
    projectID: z.string(),
    sessionID: z.string().optional(),
    turnSnapshotId: z.string().optional(),
    status: RunStatus,
    httpStatus: z.number().optional(),
    requestSummary: z.unknown().optional(),
    renderedPromptPreview: z.string().optional(),
    guardType: GuardType.optional(),
    guardReason: z.string().optional(),
    dedupeKey: z.string().optional(),
    responseBody: z.unknown().optional(),
    error: z.string().optional(),
    time: z.object({
      received: z.number(),
      started: z.number().optional(),
      finished: z.number().optional(),
    }),
  })
  export type Run = z.infer<typeof Run>

  export const SourceCreate = z.object({
    name: z.string().trim().min(1),
    enabled: z.boolean().optional(),
    projectID: z.string(),
    requestMapping: RequestMapping.optional(),
    promptTemplate: z.string().optional(),
    runtimeProfile: RuntimeProfile.optional(),
    permissionPolicy: PermissionPolicy.optional(),
    requestGuards: RequestGuards.optional(),
  })
  export type SourceCreate = z.infer<typeof SourceCreate>

  export const SourceUpdate = z.object({
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    projectID: z.string().optional(),
    requestMapping: RequestMapping.optional(),
    promptTemplate: z.string().optional(),
    runtimeProfile: RuntimeProfile.optional(),
    permissionPolicy: PermissionPolicy.optional(),
    requestGuards: RequestGuards.optional(),
  })
  export type SourceUpdate = z.infer<typeof SourceUpdate>

  export const TriggerResponse = z.object({
    accepted: z.boolean(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    turnSnapshotId: z.string().optional(),
    guardType: GuardType.optional(),
    guardReason: z.string().optional(),
    error: z.string().optional(),
  })
  export type TriggerResponse = z.infer<typeof TriggerResponse>

  export type GuardContext = RenderContext & {
    now?: number
  }

  export type GuardDecision =
    | {
        allowed: true
        dedupeKey?: string
      }
    | {
        allowed: false
        httpStatus: number
        error: string
        guardType: GuardType
        guardReason: string
        dedupeKey?: string
      }

  export function defaultPromptTemplate() {
    return [
      "Webhook source {{source.name}} triggered an automated Nine1Bot run.",
      "",
      "Project: {{project.name}}",
      "Fields:",
      "{{fields}}",
      "",
      "Please inspect the situation using the project context and act within the configured permissions.",
    ].join("\n")
  }

  export function defaultRuntimeProfile(): RuntimeProfile {
    return {
      modelMode: "default",
      resourcesMode: "default",
      mcpServers: [],
    }
  }

  export function defaultPermissionPolicy(): PermissionPolicy {
    return {
      mode: "default",
    }
  }

  export function defaultRequestGuards(): RequestGuards {
    return {
      dedupe: {
        enabled: false,
        ttlSeconds: 3600,
      },
      rateLimit: {
        enabled: true,
        maxRequests: 20,
        windowSeconds: 60,
      },
      cooldown: {
        enabled: true,
        seconds: 120,
      },
      replayProtection: {
        enabled: false,
        timestampHeader: "x-nine1bot-timestamp",
        maxSkewSeconds: 300,
      },
    }
  }

  export function toPublicSource(source: Source): PublicSource {
    const { auth: _auth, ...rest } = source
    return {
      ...rest,
      secretMasked: "sec_********",
    }
  }

  export async function createSource(input: SourceCreate) {
    await Project.get(input.projectID)
    const secret = `sec_${randomBytes(24).toString("base64url")}`
    const now = Date.now()
    const source: Source = {
      id: `src_${ulid().toLowerCase()}`,
      name: input.name,
      enabled: input.enabled ?? true,
      projectID: input.projectID,
      auth: {
        secretHash: hashSecret(secret),
      },
      requestMapping: input.requestMapping ?? {},
      promptTemplate: input.promptTemplate ?? defaultPromptTemplate(),
      runtimeProfile: RuntimeProfile.parse(input.runtimeProfile),
      permissionPolicy: PermissionPolicy.parse(input.permissionPolicy),
      requestGuards: RequestGuards.parse(input.requestGuards),
      time: {
        created: now,
        updated: now,
      },
    }
    await Storage.write(["webhook_source", source.id], source)
    return {
      source: toPublicSource(source),
      secret,
    }
  }

  export async function updateSource(sourceID: string, input: SourceUpdate) {
    if (input.projectID) {
      await Project.get(input.projectID)
    }
    const updated = await Storage.update<Source>(["webhook_source", sourceID], (draft) => {
      Object.assign(draft, Source.parse(draft))
      if (draft.deletedAt) return
      if (input.name !== undefined) draft.name = input.name
      if (input.enabled !== undefined) draft.enabled = input.enabled
      if (input.projectID !== undefined) draft.projectID = input.projectID
      if (input.requestMapping !== undefined) draft.requestMapping = input.requestMapping
      if (input.promptTemplate !== undefined) draft.promptTemplate = input.promptTemplate
      if (input.runtimeProfile !== undefined) {
        draft.runtimeProfile = RuntimeProfile.parse({
          ...draft.runtimeProfile,
          ...input.runtimeProfile,
        })
      }
      if (input.permissionPolicy !== undefined) {
        draft.permissionPolicy = PermissionPolicy.parse({
          ...draft.permissionPolicy,
          ...input.permissionPolicy,
        })
      }
      if (input.requestGuards !== undefined) {
        draft.requestGuards = mergeRequestGuards(draft.requestGuards, input.requestGuards)
      }
      draft.time.updated = Date.now()
    })
    return toPublicSource(Source.parse(updated))
  }

  export async function deleteSource(sourceID: string) {
    const deleted = await Storage.update<Source>(["webhook_source", sourceID], (draft) => {
      Object.assign(draft, Source.parse(draft))
      draft.enabled = false
      draft.deletedAt = Date.now()
      draft.time.updated = Date.now()
    })
    return toPublicSource(Source.parse(deleted))
  }

  export async function refreshSourceSecret(sourceID: string) {
    const secret = generateSecret()
    const updated = await Storage.update<Source>(["webhook_source", sourceID], (draft) => {
      Object.assign(draft, Source.parse(draft))
      if (draft.deletedAt) return
      draft.auth.secretHash = hashSecret(secret)
      draft.time.updated = Date.now()
    })
    return {
      source: toPublicSource(Source.parse(updated)),
      secret,
    }
  }

  export async function getSource(sourceID: string) {
    const source = await Storage.read<Source>(["webhook_source", sourceID])
    return Source.parse(source)
  }

  export async function listSources() {
    const sources: Source[] = []
    for (const key of await Storage.list(["webhook_source"])) {
      const source = await Storage.read<Source>(key).catch(() => undefined)
      if (!source || source.deletedAt) continue
      sources.push(Source.parse(source))
    }
    sources.sort((a, b) => b.time.updated - a.time.updated)
    return sources.map(toPublicSource)
  }

  export async function createRun(input: {
    sourceID: string
    projectID: string
    status?: RunStatus
    httpStatus?: number
    requestSummary?: unknown
    renderedPromptPreview?: string
    guardType?: GuardType
    guardReason?: string
    dedupeKey?: string
    responseBody?: unknown
    error?: string
  }) {
    const run: Run = {
      id: `run_${ulid().toLowerCase()}`,
      sourceID: input.sourceID,
      projectID: input.projectID,
      status: input.status ?? "received",
      httpStatus: input.httpStatus,
      requestSummary: input.requestSummary,
      renderedPromptPreview: input.renderedPromptPreview,
      guardType: input.guardType,
      guardReason: input.guardReason,
      dedupeKey: input.dedupeKey,
      responseBody: summarize(input.responseBody),
      error: input.error,
      time: {
        received: Date.now(),
      },
    }
    await Storage.write(["webhook_run", run.id], run)
    return run
  }

  export async function updateRun(runID: string, input: Partial<Omit<Run, "id" | "time">> & {
    time?: Partial<Run["time"]>
  }) {
    return Storage.update<Run>(["webhook_run", runID], (draft) => {
      const { time, ...rest } = input
      Object.assign(draft, {
        ...rest,
        ...(rest.requestSummary !== undefined ? { requestSummary: summarize(rest.requestSummary) } : {}),
        ...(rest.responseBody !== undefined ? { responseBody: summarize(rest.responseBody) } : {}),
      })
      if (time) {
        draft.time = {
          ...draft.time,
          ...time,
        }
      }
    })
  }

  export async function listRuns(input: { sourceID?: string; limit?: number } = {}) {
    const runs: Run[] = []
    for (const key of await Storage.list(["webhook_run"])) {
      const run = await Storage.read<Run>(key).catch(() => undefined)
      if (!run) continue
      const parsed = Run.parse(run)
      if (input.sourceID && parsed.sourceID !== input.sourceID) continue
      runs.push(parsed)
    }
    runs.sort((a, b) => b.time.received - a.time.received)
    return runs.slice(0, input.limit ?? 100)
  }

  export async function withSourceLock<T>(sourceID: string, fn: () => Promise<T>) {
    const previous = sourceLocks.get(sourceID) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    sourceLocks.set(sourceID, tail)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (sourceLocks.get(sourceID) === tail) {
        sourceLocks.delete(sourceID)
      }
    }
  }

  export async function evaluateRequestGuards(source: Source, context: GuardContext): Promise<GuardDecision> {
    const now = context.now ?? Date.now()
    const replay = evaluateReplayProtection(source.requestGuards.replayProtection, context.headers, now)
    if (!replay.allowed) return replay

    const rateLimit = await consumeRateLimit(source, now)
    if (!rateLimit.allowed) return rateLimit

    const dedupe = await consumeDedupe(source, context, now)
    if (!dedupe.allowed) return dedupe

    const cooldown = await checkCooldown(source, now)
    if (!cooldown.allowed) return cooldown

    return {
      allowed: true,
      dedupeKey: dedupe.dedupeKey,
    }
  }

  export function evaluateReplayProtection(
    guard: RequestGuards["replayProtection"],
    headers: Record<string, string>,
    now = Date.now(),
  ): GuardDecision {
    if (!guard.enabled) return { allowed: true }
    const headerName = (guard.timestampHeader || "x-nine1bot-timestamp").toLowerCase()
    const raw = headers[headerName]
    if (!raw) {
      return rejectGuard("replayProtection", 400, "webhook_replay_timestamp_missing", `Missing timestamp header "${headerName}".`)
    }
    const timestamp = parseWebhookTimestamp(raw)
    if (!timestamp) {
      return rejectGuard("replayProtection", 400, "webhook_replay_timestamp_invalid", `Invalid timestamp header "${headerName}".`)
    }
    const maxSkewMs = guard.maxSkewSeconds * 1000
    if (Math.abs(now - timestamp) > maxSkewMs) {
      return rejectGuard(
        "replayProtection",
        400,
        "webhook_replay_timestamp_out_of_range",
        `Timestamp header "${headerName}" is outside the allowed ${guard.maxSkewSeconds}s skew.`,
      )
    }
    return { allowed: true }
  }

  export function parseWebhookTimestamp(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed)
      if (!Number.isFinite(numeric)) return undefined
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    }
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  export async function markCooldown(source: Source, runID: string, now = Date.now()) {
    const guard = source.requestGuards.cooldown
    if (!guard.enabled || guard.seconds <= 0) return
    await Storage.write(["webhook_guard", "cooldown", source.id], {
      until: now + guard.seconds * 1000,
      runID,
      updatedAt: now,
    })
  }

  export function verifySecret(source: Source, secret: string) {
    const expected = Buffer.from(source.auth.secretHash, "hex")
    const actual = Buffer.from(hashSecret(secret), "hex")
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  }

  export function generateSecret() {
    return `sec_${randomBytes(24).toString("base64url")}`
  }

  export function requestSummary(input: {
    method: string
    sourceID: string
    headers: Record<string, string>
    query: Record<string, string>
    body: unknown
  }) {
    return {
      method: input.method,
      path: `/webhooks/${input.sourceID}/sec_********`,
      headers: sanitizeHeaders(input.headers),
      query: summarize(input.query),
      body: summarize(input.body),
    }
  }

  export function mapFields(mapping: RequestMapping, context: RenderContext) {
    const fields: Record<string, unknown> = {}
    for (const [field, path] of Object.entries(mapping || {})) {
      fields[field] = readPath(context, path)
    }
    return fields
  }

  export type RenderContext = {
    source: Pick<Source, "id" | "name">
    project: Pick<Project.Info, "id" | "name" | "rootDirectory" | "worktree">
    fields: Record<string, unknown>
    body: unknown
    headers: Record<string, string>
    query: Record<string, string>
  }

  export function renderTemplate(template: string, context: RenderContext) {
    const root = {
      ...context,
      project: {
        ...context.project,
        name: context.project.name || context.project.rootDirectory || context.project.worktree || context.project.id,
      },
    }
    return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, expression) => {
      const value = expression === "fields" ? context.fields : readPath(root, expression)
      return stringifyTemplateValue(value)
    })
  }

  export function normalizeHeaders(headers: Headers) {
    const normalized: Record<string, string> = {}
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value
    })
    return normalized
  }

  function hashSecret(secret: string) {
    return createHash("sha256").update(secret).digest("hex")
  }

  function hashKey(value: string) {
    return createHash("sha256").update(value).digest("hex")
  }

  function mergeRequestGuards(current: RequestGuards, update: RequestGuards) {
    return RequestGuards.parse({
      dedupe: {
        ...current.dedupe,
        ...update.dedupe,
      },
      rateLimit: {
        ...current.rateLimit,
        ...update.rateLimit,
      },
      cooldown: {
        ...current.cooldown,
        ...update.cooldown,
      },
      replayProtection: {
        ...current.replayProtection,
        ...update.replayProtection,
      },
    })
  }

  async function consumeRateLimit(source: Source, now: number): Promise<GuardDecision> {
    const guard = source.requestGuards.rateLimit
    if (!guard.enabled) return { allowed: true }

    const key = ["webhook_guard", "rate_limit", source.id]
    const windowMs = guard.windowSeconds * 1000
    const current = await Storage.read<{ windowStarted: number; count: number }>(key).catch(() => undefined)
    if (!current || now - current.windowStarted >= windowMs) {
      await Storage.write(key, {
        windowStarted: now,
        count: 1,
      })
      return { allowed: true }
    }
    if (current.count >= guard.maxRequests) {
      return rejectGuard(
        "rateLimit",
        429,
        "webhook_rate_limited",
        `Rate limit exceeded: ${guard.maxRequests} requests per ${guard.windowSeconds}s.`,
      )
    }
    await Storage.write(key, {
      windowStarted: current.windowStarted,
      count: current.count + 1,
    })
    return { allowed: true }
  }

  async function consumeDedupe(source: Source, context: GuardContext, now: number): Promise<GuardDecision> {
    const guard = source.requestGuards.dedupe
    if (!guard.enabled) return { allowed: true }
    if (!guard.keyTemplate?.trim()) {
      return rejectGuard("dedupe", 400, "webhook_dedupe_key_template_missing", "Dedupe is enabled but no key template is configured.")
    }
    const dedupeKey = renderTemplate(guard.keyTemplate, context).trim()
    if (!dedupeKey) {
      return rejectGuard("dedupe", 400, "webhook_dedupe_key_empty", "Dedupe key template rendered an empty key.")
    }
    const keyHash = hashKey(dedupeKey)
    const key = ["webhook_guard", "dedupe", source.id, keyHash]
    await pruneExpiredDedupeKeys(source, now)
    const current = await Storage.read<{ expiresAt: number; keyPreview: string }>(key).catch(() => undefined)
    if (current && current.expiresAt > now) {
      return {
        ...rejectGuard(
          "dedupe",
          409,
          "webhook_duplicate_request",
          `Duplicate webhook request for key "${current.keyPreview}".`,
        ),
        dedupeKey,
      }
    }
    await Storage.write(key, {
      expiresAt: now + guard.ttlSeconds * 1000,
      keyPreview: previewKey(dedupeKey),
      updatedAt: now,
    })
    return {
      allowed: true,
      dedupeKey,
    }
  }

  async function pruneExpiredDedupeKeys(source: Source, now: number) {
    const prefix = ["webhook_guard", "dedupe", source.id]
    const keys = await Storage.list(prefix).catch(() => [])
    await Promise.all(
      keys.map(async (key) => {
        const current = await Storage.read<{ expiresAt: number }>(key).catch(() => undefined)
        if (current && current.expiresAt <= now) {
          await Storage.remove(key).catch(() => undefined)
        }
      }),
    )
  }

  async function checkCooldown(source: Source, now: number): Promise<GuardDecision> {
    const guard = source.requestGuards.cooldown
    if (!guard.enabled || guard.seconds <= 0) return { allowed: true }
    const key = ["webhook_guard", "cooldown", source.id]
    const current = await Storage.read<{ until: number }>(key).catch(() => undefined)
    if (!current) return { allowed: true }
    if (current.until <= now) {
      await Storage.remove(key).catch(() => undefined)
      return { allowed: true }
    }
    const remainingSeconds = Math.max(1, Math.ceil((current.until - now) / 1000))
    return rejectGuard(
      "cooldown",
      429,
      "webhook_cooldown_active",
      `Webhook source is cooling down for ${remainingSeconds}s.`,
    )
  }

  function rejectGuard(
    guardType: GuardType,
    httpStatus: number,
    error: string,
    guardReason: string,
  ): Extract<GuardDecision, { allowed: false }> {
    return {
      allowed: false,
      httpStatus,
      error,
      guardType,
      guardReason,
    }
  }

  function previewKey(value: string) {
    return value.length > MAX_DEDUPE_KEY_PREVIEW ? `${value.slice(0, MAX_DEDUPE_KEY_PREVIEW)}...` : value
  }

  function sanitizeHeaders(headers: Record<string, string>) {
    const sanitized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      sanitized[key] = SENSITIVE_HEADER_RE.test(key) ? "[redacted]" : value
    }
    return sanitized
  }

  function summarize(value: unknown, depth = 0): unknown {
    if (depth > 4) return "[truncated]"
    if (typeof value === "string") {
      return value.length > MAX_SUMMARY_STRING ? `${value.slice(0, MAX_SUMMARY_STRING)}...` : value
    }
    if (typeof value !== "object" || value === null) return value
    if (Array.isArray(value)) {
      return value.slice(0, MAX_SUMMARY_ARRAY).map((item) => summarize(item, depth + 1))
    }
    const result: Record<string, unknown> = {}
    for (const [index, [key, item]] of Object.entries(value).entries()) {
      if (index >= MAX_SUMMARY_KEYS) break
      result[key] = summarize(item, depth + 1)
    }
    return result
  }

  function readPath(root: unknown, path: string) {
    const segments = path.split(".").filter(Boolean)
    let current = root
    for (const segment of segments) {
      if (current === undefined || current === null) return undefined
      if (Array.isArray(current) && /^\d+$/.test(segment)) {
        current = current[Number(segment)]
        continue
      }
      if (typeof current !== "object") return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    return current
  }

  function stringifyTemplateValue(value: unknown) {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return JSON.stringify(value, null, 2)
  }
}
