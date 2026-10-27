import { markRaw, reactive, shallowReactive, watch, effectScope } from 'vue'
import { createRequestID, getApiDirectory, getApiClientSurface, type MessageAttempt } from '../api/client'
import { useFileUpload, type FileAttachment } from './useFileUpload'

import { clearStoredDrafts, draftStorageKey, readStoredDraft, removeStoredDraft, writeStoredDraft } from './draft-storage'

export interface SendAttempt extends MessageAttempt {
  id: string
  text: string
  planMode: boolean
  attachments: FileAttachment[]
  status: 'sending' | 'failed'
  attachmentsLost?: boolean
  generation: number
}

export interface ComposerDraft {
  text: string
  planMode: boolean
  attachmentsLost: boolean
  storageFailed: boolean
  attempts: SendAttempt[]
  ensureSession: () => Promise<string | null>
  uploads: ReturnType<typeof useFileUpload>
}

const drafts = new Map<string, ComposerDraft>()
const idleCacheLimit = 32
const noSession = async () => null
const migratedOwners = new WeakMap<ComposerDraft, ComposerDraft>()
function currentDraft(draft: ComposerDraft): ComposerDraft {
  const next = migratedOwners.get(draft)
  return next ? currentDraft(next) : draft
}
interface DraftLeaseState { owner?: ComposerDraft; ensureSession?: () => Promise<string | null> }
interface DraftPersistence {
  key: string
  stop: () => void
  save: () => boolean
  leases: Set<DraftLeaseState>
  released: boolean
  disposed: boolean
}
const persistence = new WeakMap<ComposerDraft, DraftPersistence>()
const uploadOwners = new WeakMap<ComposerDraft['uploads'], { owner?: ComposerDraft }>()
let cleanupQueued = false

function updateSessionResolver(draft: ComposerDraft, state: DraftPersistence) {
  const leases = [...state.leases]
  draft.ensureSession = leases[leases.length - 1]?.ensureSession || noSession
}

function disposeDraft(draft: ComposerDraft, state: DraftPersistence) {
  state.disposed = true
  state.stop()
  draft.ensureSession = noSession
  for (const lease of state.leases) { lease.owner = undefined; lease.ensureSession = undefined }
  state.leases.clear()
  if (drafts.get(state.key) === draft) drafts.delete(state.key)
}

// Files and active sends cannot be reconstructed from text-only tab storage.
// A failed write must also keep the complete draft in memory for the user.
function canStoreCold(draft: ComposerDraft) {
  return !draft.uploads.attachments.value.length
    && draft.attempts.every(attempt => attempt.status !== 'sending' && !attempt.attachments.length && !attempt.onCancel && !attempt.submission)
}

function cleanupDrafts() {
  cleanupQueued = false
  for (const draft of drafts.values()) {
    const state = persistence.get(draft)!
    if (state.leases.size || !canStoreCold(draft)) continue
    const empty = !draft.text && !draft.planMode && !draft.attachmentsLost && !draft.attempts.length
    if (!empty && !state.released && drafts.size <= idleCacheLimit) continue
    if (!empty) {
      // Only discard the live object after its allowlisted representation can
      // actually be read back (including a valid recovery ID for uncertain sends).
      if (!state.save()) continue
      if (!readStoredDraft(state.key)) { draft.storageFailed = true; continue }
    }
    disposeDraft(draft, state)
  }
}

function scheduleCleanup() {
  if (cleanupQueued) return
  cleanupQueued = true
  queueMicrotask(cleanupDrafts)
}

export interface ComposerDraftLease {
  readonly draft: ComposerDraft
  release: () => void
}

// A view owns its session-creation callback only while it displays the draft.
// Acquiring before releasing the old lease also supports two views of one draft.
export function acquireComposerDraft(key: string, ensureSession?: () => Promise<string | null>, directory = getApiDirectory()): ComposerDraftLease {
  const draft = getComposerDraft(key, undefined, directory)
  const state = persistence.get(draft)!
  const lease = shallowReactive<DraftLeaseState>({ owner: draft, ensureSession })
  state.leases.add(lease)
  state.released = false
  updateSessionResolver(draft, state)
  return {
    get draft() { return lease.owner || currentDraft(draft) },
    release() {
      const owner = lease.owner
      if (!owner) return
      const current = persistence.get(owner)!
      current.leases.delete(lease)
      lease.owner = undefined
      lease.ensureSession = undefined
      updateSessionResolver(owner, current)
      if (!current.leases.size) current.released = true
      scheduleCleanup()
    },
  }
}

