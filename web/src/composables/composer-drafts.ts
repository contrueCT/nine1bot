import { markRaw, reactive, watch, effectScope } from 'vue'
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
const migratedOwners = new WeakMap<ComposerDraft, ComposerDraft>()
function currentDraft(draft: ComposerDraft): ComposerDraft {
  const next = migratedOwners.get(draft)
  return next ? currentDraft(next) : draft
}
const persistence = new WeakMap<ComposerDraft, { key: string; stop: () => void; save: () => void }>()

export function getComposerDraft(key: string, ensureSession: () => Promise<string | null> = async () => null, directory = getApiDirectory()): ComposerDraft {
  const storageKey = draftStorageKey(key, directory, getApiClientSurface())
  let draft = drafts.get(storageKey)
  if (!draft) {
    const uploads = markRaw(useFileUpload({ ensureSessionId: () => draft!.ensureSession() }))
    const stored = readStoredDraft(storageKey)
    draft = reactive({ text: stored?.text || '', planMode: stored?.planMode || false,
      attachmentsLost: stored?.attachmentsLost || false, storageFailed: false,
      attempts: (stored?.attempts || []).map(item => ({ ...item, recoverySessionID: item.sessionID, status: 'failed', generation: 0, attachments: [] })),
      ensureSession, uploads }) as ComposerDraft
    drafts.set(storageKey, draft)
    const owner = draft
    const state = { key: storageKey, stop: () => {}, save: () => {} }
    const snapshot = () => ({ text: owner.text, planMode: owner.planMode,
      attachmentsLost: owner.attachmentsLost || owner.uploads.attachments.value.length > 0,
      attempts: owner.attempts.map(item => ({ id: item.id, text: item.text, planMode: item.planMode,
        submitted: Boolean(item.submitted), sessionID: item.submission?.sessionID || item.recoverySessionID,
        attachmentsLost: Boolean(item.attachmentsLost || item.attachments.length) })) })
    state.save = () => { owner.storageFailed = !writeStoredDraft(state.key, snapshot()) }
    // Draft lifetime outlives a particular InputBox component or route.
    const scope = effectScope(true)
    scope.run(() => watch(snapshot, state.save, { deep: true, flush: 'sync' }))
    state.stop = () => scope.stop()
    persistence.set(owner, state)
  }
  draft.ensureSession = ensureSession
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
    const state = persistence.get(draft)
    state?.stop()
    for (const attempt of draft.attempts) if (!destination.attempts.some(item => item.id === attempt.id)) destination.attempts.push(attempt)
    if (draft.text || draft.uploads.attachments.value.length || draft.attachmentsLost) {
      if (!destination.text && !destination.uploads.attachments.value.length && !destination.attachmentsLost) {
        destination.text = draft.text
        destination.planMode = draft.planMode
        destination.attachmentsLost = draft.attachmentsLost
        destination.uploads = draft.uploads
      } else {
        destination.attempts.push({ id: createRequestID(), text: draft.text, planMode: draft.planMode,
          attachments: [...draft.uploads.attachments.value], attachmentsLost: draft.attachmentsLost, status: 'failed', generation: 0 })
      }
    }
    migratedOwners.set(draft, destination)
    drafts.delete(fromKey)
    removeStoredDraft(fromKey)
    persistence.get(destination)?.save()
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
    state?.stop()
    if (!preserveStorage && state) removeStoredDraft(state.key)
    draft.uploads.clearAll()
    for (const attempt of draft.attempts) {
      for (const file of attempt.attachments) if (file.preview) URL.revokeObjectURL(file.preview)
    }
    drafts.delete(id)
  }
}
