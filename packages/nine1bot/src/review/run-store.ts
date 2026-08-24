import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getDataDir } from '../config/loader'
import {
  gitLabReviewPublicationMarker,
  type GitLabCiPipeline,
  type GitLabReviewProjectSnapshot,
} from '@nine1bot/platform-gitlab/review'

export type ReviewRunStatus = 'accepted' | 'rejected' | 'blocked' | 'running' | 'succeeded' | 'failed'

export type ReviewRunCiSummary = {
  pipeline?: GitLabCiPipeline
  diagnostics: string[]
  observedAt?: number
  listCompletedAt?: number
  queryCount?: number
  jobLogReadCount?: number
  queriedJobIds?: number[]
}

export type ReviewRunRepositorySummary = {
  queryCount?: number
  readCount?: number
  searchCount?: number
  outputBytes?: number
  apiRequestCount?: number
  fileFetchCount?: number
  fetchedBytes?: number
}

export type ReviewRunPublication = {
  state: 'publishing' | 'partial' | 'published'
  claimId?: string
  ownerId?: string
  payloadHash: string
  startedAt?: number
  updatedAt: number
  summaryMarker: string
  completedMarkers: string[]
  error?: string
}

export type ReviewRunFailureNotification = {
  state: 'notifying' | 'partial' | 'notified'
  claimId?: string
  ownerId?: string
  payloadHash: string
  startedAt: number
  updatedAt: number
  error?: string
}

export type PublicationClaimResult =
  | { ok: true; claimId: string; resume: boolean; completedMarkers: string[] }
  | {
      ok: false
      error: string
    }

export type PublicationClaimIdentity = {
  runId: string
  claimId: string
  ownerId: string
  payloadHash: string
  sessionId?: string
  generation?: string
  allowTerminalFailure?: boolean
}

export type FailureNotificationClaimIdentity = PublicationClaimIdentity

export type FailureNotificationClaimResult =
  | { ok: true; claimId: string }
  | { ok: false; error: string }

export type ReviewRunRecord = {
  id: string
  rootRunId: string
  attempt: number
  retryOf?: string
  triggerKey: string
  generation: string
  platform: 'gitlab'
  idempotencyKey?: string
  status: ReviewRunStatus
  createdAt: number
  updatedAt: number
  activeLeaseExpiresAt?: number
  error?: string
  trigger?: Record<string, unknown>
  project?: GitLabReviewProjectSnapshot
  ci?: ReviewRunCiSummary
  repository?: ReviewRunRepositorySummary
  sessionId?: string
  turnSnapshotId?: string
  publishedAt?: number
  publication?: ReviewRunPublication
  failureNotifiedAt?: number
  failureNotification?: ReviewRunFailureNotification
  retryCount?: number
  lastRetryAt?: number
  warnings?: string[]
  context?: unknown
  rejectionKind?: string
  recoverable?: boolean
}

export type CreateReviewRunInput = Omit<
  ReviewRunRecord,
  'id' | 'rootRunId' | 'attempt' | 'retryOf' | 'triggerKey' | 'generation' | 'createdAt' | 'updatedAt'
> & {
  triggerKey?: string
}

export type ReviewRunIdentity = {
  runId: string
  sessionId?: string
  generation: string
}

export type GuardedRetryAttemptResult =
  | { ok: true; run: ReviewRunRecord }
  | { ok: false; error: string }

type ReviewRunStoreFile = {
  version: 2
  sequence: number
  runs: ReviewRunRecord[]
}

const runs = new Map<string, ReviewRunRecord>()
const activePublicationClaims = new Map<string, PublicationClaimIdentity>()
const activeFailureNotificationClaims = new Map<string, FailureNotificationClaimIdentity>()
let sequence = 0
let loaded = false
let storePathOverride: string | undefined
let maxRecordsOverride: number | undefined

const DEFAULT_ACTIVE_LEASE_MS = 35 * 60 * 1_000
const DEFAULT_MAX_ATTEMPTS = 5

function defaultStorePath() {
  return process.env.NINE1BOT_REVIEW_RUN_STORE_PATH || join(getDataDir(), 'review-runs.json')
}

function storePath() {
  return storePathOverride || defaultStorePath()
}

function maxRecords() {
  if (maxRecordsOverride !== undefined) return maxRecordsOverride
  const configured = Number(process.env.NINE1BOT_REVIEW_RUN_STORE_LIMIT)
  return Number.isFinite(configured) && configured > 0 ? configured : 100
}

function maxAttempts() {
  const configured = Number(process.env.NINE1BOT_REVIEW_RUN_ATTEMPT_LIMIT)
  const limit = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_ATTEMPTS
  return Math.max(1, Math.min(limit, maxRecords()))
}

function activeLeaseMs() {
  const configured = Number(process.env.NINE1BOT_REVIEW_RUN_ACTIVE_LEASE_MS)
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_ACTIVE_LEASE_MS
}

export namespace ReviewRunStore {
  export function create(input: CreateReviewRunInput): ReviewRunRecord {
    load()
    const runId = persistRunMutation(() => {
      const run = createRecord(input)
      setStoredReviewRun(run)
      return run.id
    })
    return copyReviewRunRecord(requiredStoredReviewRun(runId))
  }

