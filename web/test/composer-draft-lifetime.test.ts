import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireComposerDraft, beginSend, clearComposerDrafts, finishSend, getComposerDraft, moveComposerDraft, restoreAttempt } from '../src/composables/composer-drafts'
import { draftStorageKey } from '../src/composables/draft-storage'
import { computed } from 'vue'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const directory = '/draft-lifetime'
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } })
})
afterEach(() => {
  clearComposerDrafts()
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
  else delete (globalThis as any).sessionStorage
})

test('500 completed conversations release empty draft objects, persistence watchers and view callbacks', async () => {
  const oldDrafts = Array.from({ length: 500 }, (_, index) => {
    const lease = acquireComposerDraft(String(index), async () => 'view-session', directory)
    const draft = lease.draft
    draft.text = 'sent text'
    const attempt = beginSend(draft)
    attempt.onCancel = () => {}
    finishSend(draft, attempt, true)
    expect(attempt.onCancel).toBeUndefined()
    lease.release()
    return draft
  })
  await Promise.resolve()
  expect(values.size).toBe(0)
  for (const [index, old] of oldDrafts.entries()) {
    expect(getComposerDraft(String(index), undefined, directory)).not.toBe(old)
    expect(await old.ensureSession()).toBeNull()
    // A stopped detached watcher cannot overwrite a future draft/storage record.
    old.text = 'stale detached object'
  }
  expect(values.size).toBe(0)
})

test('multiple views hold independent leases and restore the remaining session resolver', async () => {
  const first = acquireComposerDraft('shared', async () => 'first', directory)
  const second = acquireComposerDraft('shared', async () => 'second', directory)
  const draft = first.draft
  expect(second.draft).toBe(draft)
  expect(await draft.ensureSession()).toBe('second')
  second.release()
  second.release()
  await Promise.resolve()
  expect(getComposerDraft('shared', undefined, directory)).toBe(draft)
  expect(await draft.ensureSession()).toBe('first')
  first.release()
  expect(await draft.ensureSession()).toBeNull()
  await Promise.resolve()
  expect(getComposerDraft('shared', undefined, directory)).not.toBe(draft)
})

test('inactive text, plan mode and receipt-only uncertainty reload without retaining their watcher', async () => {
  const lease = acquireComposerDraft('stored', undefined, directory)
  const old = lease.draft
  old.text = 'uncertain request'
  const uncertain = beginSend(old)
  uncertain.submitted = true
  uncertain.recoverySessionID = 'stored'
  finishSend(old, uncertain, false)
  old.text = 'new unfinished text'
  old.planMode = true
  lease.release()
  await Promise.resolve()
  const restored = getComposerDraft('stored', undefined, directory)
  expect(restored).not.toBe(old)
  expect(restored.text).toBe('new unfinished text')
  expect(restored.planMode).toBe(true)
  expect(restored.attempts[0]).toMatchObject({ id: uncertain.id, text: 'uncertain request', submitted: true, recoverySessionID: 'stored', status: 'failed' })
  expect(restoreAttempt(restored, restored.attempts[0]!)).toBe(false)
  old.text = 'stale object edit'
  expect(JSON.parse(values.get(draftStorageKey('stored', directory, 'web'))!).text).toBe('new unfinished text')
})

test('an empty composer retains a selected plan mode through cold storage', async () => {
  const lease = acquireComposerDraft('plan', undefined, directory)
  lease.draft.planMode = true
  const old = lease.draft
  lease.release()
  await Promise.resolve()
  const restored = getComposerDraft('plan', undefined, directory)
  expect(restored).not.toBe(old)
  expect(restored.planMode).toBe(true)
})

test('failed persistence and oversize text retain the entire draft in memory', async () => {
  const lease = acquireComposerDraft('quota', async () => 'view-session', directory)
  const draft = lease.draft
  globalThis.sessionStorage.setItem = () => { throw new Error('quota exceeded') }
  draft.text = 'unsaved text'
  lease.release()
  await Promise.resolve()
  expect(getComposerDraft('quota', undefined, directory)).toBe(draft)
  expect(draft.storageFailed).toBe(true)
  expect(draft.text).toBe('unsaved text')
  expect(await draft.ensureSession()).toBeNull()
  const large = acquireComposerDraft('oversize', undefined, directory)
  const oversized = large.draft
  oversized.text = 'x'.repeat(200_001)
  large.release()
  await Promise.resolve()
  expect(getComposerDraft('oversize', undefined, directory)).toBe(oversized)
  expect(oversized.text.length).toBe(200_001)
})

