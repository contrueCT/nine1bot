import { afterEach, beforeEach, expect, test } from 'bun:test'
import { beginSend, clearComposerDrafts, getComposerDraft, moveComposerDraft, finishSend } from '../src/composables/composer-drafts'
import { draftStorageKey, readStoredDraft, writeStoredDraft, DRAFT_PREFIX } from '../src/composables/draft-storage'
import { setApiDirectory } from '../src/api/client'
const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size }, key: (i: number) => [...values.keys()][i] || null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } })
  setApiDirectory('/project/A')
})
afterEach(() => {
  clearComposerDrafts()
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
  else delete (globalThis as any).sessionStorage
  setApiDirectory('')
})
test('refresh restores text and plan, separates project/session, clears on logout', () => {
  const draft = getComposerDraft('A'); draft.text = 'private text'; draft.planMode = true
  clearComposerDrafts(undefined, true)
  expect(getComposerDraft('A').text).toBe('private text')
  expect(getComposerDraft('A').planMode).toBe(true)
  setApiDirectory('/project/B')
  expect(getComposerDraft('A').text).toBe('')
  expect(getComposerDraft('B').text).toBe('')
  clearComposerDrafts()
  expect(values.size).toBe(0)
})
test('refresh keeps original request identity but never files, URLs, context, or replay bodies', () => {
  const draft = getComposerDraft('draft:/project/A'); draft.text = 'original'
  draft.uploads.attachments.value.push({ id: 'file', file: new File(['secret'], 'secret.txt'), filename: 'secret.txt', size: 6, mime: 'text/plain', status: 'ready', progress: 100, url: 'file:///private/secret.txt' })
  const attempt = beginSend(draft)
  moveComposerDraft('draft:/project/A', 'A')
  attempt.submission = { sessionID: 'A', request: { requestID: attempt.id, body: 'secret context and file URLs' } }
  attempt.submitted = true
  expect([...values.values()].join('')).not.toContain('secret')
  clearComposerDrafts(undefined, true)
  const restored = getComposerDraft('A')
  expect(JSON.parse(JSON.stringify(restored.attempts[0]))).toMatchObject({ id: attempt.id, submitted: true, recoverySessionID: 'A', status: 'failed', attachments: [] })
  expect(restored.attempts[0]?.submission).toBeUndefined()
  finishSend(restored, restored.attempts[0]!, true)
  expect(values.size).toBe(0)
})
test('corrupt, expired and future-version data are discarded without crashing', () => {
  const key = draftStorageKey('A', '/project/A', 'web')
  for (const raw of ['{broken', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, updatedAt: 0 })]) {
    values.set(key, raw); expect(readStoredDraft(key)).toBeUndefined(); expect(values.has(key)).toBe(false)
  }
})
test('quota failures remove stale persisted text and expose an in-memory warning', () => {
  const draft = getComposerDraft('A'); draft.text = 'old'
  ;(globalThis.sessionStorage as any).setItem = () => { throw new Error('quota') }
  draft.text = 'new'
  expect(draft.text).toBe('new'); expect(draft.storageFailed).toBe(true); expect(values.size).toBe(0)
})
test('deleting a session removes its unloaded persistence without deleting another app key', () => {
  const draft = getComposerDraft('A'); draft.text = 'delete me'
  clearComposerDrafts(undefined, true); values.set('other-app', 'keep')
  clearComposerDrafts('A')
  expect([...values.keys()]).toEqual(['other-app'])
})
test('oversize writes do not retain an obsolete persisted draft', () => {
  const key = DRAFT_PREFIX + 'test'
  const base = { text: 'ok', planMode: false, attachmentsLost: false, attempts: [] }
  expect(writeStoredDraft(key, base)).toBe(true)
  expect(writeStoredDraft(key, { ...base, text: 'x'.repeat(200_001) })).toBe(false)
  expect(values.has(key)).toBe(false)
})

test('new-session migration follows canonical directory and leaves no stale draft key', () => {
  setApiDirectory('/project/A/relative')
  const draft = getComposerDraft('draft:/project/A/relative'); draft.text = 'carry forward'
  setApiDirectory('/elsewhere')
  moveComposerDraft('draft:/project/A/relative', 'A', '/canonical/A', '/project/A/relative')
  setApiDirectory('/canonical/A')
  expect(getComposerDraft('A')).toBe(draft)
  clearComposerDrafts(undefined, true)
  expect(getComposerDraft('A').text).toBe('carry forward')
  expect(values.size).toBe(1)
})

test('persistence survives the component scope that first opened the draft', async () => {
  const { effectScope } = await import('vue')
  const scope = effectScope()
  const draft = scope.run(() => getComposerDraft('A'))!
  draft.text = 'first mount'
  scope.stop()
  draft.text = 'after remount'
  clearComposerDrafts(undefined, true)
  expect(getComposerDraft('A').text).toBe('after remount')
})