  export function findByIdempotencyKey(idempotencyKey: string): ReviewRunRecord | undefined {
    load()
    const matches = [...runs.values()].filter((run) => run.idempotencyKey === idempotencyKey)
    const latest = matches.sort(compareLatestAttemptFirst)[0]
    return latest ? copyReviewRunRecord(latest) : undefined
  }

  export function findLatestByTriggerKey(triggerKey: string): ReviewRunRecord | undefined {
    load()
    const latest = findLatestByTriggerKeyInternal(triggerKey)
    return latest ? copyReviewRunRecord(latest) : undefined
  }

  export function findBySessionId(sessionId: string): ReviewRunRecord | undefined {
    load()
    const matches = [...runs.values()].filter((run) => run.sessionId === sessionId)
    return matches.length === 1 ? copyReviewRunRecord(matches[0]!) : undefined
  }

  export function get(id: string): ReviewRunRecord | undefined {
    load()
    const run = runs.get(id)
    return run ? copyReviewRunRecord(run) : undefined
  }

  export function update(id: string, patch: Partial<Omit<ReviewRunRecord, 'id' | 'createdAt'>>): ReviewRunRecord | undefined {
    load()
    const existing = runs.get(id)
    if (!existing) return undefined
    if (patch.status !== undefined && patch.status !== existing.status && isTerminalReviewRunStatus(existing.status)) {
      return undefined
    }
    const runId = persistRunMutation(() => {
      const now = Date.now()
      const next = withActiveLease({
        ...existing,
        ...patch,
        updatedAt: now,
      }, now)
      setStoredReviewRun(next)
      return existing.id
    })
    return copyReviewRunRecord(requiredStoredReviewRun(runId))
  }

  export function updateIfCurrent(
    identity: ReviewRunIdentity,
    patch: Partial<Omit<ReviewRunRecord, 'id' | 'rootRunId' | 'attempt' | 'retryOf' | 'triggerKey' | 'generation' | 'createdAt'>>,
  ): boolean {
    load()
    const existing = runs.get(identity.runId)
    if (!existing) return false
    if (existing.generation !== identity.generation || existing.sessionId !== identity.sessionId) return false
    if (findLatestByTriggerKeyInternal(existing.triggerKey)?.id !== existing.id) return false
    if (patch.status !== undefined && patch.status !== existing.status && isTerminalReviewRunStatus(existing.status)) {
      return false
    }
    persistRunMutation(() => {
      const now = Date.now()
      setStoredReviewRun(withActiveLease({
        ...existing,
        ...patch,
        updatedAt: now,
      }, now))
      return existing.id
    })
    return true
  }

