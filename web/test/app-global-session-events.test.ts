import { expect, test } from 'bun:test'
import { parse, compileScript } from 'vue/compiler-sfc'
import type { EventStreamOptions, GlobalSSEEventEnvelope } from '../src/api/client'

// Exercise the actual App callback, including its reconnect and lifetime guards.
test('App forwards cross-project status and resynchronizes after every global connection', async () => {
  const { descriptor } = parse(await Bun.file(new URL('../src/App.vue', import.meta.url)).text())
  const compiled = compileScript(descriptor, { id: 'global-status' })
  const node = compiled.scriptSetupAst!.find((node: any) => node.type === 'FunctionDeclaration' && node.id?.name === 'subscribeGlobalEvents')!
  const source = descriptor.scriptSetup!.content.slice(node.start!, node.end!)
  const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  let receive!: (event: GlobalSSEEventEnvelope) => void
  let connection!: EventStreamOptions
  const states: unknown[] = []
  const recoveries: { sessions: unknown; isCurrent: () => boolean }[] = []
  let readiness = 0
  const scope = {
    api: { subscribeGlobalEvents(handler: typeof receive, options: EventStreamOptions) {
      receive = handler; connection = options
      return { close() {} }
    } },
    changesLiveUpdates: { begin() { return { received() {}, disconnected() {}, ready() { readiness++ } } } },
    handleGlobalSessionEvent(event: unknown, directory: string) { states.push({ event, directory }) },
    syncSessionStatus(sessions: unknown, isCurrent: () => boolean) { recoveries.push({ sessions, isCurrent }) },
    sidebarSessions: { value: [{ id: 'A', directory: '/project/A' }] },
  }
  const lifecycle = new Function('scope', `
    const { api, changesLiveUpdates, handleGlobalSessionEvent, syncSessionStatus, sidebarSessions } = scope;
    let globalEventSource = null; let globalEventSubscriptionVersion = 0;
    let authenticatedRuntimeStarted = true; let authenticatedRuntimeGeneration = 1;
    const applySessionTitle = () => {}; const applyRecentSessionTitle = () => {};
    const handleProjectContextUpdated = () => {}; const scheduleProjectsRefresh = () => {};
    ${transpiled}
    subscribeGlobalEvents();
    return { replace: subscribeGlobalEvents, stop() { authenticatedRuntimeStarted = false; authenticatedRuntimeGeneration++; } };
  `)(scope)
  const idle = { type: 'session.idle', properties: { sessionID: 'A' } }
  receive({ directory: '/project/A', payload: idle })
  expect(states).toEqual([{ event: idle, directory: '/project/A' }])
  connection.onOpen?.(1)
  connection.onOpen?.(2)
  expect(readiness).toBe(2)
  expect(recoveries).toHaveLength(2)
  expect(recoveries[0].sessions).toEqual(scope.sidebarSessions.value)
  expect(recoveries[0].isCurrent()).toBe(true)
  const obsolete = { receive, connection }
  lifecycle.replace()
  expect(recoveries[0].isCurrent()).toBe(false)
  obsolete.receive({ directory: '/project/A', payload: idle })
  obsolete.connection.onOpen?.(3)
  expect(states).toHaveLength(1)
  expect(recoveries).toHaveLength(2)
  lifecycle.stop()
  receive({ directory: '/project/A', payload: idle })
  connection.onOpen?.(1)
  expect(states).toHaveLength(1)
  expect(recoveries).toHaveLength(2)
})