test('leaving an attachment draft preserves file objects and releases the component callback', async () => {
  const lease = acquireComposerDraft('attachment', async () => 'view-session', directory)
  const draft = lease.draft
  const file = new File(['keep file'], 'keep.txt')
  draft.uploads.attachments.value.push({ id: 'file', file, filename: file.name, size: file.size, mime: 'text/plain', status: 'ready', progress: 100, url: 'file:///keep.txt' })
  lease.release()
  await Promise.resolve()
  expect(getComposerDraft('attachment', undefined, directory)).toBe(draft)
  expect(draft.uploads.attachments.value[0]!.file).toBe(file)
  expect(await draft.ensureSession()).toBeNull()
  const attempt = beginSend(draft)
  attempt.onCancel = () => {}
  finishSend(draft, attempt, false)
  await Promise.resolve()
  expect(attempt.onCancel).toBeUndefined()
  expect(getComposerDraft('attachment', undefined, directory)).toBe(draft)
  expect(restoreAttempt(draft, attempt)).toBe(true)
  expect(draft.uploads.attachments.value[0]!.file).toBe(file)
})

test('a background send pins its draft until completion and then releases the empty object', async () => {
  const lease = acquireComposerDraft('sending', undefined, directory)
  const draft = lease.draft
  draft.text = 'background send'
  const attempt = beginSend(draft)
  lease.release()
  await Promise.resolve()
  expect(getComposerDraft('sending', undefined, directory)).toBe(draft)
  finishSend(draft, attempt, true)
  await Promise.resolve()
  expect(getComposerDraft('sending', undefined, directory)).not.toBe(draft)
})

test('failed attempts with request bodies stay in memory without persisting their private replay body', async () => {
  const lease = acquireComposerDraft('private-request', undefined, directory)
  const draft = lease.draft
  draft.text = 'failed request'
  const attempt = beginSend(draft)
  attempt.submission = { sessionID: 'private-request', request: { requestID: attempt.id, body: 'private page context and replay body' } }
  finishSend(draft, attempt, false)
  lease.release()
  await Promise.resolve()
  expect(getComposerDraft('private-request', undefined, directory)).toBe(draft)
  expect(attempt.submission.request.body).toContain('private page context')
  expect([...values.values()].join('')).not.toContain('private page context')
})

test('an uncertainty without a valid persisted receipt identity cannot be evicted', async () => {
  const lease = acquireComposerDraft('incomplete-recovery', undefined, directory)
  const draft = lease.draft
  draft.text = 'keep uncertain request'
  const attempt = beginSend(draft)
  attempt.submitted = true
  finishSend(draft, attempt, false)
  lease.release()
  await Promise.resolve()
  expect(getComposerDraft('incomplete-recovery', undefined, directory)).toBe(draft)
  expect(draft.storageFailed).toBe(true)
  expect(attempt.text).toBe('keep uncertain request')
})

test('merging drafts transfers view leases, both texts and late completions to the destination', async () => {
  const source = acquireComposerDraft('session', async () => 'source-view', '/old')
  const displayed = computed(() => source.draft)
  const sourceObject = displayed.value
  source.draft.text = 'original request'
  const attempt = beginSend(source.draft)
  source.draft.text = 'unsent source'
  const destination = acquireComposerDraft('session', async () => 'destination-view', '/new')
  destination.draft.text = 'newer destination'
  moveComposerDraft('session', 'session', '/new', '/old')
  expect(source.draft).toBe(destination.draft)
  expect(displayed.value).toBe(destination.draft)
  expect(displayed.value).not.toBe(sourceObject)
  expect(await destination.draft.ensureSession()).toBe('source-view')
  source.release()
  expect(await destination.draft.ensureSession()).toBe('destination-view')
  finishSend(source.draft, attempt, true)
  const old = destination.draft
  destination.release()
  await Promise.resolve()
  const restored = getComposerDraft('session', undefined, '/new')
  expect(restored).not.toBe(old)
  expect(restored.text).toBe('newer destination')
  expect(restored.attempts.map(item => item.text)).toEqual(['unsent source'])
  expect(values.has(draftStorageKey('session', '/old', 'web'))).toBe(false)
})

test('inactive text drafts are bounded in memory while every persisted draft remains recoverable', async () => {
  const drafts = Array.from({ length: 100 }, (_, index) => {
    const draft = getComposerDraft(`cold-${index}`, undefined, directory)
    draft.text = `unfinished ${index}`
    return draft
  })
  await Promise.resolve()
  expect(values.size).toBe(100)
  const restored = getComposerDraft('cold-0', undefined, directory)
  expect(restored).not.toBe(drafts[0])
  expect(restored.text).toBe('unfinished 0')
  expect(getComposerDraft('cold-99', undefined, directory)).toBe(drafts[99])
})

test('merging into a plan-only destination preserves its selected mode and keeps source text recoverable', async () => {
  const source = acquireComposerDraft('session', undefined, '/old')
  source.draft.text = 'source input'
  const destination = acquireComposerDraft('session', undefined, '/new')
  destination.draft.planMode = true
  moveComposerDraft('session', 'session', '/new', '/old')
  expect(destination.draft.text).toBe('')
  expect(destination.draft.planMode).toBe(true)
  expect(destination.draft.attempts).toHaveLength(1)
  expect(destination.draft.attempts[0]).toMatchObject({ text: 'source input', planMode: false, status: 'failed' })
  source.release()
  destination.release()
  await Promise.resolve()
  const restored = getComposerDraft('session', undefined, '/new')
  expect(restored.planMode).toBe(true)
  expect(restored.attempts[0]!.text).toBe('source input')
})