  export function claimPublication(input: {
    runId: string
    payloadHash: string
    ownerId: string
    identity?: ReviewRunIdentity
    configurationError?: string
  }): PublicationClaimResult {
    load()
    const existing = runs.get(input.runId)
    if (!existing) return { ok: false, error: 'review_run_not_found' }
    const guardError = input.identity
      ? resultPublicationGuardError(existing, input.identity, input.configurationError)
      : input.configurationError
    if (guardError) return { ok: false, error: guardError }
    const publication = existing.publication
    if (existing.publishedAt || publication?.state === 'published') {
      return { ok: false, error: 'review_run_already_published' }
    }
    if (publication && publication.payloadHash !== input.payloadHash) {
      return { ok: false, error: 'review_run_publish_payload_mismatch' }
    }
    if (existing.failureNotification) {
      return { ok: false, error: existing.failureNotifiedAt
        ? 'review_run_failure_already_notified'
        : 'review_run_failure_notification_started' }
    }
    const activeClaim = activePublicationClaims.get(existing.id)
    if (activeClaim && publicationClaimMatches(existing, activeClaim)) {
      return { ok: false, error: 'review_run_publish_in_progress' }
    }

    const now = Date.now()
    const claimId = randomUUID()
    const completedMarkers = publication ? [...publication.completedMarkers] : []
    const identity = {
      runId: existing.id,
      claimId,
      ownerId: input.ownerId,
      payloadHash: input.payloadHash,
      sessionId: existing.sessionId,
      generation: existing.generation,
      allowTerminalFailure: existing.status === 'failed' && publication?.state === 'partial',
    }
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        updatedAt: now,
        publication: {
          state: 'publishing',
          claimId,
          ownerId: input.ownerId,
          payloadHash: input.payloadHash,
          startedAt: publication?.startedAt ?? now,
          updatedAt: now,
          summaryMarker: publication?.summaryMarker ?? gitLabReviewPublicationMarker({
            runId: existing.id,
            kind: 'summary',
          }),
          completedMarkers,
          error: undefined,
        },
      })
      activePublicationClaims.set(existing.id, identity)
      return existing.id
    })
    return {
      ok: true,
      claimId,
      resume: publication !== undefined,
      completedMarkers,
    }
  }

  export function isPublicationClaimCurrent(input: PublicationClaimIdentity): boolean {
    load()
    const existing = runs.get(input.runId)
    return Boolean(existing && isCurrentResultPublicationClaim(existing, input))
  }

  export function recordPublicationMarker(input: PublicationClaimIdentity & { marker: string }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !isCurrentResultPublicationClaim(existing, input)) return false
    if (existing.publication!.completedMarkers.includes(input.marker)) return true
    const now = Date.now()
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        updatedAt: now,
        publication: {
          ...existing.publication!,
          updatedAt: now,
          completedMarkers: [...existing.publication!.completedMarkers, input.marker],
        },
      })
      return existing.id
    })
    return true
  }

  export function replacePublicationMarkers(input: PublicationClaimIdentity & { markers: string[] }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !isCurrentResultPublicationClaim(existing, input)) return false
    const now = Date.now()
    const completedMarkers = [...new Set(input.markers)]
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        updatedAt: now,
        publication: {
          ...existing.publication!,
          updatedAt: now,
          completedMarkers,
        },
      })
      return existing.id
    })
    return true
  }

  export function failPublication(input: PublicationClaimIdentity & { error: string }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !publicationClaimMatches(existing, input) || !activePublicationClaimMatches(input)) return false
    const now = Date.now()
    const terminal = terminalReviewRunError(existing, input.allowTerminalFailure)
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        status: terminal ? existing.status : 'failed',
        error: terminal ? existing.error : input.error,
        updatedAt: now,
        publication: {
          ...existing.publication!,
          state: 'partial',
          claimId: undefined,
          ownerId: undefined,
          updatedAt: now,
          error: input.error,
        },
      })
      activePublicationClaims.delete(existing.id)
      return existing.id
    })
    return true
  }

  export function releasePublicationClaim(input: PublicationClaimIdentity & { preservePartial: boolean }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !publicationClaimMatches(existing, input) || !activePublicationClaimMatches(input)) return false
    const now = Date.now()
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        updatedAt: now,
        publication: input.preservePartial
          ? {
              ...existing.publication!,
              state: 'partial',
              claimId: undefined,
              ownerId: undefined,
              updatedAt: now,
            }
          : undefined,
      })
      activePublicationClaims.delete(existing.id)
      return existing.id
    })
    return true
  }

  export function rejectPublicationForPolicy(input: PublicationClaimIdentity & { error: string }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !publicationClaimMatches(existing, input) || !activePublicationClaimMatches(input)) return false
    const now = Date.now()
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        status: 'rejected',
        error: input.error,
        rejectionKind: 'policy',
        recoverable: false,
        updatedAt: now,
        publication: {
          ...existing.publication!,
          state: 'partial',
          claimId: undefined,
          ownerId: undefined,
          updatedAt: now,
          error: input.error,
        },
      })
      activePublicationClaims.delete(existing.id)
      return existing.id
    })
    return true
  }

  export function completePublication(input: PublicationClaimIdentity & {
    status: Extract<ReviewRunStatus, 'blocked' | 'succeeded' | 'failed'>
    warnings: string[]
  }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !isCurrentResultPublicationClaim(existing, input)) return false
    const now = Date.now()
    try {
      persistRunMutation(() => {
        setStoredReviewRun({
          ...existing,
          status: input.status,
          error: undefined,
          warnings: [...input.warnings],
          publishedAt: now,
          updatedAt: now,
          publication: {
            ...existing.publication!,
            state: 'published',
            claimId: undefined,
            ownerId: undefined,
            updatedAt: now,
            error: undefined,
          },
        })
        activePublicationClaims.delete(existing.id)
        return existing.id
      })
      return true
    } catch {
      const releaseAsPartial = () => {
        const current = runs.get(input.runId)
        if (!current || !publicationClaimMatches(current, input)) return input.runId
        const failedAt = Date.now()
        setStoredReviewRun({
          ...current,
          status: 'failed',
          error: 'review_run_publication_finalize_failed',
          publishedAt: undefined,
          updatedAt: failedAt,
          publication: {
            ...current.publication!,
            state: 'partial',
            claimId: undefined,
            ownerId: undefined,
            updatedAt: failedAt,
            error: 'review_run_publication_finalize_failed',
          },
        })
        activePublicationClaims.delete(input.runId)
        return input.runId
      }
      try {
        persistRunMutation(releaseAsPartial)
      } catch {
        releaseAsPartial()
      }
      return false
    }
  }

  export function claimFailureNotification(input: {
    identity: ReviewRunIdentity
    payloadHash: string
    ownerId: string
    configurationError?: string
  }): FailureNotificationClaimResult {
    load()
    const existing = runs.get(input.identity.runId)
    if (!existing) return { ok: false, error: 'review_run_not_found' }
    const guardError = failureNotificationGuardError(existing, input.identity, input.configurationError)
    if (guardError) return { ok: false, error: guardError }

    const now = Date.now()
    const claimId = randomUUID()
    const identity = {
      runId: existing.id,
      claimId,
      ownerId: input.ownerId,
      payloadHash: input.payloadHash,
      sessionId: existing.sessionId,
      generation: existing.generation,
    }
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        updatedAt: now,
        failureNotification: {
          state: 'notifying',
          claimId,
          ownerId: input.ownerId,
          payloadHash: input.payloadHash,
          startedAt: now,
          updatedAt: now,
          error: undefined,
        },
      })
      activeFailureNotificationClaims.set(existing.id, identity)
      return existing.id
    })
    return { ok: true, claimId }
  }

  export function isFailureNotificationClaimCurrent(input: FailureNotificationClaimIdentity): boolean {
    load()
    const existing = runs.get(input.runId)
    return Boolean(existing && isCurrentFailureNotificationClaim(existing, input))
  }

  export function completeFailureNotification(input: FailureNotificationClaimIdentity): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !isCurrentFailureNotificationClaim(existing, input)) return false
    const now = Date.now()
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        failureNotifiedAt: now,
        updatedAt: now,
        failureNotification: {
          ...existing.failureNotification!,
          state: 'notified',
          claimId: undefined,
          ownerId: undefined,
          updatedAt: now,
          error: undefined,
        },
      })
      activeFailureNotificationClaims.delete(existing.id)
      return existing.id
    })
    return true
  }

  export function failFailureNotification(input: FailureNotificationClaimIdentity & { error: string }): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !failureNotificationClaimMatches(existing, input) || !activeFailureNotificationClaimMatches(input)) {
      return false
    }
    const now = Date.now()
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        updatedAt: now,
        failureNotification: {
          ...existing.failureNotification!,
          state: 'partial',
          claimId: undefined,
          ownerId: undefined,
          updatedAt: now,
          error: input.error,
        },
      })
      activeFailureNotificationClaims.delete(existing.id)
      return existing.id
    })
    return true
  }

  export function rejectFailureNotificationForPolicy(
    input: FailureNotificationClaimIdentity & { error: string },
  ): boolean {
    load()
    const existing = runs.get(input.runId)
    if (!existing || !isCurrentFailureNotificationClaim(existing, input)) return false
    const now = Date.now()
    persistRunMutation(() => {
      setStoredReviewRun({
        ...existing,
        status: 'rejected',
        error: input.error,
        rejectionKind: 'policy',
        recoverable: false,
        updatedAt: now,
        failureNotification: {
          ...existing.failureNotification!,
          state: 'partial',
          claimId: undefined,
          ownerId: undefined,
          updatedAt: now,
          error: input.error,
        },
      })
      activeFailureNotificationClaims.delete(existing.id)
      return existing.id
    })
    return true
  }

  export function isActiveAttemptStale(run: ReviewRunRecord, at = Date.now()) {
    return (run.status === 'accepted' || run.status === 'running')
      && typeof run.activeLeaseExpiresAt === 'number'
      && Number.isFinite(run.activeLeaseExpiresAt)
      && at >= run.activeLeaseExpiresAt
  }

  export function createRetryAttemptGuarded(
    previous: ReviewRunRecord,
    input: CreateReviewRunInput,
    options: { now?: number } = {},
  ): GuardedRetryAttemptResult {
    load()
    const existing = runs.get(previous.id)
    if (!existing) return { ok: false, error: 'review_run_not_found' }
    if (existing.generation !== previous.generation || existing.sessionId !== previous.sessionId) {
      return { ok: false, error: 'review_run_not_current' }
    }
    if (findLatestByTriggerKeyInternal(existing.triggerKey)?.id !== existing.id) {
      return { ok: false, error: 'review_run_not_latest' }
    }
    if (existing.attempt >= maxAttempts()) return { ok: false, error: 'review_run_retry_limit_reached' }
    const at = options.now ?? Date.now()
    const active = existing.status === 'accepted' || existing.status === 'running'
    if (active && !isActiveAttemptStale(existing, at)) {
      return { ok: false, error: 'review_run_already_active' }
    }

    const runId = persistRunMutation(() => {
      if (active) {
        setStoredReviewRun({
          ...existing,
          status: 'failed',
          error: 'review_run_active_lease_expired',
          rejectionKind: 'transient',
          recoverable: true,
          activeLeaseExpiresAt: undefined,
          updatedAt: at,
        })
      }
      const run = createRecord({
        ...input,
        triggerKey: existing.triggerKey,
      }, {
        rootRunId: existing.rootRunId,
        attempt: existing.attempt + 1,
        retryOf: existing.id,
      }, at)
      setStoredReviewRun(run)
      return run.id
    })
    return { ok: true, run: copyReviewRunRecord(requiredStoredReviewRun(runId)) }
  }

  export function createRetryAttempt(
    previous: ReviewRunRecord,
    input: CreateReviewRunInput,
  ): ReviewRunRecord | undefined {
    load()
    const existing = runs.get(previous.id)
    if (!existing || existing.generation !== previous.generation) return undefined
    if (findLatestByTriggerKeyInternal(existing.triggerKey)?.id !== existing.id) return undefined

    const runId = persistRunMutation(() => {
      const run = createRecord({
        ...input,
        triggerKey: existing.triggerKey,
      }, {
        rootRunId: existing.rootRunId,
        attempt: existing.attempt + 1,
        retryOf: existing.id,
      })
      setStoredReviewRun(run)
      return run.id
    })
    return copyReviewRunRecord(requiredStoredReviewRun(runId))
  }

  export function list(options: { limit?: number } = {}): ReviewRunRecord[] {
    load()
    const sorted = [...runs.values()].sort(compareNewestFirst)
    const limit = options.limit && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : undefined
    return (limit ? sorted.slice(0, limit) : sorted).map(copyReviewRunRecord)
  }

  export function clearForTesting() {
    runs.clear()
    activePublicationClaims.clear()
    activeFailureNotificationClaims.clear()
    sequence = 0
    loaded = true
    if (storePathOverride && existsSync(storePathOverride)) {
      rmSync(storePathOverride, { force: true })
    }
  }

  export function setPathForTesting(filepath: string) {
    storePathOverride = filepath
    runs.clear()
    activePublicationClaims.clear()
    activeFailureNotificationClaims.clear()
    sequence = 0
    loaded = false
  }

  export function setMaxRecordsForTesting(limit: number | undefined) {
    maxRecordsOverride = limit
  }

  export function reloadForTesting() {
    runs.clear()
    activePublicationClaims.clear()
    activeFailureNotificationClaims.clear()
    sequence = 0
    loaded = false
  }
}

