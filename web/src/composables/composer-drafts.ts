import { markRaw, reactive } from 'vue'
import { createRequestID, type MessageAttempt } from '../api/client'
import { useFileUpload, type FileAttachment } from './useFileUpload'

export interface SendAttempt extends MessageAttempt {
  id: string
  text: string
  planMode: boolean
  attachments: FileAttachment[]
  status: 'sending' | 'failed'
  generation: number
}

export interface ComposerDraft {
  text: string
  planMode: boolean
  attempts: SendAttempt[]
  ensureSession: () => Promise<string | null>
  uploads: ReturnType<typeof useFileUpload>
}

const drafts = new Map<string, ComposerDraft>()

export function getComposerDraft(key: string, ensureSession: () => Promise<string | null> = async () => null): ComposerDraft {
  let draft = drafts.get(key)
  if (!draft) {
    const uploads = markRaw(useFileUpload({ ensureSessionId: () => draft!.ensureSession() }))
    draft = reactive({ text: '', planMode: false, attempts: [], ensureSession, uploads }) as ComposerDraft
    drafts.set(key, draft)
  }
  draft.ensureSession = ensureSession
  return draft
}

// Creating a real session preserves the same draft object, including in-flight uploads.
export function moveComposerDraft(from: string, to: string) {
  const draft = drafts.get(from)
  if (!draft || from === to) return
  drafts.set(to, draft)
  drafts.delete(from)
}

export function beginSend(draft: ComposerDraft): SendAttempt {
  const attempt: SendAttempt = reactive({
    id: createRequestID(),
    text: draft.text.trim(),
    planMode: draft.planMode,
    attachments: [...draft.uploads.attachments.value],
    status: 'sending',
    generation: 0,
  })
  draft.text = ''
  draft.planMode = false
  draft.uploads.attachments.value = []
  draft.attempts.push(attempt)
  return attempt
}

export function finishSend(draft: ComposerDraft, attempt: SendAttempt, success: boolean, generation = attempt.generation) {
  if (attempt.generation !== generation || !draft.attempts.includes(attempt)) return
  if (!success) {
    attempt.status = 'failed'
    return
  }
  draft.attempts = draft.attempts.filter(item => item.id !== attempt.id)
  for (const file of attempt.attachments) if (file.preview) URL.revokeObjectURL(file.preview)
}

export function restoreAttempt(draft: ComposerDraft, attempt: SendAttempt) {
  // An uncertain POST may already be accepted. Only replay its original ID/payload.
  if (attempt.submitted || draft.text || draft.uploads.attachments.value.length) return false
  attempt.generation++
  draft.text = attempt.text
  draft.planMode = attempt.planMode
  draft.uploads.attachments.value = attempt.attachments
  draft.attempts = draft.attempts.filter(item => item.id !== attempt.id)
  return true
}

export function clearComposerDrafts(key?: string) {
  for (const [id, draft] of drafts) {
    if (key && id !== key) continue
    draft.uploads.clearAll()
    for (const attempt of draft.attempts) {
      for (const file of attempt.attachments) if (file.preview) URL.revokeObjectURL(file.preview)
    }
    drafts.delete(id)
  }
}
