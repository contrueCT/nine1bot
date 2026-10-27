import { afterEach, beforeEach, expect, test } from 'bun:test'
import { api, permissionApi, questionApi, type PermissionRequest, type QuestionRequest, type SSEEvent } from '../src/api/client'
import { useSession } from '../src/composables/useSession'
import { useParallelSessions } from '../src/composables/useParallelSessions'
import { MAX_RECOVERY_BUFFER_EVENTS } from '../src/composables/sessionEventReconciler'

const originals = [api, permissionApi, questionApi].map(object => [object, { ...object }] as const)
const originalFrame = globalThis.requestAnimationFrame
const originalCancelFrame = globalThis.cancelAnimationFrame
let active: ReturnType<typeof useSession>
let receive: (event: SSEEvent) => void
const selected = { id: 'live-state-A', title: 'A', directory: '/live-state/A', time: { created: 1, updated: 1 } }
const question: QuestionRequest = { id: 'live-question', sessionID: selected.id, questions: [{ question: 'Continue?', header: 'Continue', options: [{ label: 'yes', description: 'Continue' }] }] }
const permission: PermissionRequest = { id: 'live-permission', sessionID: selected.id, permission: 'edit', patterns: ['*'], metadata: {}, always: [] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(async () => {
  api.subscribeSessionRuntimeEvents = (_id, handler) => {
    receive = handler
    return { ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 }
  }
  api.getMessages = async () => []
  api.getSessionStatus = async () => ({})
  questionApi.list = async () => []
  permissionApi.list = async () => []
  active = useSession()
  await active.selectSession(selected)
})
afterEach(() => {
  active.unsubscribe()
  useParallelSessions().clearSession(selected.id)
  for (const [object, methods] of originals) Object.assign(object, methods)
  globalThis.requestAnimationFrame = originalFrame
  globalThis.cancelAnimationFrame = originalCancelFrame
})

test('late interaction lists cannot resurrect answered questions or erase new permissions', async () => {
  active.pendingQuestions.value = [question]
  const staleQuestions = deferred<QuestionRequest[]>()
  questionApi.list = () => staleQuestions.promise
  const loading = active.loadPendingRequests()
  receive({ type: 'question.replied', properties: { sessionID: selected.id, requestID: question.id } })
  receive({ type: 'permission.asked', properties: permission })
  staleQuestions.resolve([question])
  await loading
  expect(active.pendingQuestions.value).toEqual([])
  expect(active.pendingPermissions.value.map(item => item.id)).toEqual([permission.id])
})

test('a delayed list supplies independent old interactions while retaining newly asked IDs', async () => {
  const oldQuestions = deferred<QuestionRequest[]>()
  const oldPermissions = deferred<PermissionRequest[]>()
  questionApi.list = () => oldQuestions.promise
  permissionApi.list = () => oldPermissions.promise
  const loading = active.loadPendingRequests()
  const newQuestion = { ...question, id: 'new-question' }
  const newPermission = { ...permission, id: 'new-permission' }
  receive({ type: 'question.asked', properties: newQuestion })
  receive({ type: 'permission.asked', properties: newPermission })
  oldQuestions.resolve([question])
  oldPermissions.resolve([permission])
  await loading
  expect(active.pendingQuestions.value.map(item => item.id)).toEqual([question.id, newQuestion.id])
  expect(active.pendingPermissions.value.map(item => item.id)).toEqual([permission.id, newPermission.id])
})

test('successful local answers invalidate an older list even without an SSE reply', async () => {
  active.pendingQuestions.value = [question]
  active.pendingPermissions.value = [permission]
  const staleQuestions = deferred<QuestionRequest[]>()
  const stalePermissions = deferred<PermissionRequest[]>()
  questionApi.list = () => staleQuestions.promise
  permissionApi.list = () => stalePermissions.promise
  questionApi.reply = async () => true
  permissionApi.reply = async () => true
  const loading = active.loadPendingRequests()
  expect(await active.answerQuestion(question.id, [['yes']])).toBe(true)
  expect(await active.respondPermission(permission.id, 'once')).toBe(true)
  staleQuestions.resolve([question])
  stalePermissions.resolve([permission])
  await loading
  expect(active.pendingQuestions.value).toEqual([])
  expect(active.pendingPermissions.value).toEqual([])
})

test('runtime recovery also preserves successful local answers without requiring a reply event', async () => {
  active.pendingQuestions.value = [question]
  const history = deferred<never[]>()
  const started = deferred<void>()
  api.getMessages = () => { started.resolve(); return history.promise }
  questionApi.list = async () => [question]
  questionApi.reply = async () => true
  const recovering = active.retryHistory()
  await started.promise
  expect(await active.answerQuestion(question.id, [['yes']])).toBe(true)
  history.resolve([])
  await recovering
  expect(active.pendingQuestions.value).toEqual([])
})

for (const firstResponse of ['older', 'newer'] as const) test(`the newest interaction-list request wins when ${firstResponse} returns first`, async () => {
  const older = deferred<QuestionRequest[]>()
  const newer = deferred<QuestionRequest[]>()
  let calls = 0
  questionApi.list = () => ++calls === 1 ? older.promise : newer.promise
  const oldLoad = active.loadPendingRequests()
  const newLoad = active.loadPendingRequests()
  const fresh = { ...question, id: 'new-question' }
  if (firstResponse === 'older') {
    older.resolve([question]); await oldLoad
    expect(active.pendingQuestions.value).toEqual([])
    newer.resolve([fresh]); await newLoad
  } else {
    newer.resolve([fresh]); await newLoad
    older.resolve([question]); await oldLoad
  }
  expect(active.pendingQuestions.value.map(item => item.id)).toEqual(['new-question'])
})

for (const firstResponse of ['recovery', 'list'] as const) test(`list and runtime recovery honor read order when ${firstResponse} returns first`, async () => {
  const oldQuestions = deferred<QuestionRequest[]>()
  const newQuestions = deferred<QuestionRequest[]>()
  const started = deferred<void>()
  let calls = 0
  questionApi.list = () => {
    if (++calls === 1) { started.resolve(); return oldQuestions.promise }
    return newQuestions.promise
  }
  const recovering = active.retryHistory()
  await started.promise
  const listing = active.loadPendingRequests()
  const fresh = { ...question, id: 'fresh-from-list' }
  if (firstResponse === 'recovery') {
    oldQuestions.resolve([question]); await recovering
    newQuestions.resolve([fresh]); await listing
  } else {
    newQuestions.resolve([fresh]); await listing
    oldQuestions.resolve([question]); await recovering
  }
  expect(active.pendingQuestions.value.map(item => item.id)).toEqual([fresh.id])
})

test('overflow retry starts a newer interaction read than a list completed during the discarded recovery', async () => {
  const history = deferred<never[]>()
  const started = deferred<void>()
  let historyReads = 0
  let questionReads = 0
  let staleSignal: AbortSignal | undefined
  api.getMessages = (_id, signal) => {
    if (++historyReads === 1) {
      staleSignal = signal
      started.resolve()
      return history.promise
    }
    return Promise.resolve([])
  }
  const middle = { ...question, id: 'list-during-recovery' }
  const fresh = { ...question, id: 'fresh-retry' }
  questionApi.list = async () => [[question], [middle], [fresh]][questionReads++] ?? []
  const recovering = active.retryHistory()
  await started.promise
  await active.loadPendingRequests()
  expect(active.pendingQuestions.value.map(item => item.id)).toEqual([middle.id])
  for (let index = 0; index <= MAX_RECOVERY_BUFFER_EVENTS; index++) {
    receive({ type: 'session.status', properties: { sessionID: selected.id, status: { type: 'busy' } } })
  }
  expect(await recovering).toBe(true)
  expect(staleSignal?.aborted).toBe(true)
  expect(historyReads).toBe(2)
  expect(active.pendingQuestions.value.map(item => item.id)).toEqual([fresh.id])
  history.resolve([])
  await Promise.resolve()
  expect(active.pendingQuestions.value.map(item => item.id)).toEqual([fresh.id])
})

test('a part removal updates the other client and discards queued text for that part', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  active.messages.value = [{ info: { id: 'live-message', sessionID: selected.id, role: 'user', time: { created: 1 } }, parts: [
    { id: 'keep', type: 'text', text: 'keep' },
    { id: 'remove', type: 'text', text: 'remove' },
  ] }]
  receive({ type: 'message.part.delta', properties: { sessionID: selected.id, messageID: 'live-message', partID: 'remove', field: 'text', delta: ' queued' } })
  receive({ type: 'message.part.removed', properties: { sessionID: selected.id, messageID: 'live-message', partID: 'remove' } })
  for (const frame of frames.values()) frame(0)
  expect(active.messages.value[0].parts.map(part => part.id)).toEqual(['keep'])
  // A duplicate or unrelated notification must leave the retained part alone.
  receive({ type: 'message.part.removed', properties: { sessionID: 'other', messageID: 'live-message', partID: 'keep' } })
  expect(active.messages.value[0].parts.map(part => part.id)).toEqual(['keep'])
})