function createRecord(
  input: CreateReviewRunInput,
  lineage?: { rootRunId: string; attempt: number; retryOf: string },
  timestamp = Date.now(),
): ReviewRunRecord {
  const now = timestamp
  const id = `review_${now.toString(36)}_${(++sequence).toString(36)}`
  return withActiveLease({
    ...input,
    id,
    rootRunId: lineage?.rootRunId ?? id,
    attempt: lineage?.attempt ?? 1,
    retryOf: lineage?.retryOf,
    triggerKey: input.triggerKey || input.idempotencyKey || id,
    generation: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }, now)
}

function withActiveLease(run: ReviewRunRecord, at: number): ReviewRunRecord {
  if (run.status !== 'accepted' && run.status !== 'running') {
    return { ...run, activeLeaseExpiresAt: undefined }
  }
  return { ...run, activeLeaseExpiresAt: at + activeLeaseMs() }
}

function findLatestByTriggerKeyInternal(triggerKey: string) {
  return [...runs.values()]
    .filter((run) => run.triggerKey === triggerKey)
    .sort(compareLatestAttemptFirst)[0]
}

function reviewRunIdentityGuardError(run: ReviewRunRecord, identity: ReviewRunIdentity) {
  if (run.generation !== identity.generation || run.sessionId !== identity.sessionId) {
    return 'review_run_not_current'
  }
  if (findLatestByTriggerKeyInternal(run.triggerKey)?.id !== run.id) return 'review_run_not_latest'
  return undefined
}

