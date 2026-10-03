import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import * as Icons from 'lucide-vue-next'
import { compileScript, parse } from 'vue/compiler-sfc'
import { api, permissionApi, questionApi, setApiDirectory, type Message, type Session, type SessionSearchResult } from '../src/api/client'
import { useSession } from '../src/composables/useSession'




// Compile and mount the real SFC; only the DOM host and read-only API are synthetic.
async function component() {
  const { descriptor } = parse(await Bun.file(new URL('../src/components/ChatPanel.vue', import.meta.url)).text())
  const { content } = compileScript(descriptor, { id: 'session-changes', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_full, imports: string, module: string) => {
      const owner = module === 'vue' ? 'Vue' : module === 'lucide-vue-next' ? 'Icons' : 'deps'
      return `const { ${imports.replace(/\bas\b/g, ':')} } = ${owner};`
    }).replace(/import\s+\w+\s+from\s*['"][^'"]+['"];?/g, full => `const ${full.split(/\s+/)[1]} = stub;`).replace('export default', 'return')
  const stub = { props: ['message', 'messages', 'searchMessageId'], render(this: any) { return Vue.h('div', { 'data-search-message': this.message?.info.id || this.searchMessageId, tabindex: -1 }, 'message') } }
  return new Function('Vue', 'Icons', 'deps', 'stub', compiled)(Vue, Icons, {
    readChatViewport: () => undefined, saveChatViewport() {},
    isAtBottom: () => false, isTypingTarget: () => false, nextFollowing: () => false, UP_KEYS: [],
    splitPath: () => ({ parent: '', name: '' }), tildify: (value: string) => value, useWorkspacePath: () => Vue.ref(''),
  }, stub)
}
type Host = { dataset: any; scrollIntoView(): void; getRootNode(): any; addEventListener(name: string, listener: any): void; tagName: string; type: string; text: string; props: Record<string, any>; children: Host[]; parent?: Host; isConnected: boolean; focus(): void; contains(other: Host): boolean; querySelectorAll(): Host[]; querySelector(): undefined; getClientRects(): object[] }
let active: any
const listeners = new Map<string, (event: any) => void>()
function node(type: string, text = ''): Host {
  const value: Host = { type, text, dataset: {}, scrollIntoView() { scrolled = value }, tagName: type.toUpperCase(), addEventListener() {}, getRootNode() { return document }, props: {}, children: [], isConnected: true,
    focus() { active = value }, contains(other) { return descendants(value).includes(other) },
    querySelectorAll(selector?: string) { if (selector === '[data-search-message]') return descendants(value).filter(item => item.props['data-search-message']); return descendants(value).filter(item => (item.type === 'button' && !item.props.disabled) || String(item.props.tabindex) === '0' || item.type === 'input') },
    querySelector() { return undefined },
    getClientRects() { return [{}] },
  }
  return Vue.markRaw(value)
}
const renderer = Vue.createRenderer<Host, Host>({
  createElement: type => node(type), createText: value => node('text', value), createComment: value => node('comment', value),
  setText: (item, value) => { item.text = value }, setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value; if (key === 'data-search-message') item.dataset.searchMessage = value },
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child)
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child)
  },
  remove(child) { child.isConnected = false; if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
  parentNode: item => item.parent || null,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
})
function descendants(root: Host): Host[] { return [root, ...root.children.flatMap(descendants)] }
function text(root: Host): string { return root.type === 'comment' ? '' : root.text + root.children.map(text).join('') }
function button(root: Host, label: string) {
  const value = descendants(root).find(item => item.type === 'button' && (text(item).includes(label) || item.props['aria-label'] === label))
  if (!value) throw new Error(`Missing button ${label}: ${text(root)}`)
  return Vue.markRaw(value)
}
let scrolled: Host | undefined
let exposed: any
const environment = ['window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
const originalDocumentClass = Object.getOwnPropertyDescriptor(globalThis, 'Document')
const originalShadowRoot = Object.getOwnPropertyDescriptor(globalThis, 'ShadowRoot')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
let app: ReturnType<typeof renderer.createApp> | undefined
let restoredFocus = false
async function mount(props: () => any) {
  scrolled = undefined
  Object.defineProperty(globalThis, 'Document', { configurable: true, value: class Document {} })
  Object.defineProperty(globalThis, 'ShadowRoot', { configurable: true, value: class ShadowRoot {} })
  restoredFocus = false
  active = { isConnected: true, focus() { restoredFocus = true } }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    get activeElement() { return active },
    addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener) },
    removeEventListener(name: string) { listeners.delete(name) },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  globalThis.requestAnimationFrame = ((fn: any) => setTimeout(fn, 0)) as any
  globalThis.cancelAnimationFrame = clearTimeout as any
  const Card = await component()
  const root = node('root')
  app = renderer.createApp({ render: () => Vue.h(Card, { ...props(), ref: (value: any) => { exposed = value } }) })
  app.mount(root)
  await settle()
  return root
}
async function settle() { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick() }
afterEach(() => {
  app?.unmount(); app = undefined
  sessionModel?.unsubscribe(); sessionModel = undefined
  Object.assign(api, originalApi)
  questionApi.list = originalQuestionList
  permissionApi.list = originalPermissionList
  setApiDirectory('')
  listeners.clear()
  for (const [key, descriptor] of environment) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
  if (originalDocumentClass) Object.defineProperty(globalThis, 'Document', originalDocumentClass)
  else delete (globalThis as any).Document
  if (originalShadowRoot) Object.defineProperty(globalThis, 'ShadowRoot', originalShadowRoot)
  else delete (globalThis as any).ShadowRoot
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: unknown }).document
})