test('global status updates background projects without overwriting current runtime status', () => {
  const parallel = useParallelSessions()
  parallel.setSessionRunning(selected.id, true)
  parallel.setSessionRunning('background-live', true)
  active.handleGlobalSessionEvent({ type: 'session.idle', properties: { sessionID: 'background-live' } }, '/background')
  active.handleGlobalSessionEvent({ type: 'session.idle', properties: { sessionID: selected.id } }, selected.directory)
  expect(parallel.isSessionRunning('background-live')).toBe(false)
  expect(active.isStreaming.value).toBe(true)
  parallel.clearSession('background-live')
})

test('compression skips known busy sessions and exposes a server-side rejection after a race', async () => {
  active.messages.value = [{ info: { id: 'summary-assistant', sessionID: selected.id, role: 'assistant', model: { providerID: 'test', modelID: 'test' }, time: { created: 1 } }, parts: [] }]
  let compressions = 0
  api.summarizeSession = async () => { compressions++; throw new Error('Session became busy') }
  const parallel = useParallelSessions()
  parallel.setSessionRunning(selected.id, true)
  await active.summarizeSession()
  expect(compressions).toBe(0)
  parallel.setSessionRunning(selected.id, false)
  const originalError = console.error
  console.error = () => {}
  try { await expect(active.summarizeSession()).rejects.toThrow('Session became busy') }
  finally { console.error = originalError }
  expect(compressions).toBe(1)
  expect(active.isSummarizing.value).toBe(false)
  expect(active.sessionNotifications.value.at(-1)?.message).toContain('Session became busy')
})