function terminalReviewRunError(run: ReviewRunRecord, allowTerminalFailure = false) {
  if (run.status === 'rejected') return run.error ?? 'review_run_rejected'
  if (run.status === 'failed' && allowTerminalFailure) return undefined
  if (run.status === 'failed' || run.status === 'blocked' || run.status === 'succeeded') {
    return `review_run_terminal_${run.status}`
  }
  return undefined
}

function isTerminalReviewRunStatus(status: ReviewRunRecord['status']) {
  return status === 'failed' || status === 'rejected' || status === 'blocked' || status === 'succeeded'
}

function resultPublicationGuardError(
  run: ReviewRunRecord,
  identity: ReviewRunIdentity,
  configurationError?: string,
  allowTerminalFailure = run.publication?.state === 'partial',
) {
  if (configurationError) return configurationError
  const identityError = reviewRunIdentityGuardError(run, identity)
  if (identityError) return identityError
  if (run.failureNotifiedAt) return 'review_run_failure_already_notified'
  if (run.failureNotification) return 'review_run_failure_notification_started'
  if (run.publishedAt || run.publication?.state === 'published') return 'review_run_already_published'
  return terminalReviewRunError(run, allowTerminalFailure)
}

function failureNotificationGuardError(
  run: ReviewRunRecord,
  identity: ReviewRunIdentity,
  configurationError?: string,
) {
  if (configurationError) return configurationError
  const identityError = reviewRunIdentityGuardError(run, identity)
  if (identityError) return identityError
  if (run.publishedAt || run.publication?.state === 'published') return 'review_run_already_published'
  if (run.publication) return 'review_run_publish_in_progress'
  if (run.failureNotifiedAt || run.failureNotification?.state === 'notified') {
    return 'review_run_failure_already_notified'
  }
  if (run.failureNotification) return 'review_run_failure_notification_started'
  if (run.status === 'rejected') return run.error ?? 'review_run_rejected'
  if (run.status === 'blocked' || run.status === 'succeeded') return `review_run_terminal_${run.status}`
  if (run.status !== 'failed') return 'review_run_not_failed'
  return undefined
}

function isCurrentResultPublicationClaim(run: ReviewRunRecord, identity: PublicationClaimIdentity) {
  return publicationClaimMatches(run, identity)
    && activePublicationClaimMatches(identity)
    && resultPublicationGuardError(run, {
      runId: run.id,
      sessionId: identity.generation === undefined ? run.sessionId : identity.sessionId,
      generation: identity.generation ?? run.generation,
    }, undefined, identity.allowTerminalFailure) === undefined
}

function isCurrentFailureNotificationClaim(run: ReviewRunRecord, identity: FailureNotificationClaimIdentity) {
  return failureNotificationClaimMatches(run, identity)
    && activeFailureNotificationClaimMatches(identity)
    && reviewRunIdentityGuardError(run, {
      runId: run.id,
      sessionId: identity.generation === undefined ? run.sessionId : identity.sessionId,
      generation: identity.generation ?? run.generation,
    }) === undefined
    && run.status === 'failed'
    && !run.publication
    && !run.failureNotifiedAt
}

