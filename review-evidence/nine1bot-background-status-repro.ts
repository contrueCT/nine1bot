import assert from 'node:assert/strict'
import { useSession } from '../web/src/composables/useSession.ts'
import { parse, compileScript } from '../web/node_modules/vue/compiler-sfc/index.js'
import { useParallelSessions } from '../web/src/composables/useParallelSessions.ts'
const source = await Bun.file(new URL('../web/src/App.vue', import.meta.url)).text()
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'review' })
const node = compiled.scriptSetupAst!.find((node: any) => node.type === 'FunctionDeclaration' && node.id?.name === 'subscribeGlobalEvents')!
const fn = descriptor.scriptSetup!.content.slice(node.start!, node.end!)
const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(fn)
let received: (event: any) => void = () => {}
const noop = () => {}
const api = { subscribeGlobalEvents(handler: (event: any) => void) { received = handler; return { close: noop } } }
const changesLiveUpdates = { begin() { return { received: noop, disconnected: noop, ready: noop } } }
const active = useSession()
new Function('api', 'changesLiveUpdates', 'handleGlobalSessionEvent', `let globalEventSource = null; let globalEventSubscriptionVersion = 0; let authenticatedRuntimeGeneration = 1; let authenticatedRuntimeStarted = true; const sidebarSessions = { value: [] }; const syncSessionStatus = () => {}; const applySessionTitle = () => {}; const applyRecentSessionTitle = () => {}; const handleProjectContextUpdated = () => {}; const scheduleProjectsRefresh = () => {}; ${transpiled}; subscribeGlobalEvents();`)(api, changesLiveUpdates, active.handleGlobalSessionEvent)
const parallel = useParallelSessions()
parallel.setSessionRunning('background-A', true)
received({ directory: '/project-A', payload: { type: 'session.status', properties: { sessionID: 'background-A', status: { type: 'idle' } } } })
received({ directory: '/project-A', payload: { type: 'session.idle', properties: { sessionID: 'background-A' } } })
assert.equal(parallel.isSessionRunning('background-A'), false)
console.log('GLOBAL_IDLE', { stillRunning: parallel.isSessionRunning('background-A'), runningCount: parallel.runningCount.value })
parallel.clearSession('background-A')

active.unsubscribe()
