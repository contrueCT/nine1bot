import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import * as Icons from 'lucide-vue-next'
import { compileScript, parse } from 'vue/compiler-sfc'




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