function publicationClaimMatches(run: ReviewRunRecord, identity: PublicationClaimIdentity) {
  const publication = run.publication
  return publication?.state === 'publishing'
    && publication.claimId === identity.claimId
    && publication.ownerId === identity.ownerId
    && publication.payloadHash === identity.payloadHash
    && (identity.generation === undefined || (
      run.generation === identity.generation
      && run.sessionId === identity.sessionId
    ))
}

function activePublicationClaimMatches(identity: PublicationClaimIdentity) {
  const active = activePublicationClaims.get(identity.runId)
  return active?.claimId === identity.claimId
    && active.ownerId === identity.ownerId
    && active.payloadHash === identity.payloadHash
    && (identity.generation === undefined || (
      active.generation === identity.generation
      && active.sessionId === identity.sessionId
    ))
    && (identity.generation === undefined || active.allowTerminalFailure === identity.allowTerminalFailure)
}

function failureNotificationClaimMatches(run: ReviewRunRecord, identity: FailureNotificationClaimIdentity) {
  const notification = run.failureNotification
  return notification?.state === 'notifying'
    && notification.claimId === identity.claimId
    && notification.ownerId === identity.ownerId
    && notification.payloadHash === identity.payloadHash
    && (identity.generation === undefined || (
      run.generation === identity.generation
      && run.sessionId === identity.sessionId
    ))
}

function activeFailureNotificationClaimMatches(identity: FailureNotificationClaimIdentity) {
  const active = activeFailureNotificationClaims.get(identity.runId)
  return active?.claimId === identity.claimId
    && active.ownerId === identity.ownerId
    && active.payloadHash === identity.payloadHash
    && (identity.generation === undefined || (
      active.generation === identity.generation
      && active.sessionId === identity.sessionId
    ))
}

function copyReviewRunRecord(run: ReviewRunRecord): ReviewRunRecord {
  const copy = copyJsonValue(run)
  copy.publication = copy.publication ?? undefined
  copy.failureNotification = copy.failureNotification ?? undefined
  return copy
}

function setStoredReviewRun(run: ReviewRunRecord) {
  const stored = copyReviewRunRecord(run)
  runs.set(stored.id, stored)
}

function requiredStoredReviewRun(id: string) {
  const run = runs.get(id)
  if (!run) throw new Error('review_run_missing_after_persist')
  return run
}

function copyJsonValue<T>(value: T): T {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('review_run_value_not_json_serializable')
  const copy = JSON.parse(json) as T
  restoreExplicitUndefinedProperties(value, copy)
  return copy
}

function restoreExplicitUndefinedProperties(source: unknown, target: unknown) {
  if (!source || typeof source !== 'object' || !target || typeof target !== 'object') return
  if (Array.isArray(source)) {
    if (!Array.isArray(target)) return
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== undefined) restoreExplicitUndefinedProperties(source[index], target[index])
    }
    return
  }
  if (Array.isArray(target)) return
  const sourceRecord = source as Record<string, unknown>
  const targetRecord = target as Record<string, unknown>
  for (const key of Object.keys(sourceRecord)) {
    if (sourceRecord[key] === undefined) {
      targetRecord[key] = undefined
      continue
    }
    if (Object.prototype.hasOwnProperty.call(targetRecord, key)) {
      restoreExplicitUndefinedProperties(sourceRecord[key], targetRecord[key])
    }
  }
}

function load() {
  if (loaded) return
  loaded = true
  const filepath = storePath()
  if (!existsSync(filepath)) return
  try {
    const parsed = JSON.parse(readFileSync(filepath, 'utf-8')) as Partial<ReviewRunStoreFile>
    const records = Array.isArray(parsed.runs)
      ? parsed.runs.filter(isStoredReviewRunRecord).map(normalizeStoredReviewRun)
      : []
    runs.clear()
    for (const run of records) {
      setStoredReviewRun(run)
    }
    sequence = typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)
      ? parsed.sequence
      : inferSequence(records)
  } catch {
    runs.clear()
    sequence = 0
  }
}

