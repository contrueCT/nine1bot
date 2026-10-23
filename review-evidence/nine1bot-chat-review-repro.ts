import assert from 'node:assert/strict'
import { api, permissionApi, questionApi, SessionBusyError, type SSEEvent } from '../web/src/api/client.ts'
import { useSession } from '../web/src/composables/useSession.ts'
import { useParallelSessions } from '../web/src/composables/useParallelSessions.ts'
import { beginSend, finishSend, getComposerDraft, restoreAttempt } from '../web/src/composables/composer-drafts.ts'
const selected = { id: 'review-A', title: 'review-A', directory: '/review/A', time: { created: 1, updated: 1 } }
let receive: (event: SSEEvent) => void = () => {}
api.subscribeSessionRuntimeEvents = (_id, handler) => { receive = handler; return { ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 } }
api.getMessages = async () => []
api.getSessionStatus = async () => ({})
api.getSessions = async () => []
permissionApi.list = async () => []
questionApi.list = async () => []
const active = useSession()
await active.selectSession(selected)
const draft = getComposerDraft(selected.id, undefined, selected.directory)
draft.text = 'Please do this important work'
const attempt = beginSend(draft)
let posts = 0
api.sendMessage = async () => { posts++; throw new SessionBusyError(selected.id) }
api.getMessageReceipt = async (sessionID, requestID) => ({ state: 'unknown', sessionID, requestID })
finishSend(draft, attempt, await active.sendMessage(attempt.text, undefined, undefined, attempt))
const retried = await active.sendMessage(attempt.text, undefined, undefined, attempt)
const editable = restoreAttempt(draft, attempt)
assert.equal(attempt.submitted, false)
assert.equal(posts, 2)
assert.equal(editable, true)
console.log('BUSY_RETRY_EDIT', JSON.stringify({ status: attempt.status, submitted: attempt.submitted, retried, posts, editable, retainedAttempts: draft.attempts.length }))

let resolveList!: (value: any[]) => void
const pending = new Promise<any[]>(resolve => resolveList = resolve)
questionApi.list = () => pending
const question = { id: 'review-question', sessionID: selected.id, questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'Yes', description: 'Proceed' }] }] }
active.pendingQuestions.value = [question]
const loading = active.loadPendingRequests()
receive({ type: 'question.replied', properties: { sessionID: selected.id, requestID: question.id } })
console.log('QUESTION_AFTER_REPLY', active.pendingQuestions.value.length)
resolveList([question])
await loading
assert.equal(active.pendingQuestions.value.length, 0)
console.log('QUESTION_AFTER_STALE_LIST', active.pendingQuestions.value.map(item => item.id))

active.messages.value = [{ info: { id: 'review-message', sessionID: selected.id, role: 'user', time: { created: 1 } }, parts: [{ id: 'part-one', type: 'text', text: 'keep' }, { id: 'part-two', type: 'text', text: 'remove' }] }]
receive({ type: 'message.part.removed', properties: { sessionID: selected.id, messageID: 'review-message', partID: 'part-two' } })
assert.equal(JSON.stringify(active.messages.value[0].parts.map(part => part.id)), '["part-one"]')
console.log('PARTS_AFTER_REMOVE_EVENT', active.messages.value[0].parts.map(part => part.id))
active.unsubscribe()
useParallelSessions().clearSession(selected.id)