function message(id: string, role = 'user') { return { info: { id, role, time: { created: 1 } }, parts: [{ id: `part-${id}`, messageID: id, type: 'text', text: id }] } }
test('real chat reveal renders an older message beyond the 40-group window and focuses it', async () => {
  const messages = Array.from({ length: 100 }, (_, i) => message(`message-${i}`))
  const root = await mount(() => ({ sessionId: 'session-one', messages, isLoading: false, isStreaming: false }))
  expect(descendants(root).some(node => node.dataset.searchMessage === 'message-0')).toBe(false)
  expect(await exposed.revealMessage('message-0')).toBe(true)
  expect(scrolled?.dataset.searchMessage).toBe('message-0')
  expect(active).toBe(scrolled)
  expect(await exposed.revealMessage('missing')).toBe(false)
})
test('real chat reveal aborts after session switch instead of jumping to another session', async () => {
  const session = Vue.ref('session-one')
  const root = await mount(() => ({ sessionId: session.value, messages: [message('shared-id')], isLoading: false, isStreaming: false }))
  const revealing = exposed.revealMessage('shared-id')
  session.value = 'session-two'
  await settle()
  expect(await revealing).toBe(false)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const originalApi = {
  getMessages: api.getMessages,
  getMessageReceipt: api.getMessageReceipt,
  sendMessage: api.sendMessage,
  getSessionStatus: api.getSessionStatus,
  subscribeSessionRuntimeEvents: api.subscribeSessionRuntimeEvents,
}
const originalQuestionList = questionApi.list
const originalPermissionList = permissionApi.list
let sessionModel: ReturnType<typeof useSession> | undefined
function createSessionModel() {
  api.getMessages = async () => [message('older'), message('newer')] as Message[]
  api.getSessionStatus = async () => ({})
  questionApi.list = async () => []
  permissionApi.list = async () => []
  api.subscribeSessionRuntimeEvents = () => ({ ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 })
  return sessionModel = useSession()
}
function session(id: string): Session {
  return { id, title: id, directory: '/project', time: { created: 1, updated: 1 } }
}
function result(session: Session, messageID = 'older'): SessionSearchResult {
  return { session, messageID, snippet: messageID }
}

let searchHandlerFactory: ((scope: any) => (result: SessionSearchResult) => Promise<void>) | undefined
async function searchHandler(model: ReturnType<typeof useSession>, options: {
  nextTick?: () => Promise<unknown>
  revealMessage?: (messageID: string, isOwner: () => boolean) => Promise<boolean>
} = {}) {
  if (!searchHandlerFactory) {
    // Execute App's actual handler, rather than a copied navigation implementation.
    // The real session composable and mounted ChatPanel own the async boundaries.
    const { descriptor } = parse(await Bun.file(new URL('../src/App.vue', import.meta.url)).text())
    const compiled = compileScript(descriptor, { id: 'search-navigation' })
    const handler = compiled.scriptSetupAst!.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'handleSearchSelect')!
    const source = descriptor.scriptSetup!.content.slice(handler.start!, handler.end!)
    searchHandlerFactory = new Function('scope', `
      const { sidebarMobileOpen, showSearch, showProjectsPage, showMetricsPage, showAutomationsPage,
        searchNavigationNotice, selectSession, viewOwner, currentSession, historyError, nextTick, searchChatPanel } = scope;
      ${new Bun.Transpiler({ loader: 'ts' }).transformSync(source)}
      return handleSearchSelect;
    `) as typeof searchHandlerFactory
  }
  const revealStarted = deferred<void>()
  const scope = {
    ...model,
    sidebarMobileOpen: Vue.ref(true),
    showSearch: Vue.ref(true),
    showProjectsPage: Vue.ref(true),
    showMetricsPage: Vue.ref(true),
    showAutomationsPage: Vue.ref(true),
    searchNavigationNotice: Vue.ref(''),
    nextTick: options.nextTick ?? Vue.nextTick,
    searchChatPanel: { value: { revealMessage(messageID: string, isOwner: () => boolean) {
      revealStarted.resolve()
      return options.revealMessage ? options.revealMessage(messageID, isOwner) : exposed.revealMessage(messageID, isOwner)
    } } },
  }
  return { select: searchHandlerFactory!(scope), notice: scope.searchNavigationNotice, revealStarted: revealStarted.promise }
}
async function mountSession(model: ReturnType<typeof useSession>) {
  return mount(() => ({
    sessionId: model.currentSession.value?.id,
    messages: model.messages.value,
    isLoading: model.isLoading.value,
    isStreaming: false,
  }))
}

test('App ignores an older history completion after a newer search selects another message in the same session', async () => {
  const model = createSessionModel()
  await mountSession(model)
  const handler = await searchHandler(model)
  const selected = session('same-session')
  const oldMessages = deferred<Message[]>()
  const oldLoadStarted = deferred<void>()
  let loads = 0
  api.getMessages = async () => {
    if (++loads === 1) { oldLoadStarted.resolve(); return oldMessages.promise }
    return [message('older'), message('newer')] as Message[]
  }
  const older = handler.select(result(selected))
  await oldLoadStarted.promise
  await handler.select(result(selected, 'newer'))
  expect(scrolled?.dataset.searchMessage).toBe('newer')
  const newerFocus = active
  oldMessages.resolve([message('older')] as Message[])
  await older
  expect(scrolled?.dataset.searchMessage).toBe('newer')
  expect(active === newerFocus).toBe(true)
  expect(handler.notice.value).toBe('')
})

test('App rechecks ownership after nextTick before revealing an older same-session result', async () => {
  const model = createSessionModel()
  await mountSession(model)
  const tickEntered = deferred<void>()
  const tickRelease = deferred<void>()
  let ticks = 0
  const handler = await searchHandler(model, { nextTick: async () => {
    if (++ticks === 1) { tickEntered.resolve(); await tickRelease.promise }
    await Vue.nextTick()
  } })
  const selected = session('same-session')
  const older = handler.select(result(selected))
  await tickEntered.promise
  await handler.select(result(selected, 'newer'))
  const newerFocus = active
  tickRelease.resolve()
  await older
  expect(scrolled?.dataset.searchMessage).toBe('newer')
  expect(active === newerFocus).toBe(true)
  expect(handler.notice.value).toBe('')
})

test('ChatPanel cancels the delayed reveal while a newer same-session search is still loading', async () => {
  const model = createSessionModel()
  await mountSession(model)
  const handler = await searchHandler(model)
  const selected = session('same-session')
  const older = handler.select(result(selected))
  await handler.revealStarted
  await settle()
  const originalFocus = active
  const newerMessages = deferred<Message[]>()
  api.getMessages = async () => newerMessages.promise
  const newer = handler.select(result(selected, 'newer'))
  await older
  expect(model.isLoading.value).toBe(true)
  expect(scrolled?.dataset.searchMessage).toBeUndefined()
  expect(active === originalFocus).toBe(true)
  expect(handler.notice.value).toBe('')
  newerMessages.resolve([message('older'), message('newer')] as Message[])
  await newer
  expect(scrolled?.dataset.searchMessage).toBe('newer')
})

test.each(['same-session', 'A-to-B-to-A', 'new-draft'])('ordinary %s navigation cancels a search during ChatPanel’s animation wait', async navigation => {
  const model = createSessionModel()
  await mountSession(model)
  const handler = await searchHandler(model)
  const selected = session('A')
  const older = handler.select(result(selected))
  await handler.revealStarted
  await settle()
  const originalFocus = active
  if (navigation === 'new-draft') {
    model.createSession('/project')
  } else if (navigation === 'A-to-B-to-A') {
    // Vue may batch away B, so a session-ID watcher alone cannot cancel this.
    const toB = model.selectSession(session('B'))
    const backToA = model.selectSession(selected)
    await Promise.all([toB, backToA])
  } else {
    await model.selectSession(selected)
  }
  await older
  expect(scrolled?.dataset.searchMessage).toBeUndefined()
  expect(active === originalFocus).toBe(true)
  expect(handler.notice.value).toBe('')
})

test('App does not publish a stale failed-reveal notice after ordinary same-session navigation', async () => {
  const model = createSessionModel()
  const failedReveal = deferred<boolean>()
  const handler = await searchHandler(model, { revealMessage: () => failedReveal.promise })
  const selected = session('same-session')
  const older = handler.select(result(selected))
  await handler.revealStarted
  await model.selectSession(selected)
  failedReveal.resolve(false)
  await older
  expect(handler.notice.value).toBe('')
})

test('App still reports an unavailable message when the search owns the view', async () => {
  const model = createSessionModel()
  await mountSession(model)
  const handler = await searchHandler(model)
  await handler.select(result(session('same-session'), 'deleted-message'))
  expect(handler.notice.value).toBe('已打开会话，但匹配消息可能已更改或删除，未能定位')
  expect(scrolled?.dataset.searchMessage).toBeUndefined()
})


for (const timing of ['before-ready', 'during-history'] as const) test(`accepted receipt recovery joins search selection ${timing} without invalidating its snapshot`, async () => {
  const model = createSessionModel()
  await mountSession(model)
  const handler = await searchHandler(model)
  const ready = deferred<void>()
  const loaded = deferred<Message[]>()
  const historyStarted = deferred<void>()
  let reads = 0, posts = 0
  api.subscribeSessionRuntimeEvents = () => ({ ready: ready.promise, close() {}, connectionGeneration: () => 1 })
  api.getMessages = async () => { reads++; historyStarted.resolve(); return loaded.promise }
  api.getMessageReceipt = async (sessionID, requestID) => ({ sessionID, requestID, state: 'accepted', messageID: 'msg_original' })
  api.sendMessage = async () => { posts++; throw new Error('unexpected POST') }
  const selecting = handler.select(result(session('receipt-selection'), 'older'))
  await Vue.nextTick()
  if (timing === 'during-history') { ready.resolve(); await historyStarted.promise }
  const recovering = model.sendMessage('original', undefined, undefined, { id: 'req_selection', submitted: true, recoverySessionID: 'receipt-selection' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(reads).toBe(timing === 'before-ready' ? 0 : 1)
  expect(model.isLoading.value).toBe(true)
  if (timing === 'before-ready') ready.resolve()
  await historyStarted.promise
  expect(reads).toBe(1)
  loaded.resolve([message('older')] as Message[])
  await selecting
  expect(await recovering).toBe(true)
  expect(model.messages.value.map(item => item.info.id)).toEqual(['older'])
  expect(model.connectionState.value).toBe('connected')
  expect(handler.notice.value).toBe('')
  expect(scrolled?.dataset.searchMessage).toBe('older')
  expect(posts).toBe(0)
})