function save(retainedRunIds: Iterable<string> = []) {
  const filepath = storePath()
  mkdirSync(dirname(filepath), { recursive: true })
  prune(retainedRunIds)
  const data: ReviewRunStoreFile = {
    version: 2,
    sequence,
    runs: [...runs.values()],
  }
  const tempPath = `${filepath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tempPath, filepath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

function persistRunMutation(mutate: () => string) {
  return persistMutation(mutate, (runId) => [runId])
}

function persistMutation<T>(mutate: () => T, retainedRunIds: (result: T) => Iterable<string>): T {
  const previous = snapshotStoreState()
  try {
    const result = mutate()
    save(retainedRunIds(result))
    return result
  } catch (error) {
    restoreStoreState(previous)
    throw error
  }
}

function snapshotStoreState() {
  return {
    runs: new Map([...runs].map(([id, run]) => [id, copyReviewRunRecord(run)])),
    activePublicationClaims: new Map(
      [...activePublicationClaims].map(([id, claim]) => [id, copyJsonValue(claim)]),
    ),
    activeFailureNotificationClaims: new Map(
      [...activeFailureNotificationClaims].map(([id, claim]) => [id, copyJsonValue(claim)]),
    ),
    sequence,
  }
}

function restoreStoreState(snapshot: ReturnType<typeof snapshotStoreState>) {
  runs.clear()
  for (const [id, run] of snapshot.runs) runs.set(id, run)
  activePublicationClaims.clear()
  for (const [id, claim] of snapshot.activePublicationClaims) activePublicationClaims.set(id, claim)
  activeFailureNotificationClaims.clear()
  for (const [id, claim] of snapshot.activeFailureNotificationClaims) {
    activeFailureNotificationClaims.set(id, claim)
  }
  sequence = snapshot.sequence
}

function prune(retainedRunIds: Iterable<string>) {
  repairRunLineage()
  removeOrphanedPublicationClaims()
  const limit = maxRecords()
  if (runs.size <= limit) return
  const groups = groupRunsByTriggerKey([...runs.values()])
  groups.sort((a, b) => compareNewestFirst(a.latest, b.latest))
  const keep = new Set<string>()
  const protectedTriggerKeys = new Set<string>()
  for (const runId of retainedRunIds) {
    const run = runs.get(runId)
    if (run) protectedTriggerKeys.add(run.triggerKey)
  }
  for (const runId of activePublicationClaims.keys()) {
    const run = runs.get(runId)
    if (run) protectedTriggerKeys.add(run.triggerKey)
  }
  for (const runId of activeFailureNotificationClaims.keys()) {
    const run = runs.get(runId)
    if (run) protectedTriggerKeys.add(run.triggerKey)
  }
  for (const group of groups) {
    if (!protectedTriggerKeys.has(group.latest.triggerKey)) continue
    for (const run of group.records) {
      if (keep.size >= limit) break
      keep.add(run.id)
    }
  }
  for (const group of groups) {
    if (protectedTriggerKeys.has(group.latest.triggerKey)) continue
    if (keep.size + group.records.length <= limit) {
      for (const run of group.records) keep.add(run.id)
      continue
    }
    if (keep.size === 0) {
      for (const run of group.records.slice(0, limit)) keep.add(run.id)
    }
  }
  for (const id of runs.keys()) {
    if (!keep.has(id)) runs.delete(id)
  }
  repairRunLineage()
  removeOrphanedPublicationClaims()
}

function removeOrphanedPublicationClaims() {
  for (const [runId, claim] of activePublicationClaims) {
    const run = runs.get(runId)
    if (!run || claim.runId !== runId || !publicationClaimMatches(run, claim)) {
      activePublicationClaims.delete(runId)
    }
  }
  for (const [runId, claim] of activeFailureNotificationClaims) {
    const run = runs.get(runId)
    if (!run || claim.runId !== runId || !failureNotificationClaimMatches(run, claim)) {
      activeFailureNotificationClaims.delete(runId)
    }
  }
}

function repairRunLineage() {
  for (const group of groupRunsByTriggerKey([...runs.values()])) {
    const ordered = [...group.records].sort(compareOldestAttemptFirst)
    if (isContiguousAttemptChainSuffix(ordered)) {
      const rootRunId = ordered[0]!.id
      for (let index = 0; index < ordered.length; index += 1) {
        setRunLineage(ordered[index]!, rootRunId, index === 0 ? undefined : ordered[index - 1]!.id)
      }
      continue
    }

    // Malformed groups stay as standalone self-rooted audit entries; no lineage is invented.
    for (const run of ordered) setRunLineage(run, run.id, undefined)
  }
}

function isContiguousAttemptChainSuffix(records: ReviewRunRecord[]) {
  const first = records[0]
  if (!first) return false
  for (const record of records) {
    for (const reference of [record.rootRunId, record.retryOf]) {
      if (!reference) continue
      const target = runs.get(reference)
      if (target && target.triggerKey !== record.triggerKey) return false
    }
  }
  const ids = new Set(records.map((run) => run.id))
  if (first.rootRunId !== first.id && ids.has(first.rootRunId)) return false
  if (first.retryOf && ids.has(first.retryOf)) return false
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!
    const current = records[index]!
    if (
      current.attempt !== previous.attempt + 1
      || current.retryOf !== previous.id
      || current.rootRunId !== first.rootRunId
    ) {
      return false
    }
  }
  return true
}

function setRunLineage(run: ReviewRunRecord, rootRunId: string, retryOf: string | undefined) {
  if (run.rootRunId === rootRunId && run.retryOf === retryOf) return
  setStoredReviewRun({ ...run, rootRunId, retryOf })
}

function groupRunsByTriggerKey(records: ReviewRunRecord[]) {
  const byTriggerKey = new Map<string, ReviewRunRecord[]>()
  for (const run of records) {
    const group = byTriggerKey.get(run.triggerKey)
    if (group) group.push(run)
    else byTriggerKey.set(run.triggerKey, [run])
  }
  return [...byTriggerKey.values()].map((group) => {
    group.sort(compareNewestFirst)
    return { records: group, latest: group[0]! }
  })
}

function inferSequence(records: ReviewRunRecord[]) {
  return records.length
}

function compareNewestFirst(a: ReviewRunRecord, b: ReviewRunRecord) {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id)
}

function compareLatestAttemptFirst(a: ReviewRunRecord, b: ReviewRunRecord) {
  return b.attempt - a.attempt || compareNewestFirst(a, b)
}

function compareOldestAttemptFirst(a: ReviewRunRecord, b: ReviewRunRecord) {
  return a.attempt - b.attempt
    || a.createdAt - b.createdAt
    || a.updatedAt - b.updatedAt
    || a.id.localeCompare(b.id)
}

function normalizeStoredReviewRun(input: Record<string, unknown>): ReviewRunRecord {
  const id = input.id as string
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined
  const updatedAt = input.updatedAt as number
  const status = input.status as ReviewRunStatus
  return {
    ...input,
    id,
    platform: 'gitlab',
    status,
    createdAt: input.createdAt as number,
    updatedAt,
    activeLeaseExpiresAt: status === 'accepted' || status === 'running'
      ? typeof input.activeLeaseExpiresAt === 'number' && Number.isFinite(input.activeLeaseExpiresAt)
        ? input.activeLeaseExpiresAt
        : updatedAt + activeLeaseMs()
      : undefined,
    rootRunId: typeof input.rootRunId === 'string' && input.rootRunId ? input.rootRunId : id,
    attempt: typeof input.attempt === 'number' && Number.isInteger(input.attempt) && input.attempt > 0
      ? input.attempt
      : 1,
    triggerKey: typeof input.triggerKey === 'string' && input.triggerKey
      ? input.triggerKey
      : idempotencyKey || id,
    generation: typeof input.generation === 'string' && input.generation
      ? input.generation
      : `legacy-${id}`,
    repository: normalizeStoredRepositorySummary(input.repository),
    publication: normalizeStoredPublication(input.publication, id, updatedAt),
    failureNotification: normalizeStoredFailureNotification(input.failureNotification, updatedAt),
  } as ReviewRunRecord
}

function normalizeStoredRepositorySummary(input: unknown): ReviewRunRepositorySummary | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const repository = input as Record<string, unknown>
  return {
    ...storedRepositoryCounter('queryCount', repository.queryCount),
    ...storedRepositoryCounter('readCount', repository.readCount),
    ...storedRepositoryCounter('searchCount', repository.searchCount),
    ...storedRepositoryCounter('outputBytes', repository.outputBytes),
    ...storedRepositoryCounter('apiRequestCount', repository.apiRequestCount),
    ...storedRepositoryCounter('fileFetchCount', repository.fileFetchCount),
    ...storedRepositoryCounter('fetchedBytes', repository.fetchedBytes),
  }
}

function storedRepositoryCounter(
  key: keyof ReviewRunRepositorySummary,
  value: unknown,
): Partial<ReviewRunRepositorySummary> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { [key]: value }
    : {}
}

function normalizeStoredPublication(input: unknown, runId: string, runUpdatedAt: number): ReviewRunPublication | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const publication = input as Record<string, unknown>
  if (publication.state !== 'publishing' && publication.state !== 'partial' && publication.state !== 'published') {
    return undefined
  }
  if (typeof publication.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(publication.payloadHash)) return undefined
  if (
    !Array.isArray(publication.completedMarkers)
    || publication.completedMarkers.some((marker) => typeof marker !== 'string')
  ) {
    return undefined
  }

  const state = publication.state === 'publishing' ? 'partial' : publication.state
  const updatedAt = typeof publication.updatedAt === 'number' && Number.isFinite(publication.updatedAt)
    ? publication.updatedAt
    : runUpdatedAt
  const startedAt = typeof publication.startedAt === 'number' && Number.isFinite(publication.startedAt)
    ? publication.startedAt
    : undefined

  return {
    state,
    claimId: undefined,
    ownerId: undefined,
    payloadHash: publication.payloadHash,
    startedAt,
    updatedAt,
    summaryMarker: gitLabReviewPublicationMarker({ runId, kind: 'summary' }),
    completedMarkers: [...new Set(publication.completedMarkers)],
    error: typeof publication.error === 'string' ? publication.error : undefined,
  }
}

function normalizeStoredFailureNotification(
  input: unknown,
  runUpdatedAt: number,
): ReviewRunFailureNotification | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const notification = input as Record<string, unknown>
  if (notification.state !== 'notifying' && notification.state !== 'partial' && notification.state !== 'notified') {
    return undefined
  }
  if (typeof notification.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(notification.payloadHash)) {
    return undefined
  }
  const claimId = normalizedIdentityField(notification.claimId)
  const ownerId = normalizedIdentityField(notification.ownerId)
  const state = notification.state === 'notifying' && (!claimId || !ownerId)
    ? 'partial'
    : notification.state
  const startedAt = typeof notification.startedAt === 'number' && Number.isFinite(notification.startedAt)
    ? notification.startedAt
    : runUpdatedAt
  const updatedAt = typeof notification.updatedAt === 'number' && Number.isFinite(notification.updatedAt)
    ? notification.updatedAt
    : runUpdatedAt
  return {
    state,
    claimId: state === 'notifying' ? claimId : undefined,
    ownerId: state === 'notifying' ? ownerId : undefined,
    payloadHash: notification.payloadHash,
    startedAt,
    updatedAt,
    error: typeof notification.error === 'string' ? notification.error : undefined,
  }
}

function normalizedIdentityField(input: unknown) {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function isStoredReviewRunRecord(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return typeof record.id === 'string'
    && record.platform === 'gitlab'
    && typeof record.status === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
}