export function getComposerDraft(key: string, ensureSession?: () => Promise<string | null>, directory = getApiDirectory()): ComposerDraft {
  const storageKey = draftStorageKey(key, directory, getApiClientSurface())
  let draft = drafts.get(storageKey)
  if (!draft) {
    const uploadOwner: { owner?: ComposerDraft } = {}
    const uploads = markRaw(useFileUpload({ ensureSessionId: () => uploadOwner.owner?.ensureSession() ?? noSession() }))
    const stored = readStoredDraft(storageKey)
    draft = reactive({ text: stored?.text || '', planMode: stored?.planMode || false,
      attachmentsLost: stored?.attachmentsLost || false, storageFailed: false,
      attempts: (stored?.attempts || []).map(item => ({ ...item, recoverySessionID: item.sessionID, status: 'failed', generation: 0, attachments: [] })),
      ensureSession: ensureSession || noSession, uploads }) as ComposerDraft
    uploadOwner.owner = draft
    uploadOwners.set(uploads, uploadOwner)
    drafts.set(storageKey, draft)
    const owner = draft
    const state: DraftPersistence = { key: storageKey, stop: () => {}, save: () => false, leases: new Set(), released: false, disposed: false }
    const snapshot = () => ({ text: owner.text, planMode: owner.planMode,
      attachmentsLost: owner.attachmentsLost || owner.uploads.attachments.value.length > 0,
      attempts: owner.attempts.map(item => ({ id: item.id, text: item.text, planMode: item.planMode,
        submitted: Boolean(item.submitted), sessionID: item.submission?.sessionID || item.recoverySessionID,
        attachmentsLost: Boolean(item.attachmentsLost || item.attachments.length) })) })
    state.save = () => {
      if (state.disposed) return false
      const saved = writeStoredDraft(state.key, snapshot())
      owner.storageFailed = !saved
      return saved
    }
    // Draft lifetime outlives a particular InputBox component or route.
    const scope = effectScope(true)
    scope.run(() => watch(snapshot, () => { state.save(); scheduleCleanup() }, { deep: true, flush: 'sync' }))
    state.stop = () => scope.stop()
    persistence.set(owner, state)
  }
  // Touch insertion order so only the oldest safely persisted inactive drafts
  // are evicted when callers inspect drafts without a view lease.
  drafts.delete(storageKey)
  drafts.set(storageKey, draft)
  if (ensureSession) draft.ensureSession = ensureSession
  scheduleCleanup()
  return draft
}

