// Tab-local, versioned, text-only storage. Never persist File objects, upload URLs,
// page context, credentials, or a replayable request body.
export const DRAFT_PREFIX = 'nine1bot:composer:v1:'
const TTL = 24 * 60 * 60 * 1000
const MAX_TEXT = 200_000
const MAX_RECORD = 500_000
export interface StoredAttempt {
  id: string
  text: string
  planMode: boolean
  submitted: boolean
  sessionID?: string
  attachmentsLost: boolean
}
export interface StoredDraft {
  version: 1
  updatedAt: number
  text: string
  planMode: boolean
  attachmentsLost: boolean
  attempts: StoredAttempt[]
}
export function draftStorageKey(key: string, directory: string, surface: string) {
  return DRAFT_PREFIX + JSON.stringify([surface, directory, key])
}
function storage(): Storage | undefined {
  try { return globalThis.sessionStorage } catch { return undefined }
}
export function removeStoredDraft(key: string) {
  try { storage()?.removeItem(key) } catch { /* private mode / blocked storage */ }
}
export function clearStoredDrafts(composerKey?: string) {
  const target = storage()
  if (!target) return
  try {
    for (let i = target.length - 1; i >= 0; i--) {
      const key = target.key(i)
      if (!key?.startsWith(DRAFT_PREFIX)) continue
      try {
        if (!composerKey || JSON.parse(key.slice(DRAFT_PREFIX.length))[2] === composerKey) target.removeItem(key)
      } catch { target.removeItem(key) }
    }
  } catch { /* best effort; in-memory drafts still clear */ }
}
export function readStoredDraft(key: string, now = Date.now()): StoredDraft | undefined {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return
    if (raw.length > MAX_RECORD) throw new Error('oversize')
    const data = JSON.parse(raw)
    const validText = (value: unknown) => typeof value === 'string' && value.length <= MAX_TEXT
    if (data.version !== 1 || !Number.isFinite(data.updatedAt) || data.updatedAt > now + 60_000 || now - data.updatedAt > TTL
      || !validText(data.text) || typeof data.planMode !== 'boolean' || typeof data.attachmentsLost !== 'boolean'
      || !Array.isArray(data.attempts) || data.attempts.length > 20) throw new Error('invalid draft')
    const ids = new Set<string>()
    for (const item of data.attempts) {
      if (!item || typeof item.id !== 'string' || !/^req_[A-Za-z0-9_-]{1,124}$/.test(item.id) || ids.has(item.id)
        || !validText(item.text) || typeof item.planMode !== 'boolean' || typeof item.submitted !== 'boolean'
        || typeof item.attachmentsLost !== 'boolean'
        || (item.submitted && (typeof item.sessionID !== 'string' || !item.sessionID || item.sessionID.length > 256))) throw new Error('invalid attempt')
      ids.add(item.id)
    }
    // Reconstruct only the allowlisted shape; ignore all extra or legacy fields.
    return { version: 1, updatedAt: data.updatedAt, text: data.text, planMode: data.planMode, attachmentsLost: data.attachmentsLost,
      attempts: data.attempts.map((item: StoredAttempt) => ({ id: item.id, text: item.text, planMode: item.planMode,
        submitted: item.submitted, sessionID: item.submitted ? item.sessionID : undefined, attachmentsLost: item.attachmentsLost })) }
  } catch { removeStoredDraft(key); return }
}
export function writeStoredDraft(key: string, draft: Omit<StoredDraft, 'version' | 'updatedAt'>): boolean {
  const target = storage()
  if (!target) return false
  if (!draft.text && !draft.attempts.length && !draft.attachmentsLost) { removeStoredDraft(key); return true }
  try {
    const raw = JSON.stringify({ ...draft, version: 1, updatedAt: Date.now() })
    if (raw.length > MAX_RECORD || draft.text.length > MAX_TEXT || draft.attempts.length > 20 || draft.attempts.some(a => a.text.length > MAX_TEXT)) throw new Error('oversize')
    target.setItem(key, raw)
    return true
  } catch {
    // Never leave an older draft looking like the current one after a failed write.
    removeStoredDraft(key)
    return false
  }
}