// Creating a real session preserves the same draft object, including in-flight uploads.
export function moveComposerDraft(from: string, to: string, toDirectory = getApiDirectory(), fromDirectory = getApiDirectory()) {
  const fromKey = draftStorageKey(from, fromDirectory, getApiClientSurface())
  const toKey = draftStorageKey(to, toDirectory, getApiClientSurface())
  const draft = drafts.get(fromKey) || (readStoredDraft(fromKey) ? getComposerDraft(from, undefined, fromDirectory) : undefined)
  if (!draft || fromKey === toKey) return
  if (from === to && fromDirectory !== toDirectory) {
    // Upload handles belong to the old directory. Only text/request identity can
    // cross an existing-session directory change without revalidation.
    if (draft.uploads.attachments.value.length) {
      draft.attachmentsLost = true
      draft.uploads.clearAll()
    }
    for (const attempt of draft.attempts) {
      if (!attempt.attachments.length) continue
      attempt.attachmentsLost = true
      for (const file of attempt.attachments) {
        file.controller?.abort()
        if (file.preview) URL.revokeObjectURL(file.preview)
      }
      attempt.attachments = []
    }
  }
  const destination = drafts.get(toKey) || (readStoredDraft(toKey) ? getComposerDraft(to, draft.ensureSession, toDirectory) : undefined)
  if (destination && destination !== draft) {
    // A user may already be editing the committed destination while the update
    // response is delayed. Keep that live object/text; retain conflicting source
    // text as an explicitly recoverable attempt rather than overwrite or combine.
    const state = persistence.get(draft)!
    state?.stop()
    for (const attempt of draft.attempts) if (!destination.attempts.some(item => item.id === attempt.id)) destination.attempts.push(attempt)
    if (draft.text || draft.planMode || draft.uploads.attachments.value.length || draft.attachmentsLost) {
      if (!destination.text && !destination.planMode && !destination.uploads.attachments.value.length && !destination.attachmentsLost) {
        destination.text = draft.text
        destination.planMode = draft.planMode
        destination.attachmentsLost = draft.attachmentsLost
        destination.uploads = draft.uploads
        uploadOwners.get(destination.uploads)!.owner = destination
      } else {
        destination.attempts.push({ id: createRequestID(), text: draft.text, planMode: draft.planMode,
          attachments: [...draft.uploads.attachments.value], attachmentsLost: draft.attachmentsLost, status: 'failed', generation: 0 })
      }
    }
    migratedOwners.set(draft, destination)
    const destinationState = persistence.get(destination)!
    for (const lease of state.leases) {
      lease.owner = destination
      destinationState.leases.add(lease)
    }
    state.leases.clear()
    draft.ensureSession = noSession
    state.disposed = true
    if (destinationState.leases.size) destinationState.released = false
    updateSessionResolver(destination, destinationState)
    drafts.delete(fromKey)
    removeStoredDraft(fromKey)
    persistence.get(destination)?.save()
    scheduleCleanup()
    return
  }
  drafts.set(toKey, draft)
  drafts.delete(fromKey)
  const state = persistence.get(draft)
  if (state) {
    removeStoredDraft(state.key)
    state.key = toKey
    state.save()
  }
  scheduleCleanup()
}

export function beginSend(draft: ComposerDraft): SendAttempt {
  draft = currentDraft(draft)
  const attempt: SendAttempt = reactive({
    id: createRequestID(),
    text: draft.text.trim(),
    planMode: draft.planMode,
    attachments: [...draft.uploads.attachments.value],
    status: 'sending',
    generation: 0,
    attachmentsLost: draft.attachmentsLost,
  })
  draft.attachmentsLost = false
  draft.text = ''
  draft.planMode = false
  draft.uploads.attachments.value = []
  draft.attempts.push(attempt)
  return attempt
}

export function finishSend(draft: ComposerDraft, attempt: SendAttempt, success: boolean, generation = attempt.generation) {
  draft = currentDraft(draft)
  if (attempt.generation !== generation || !draft.attempts.includes(attempt)) return
  attempt.onCancel = undefined
  scheduleCleanup()
  if (!success) {
    attempt.status = 'failed'
    return
  }
  draft.attempts = draft.attempts.filter(item => item.id !== attempt.id)
  for (const file of attempt.attachments) if (file.preview) URL.revokeObjectURL(file.preview)
}

export function restoreAttempt(draft: ComposerDraft, attempt: SendAttempt) {
  draft = currentDraft(draft)
  // An uncertain POST may already be accepted. Do not turn it into a new send.
  if (attempt.submitted || draft.text || draft.uploads.attachments.value.length) return false
  attempt.generation++
  draft.text = attempt.text
  draft.planMode = attempt.planMode
  draft.attachmentsLost = Boolean(attempt.attachmentsLost)
  draft.uploads.attachments.value = attempt.attachments
  draft.attempts = draft.attempts.filter(item => item.id !== attempt.id)
  return true
}

export function clearComposerDrafts(key?: string, preserveStorage = false) {
  if (!preserveStorage) clearStoredDrafts(key)
  for (const [id, draft] of drafts) {
    if (key && JSON.parse(id.slice(id.indexOf('[')))[2] !== key) continue
    const state = persistence.get(draft)
    if (state) disposeDraft(draft, state)
    if (!preserveStorage && state) removeStoredDraft(state.key)
    draft.uploads.clearAll()
    for (const attempt of draft.attempts) {
      for (const file of attempt.attachments) if (file.preview) URL.revokeObjectURL(file.preview)
    }
    drafts.delete(id)
  }
}
