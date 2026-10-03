import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import * as Icons from 'lucide-vue-next'
import { compileScript, parse } from 'vue/compiler-sfc'
import { api } from '../src/api/client'
import { useSessionSearch } from '../src/composables/useSessionSearch'
import { highlightMatch } from '../src/utils/highlight'
import { useModalFocus } from '../src/composables/useModalFocus'

// Compile and mount the real SFC; only the DOM host and read-only API are synthetic.
async function component() {
  const { descriptor } = parse(await Bun.file(new URL('../src/components/SearchOverlay.vue', import.meta.url)).text())
  const { content } = compileScript(descriptor, { id: 'session-changes', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_full, imports: string, module: string) => {
      const owner = module === 'vue' ? 'Vue' : module === 'lucide-vue-next' ? 'Icons' : 'deps'
      return `const { ${imports.replace(/\bas\b/g, ':')} } = ${owner};`
    }).replace('export default', 'return')
  return new Function('Vue', 'Icons', 'deps', compiled)(Vue, Icons, { useSessionSearch, useModalFocus, highlightMatch })
}
type Host = { getRootNode(): any; addEventListener(name: string, listener: any): void; tagName: string; type: string; text: string; props: Record<string, any>; children: Host[]; parent?: Host; isConnected: boolean; focus(): void; contains(other: Host): boolean; querySelectorAll(): Host[]; querySelector(): undefined; getClientRects(): object[] }
let active: any
const listeners = new Map<string, (event: any) => void>()
function node(type: string, text = ''): Host {
  const value: Host = { type, text, tagName: type.toUpperCase(), addEventListener() {}, getRootNode() { return document }, props: {}, children: [], isConnected: true,
    focus() { active = value }, contains(other) { return descendants(value).includes(other) },
    querySelectorAll() { return descendants(value).filter(item => (item.type === 'button' && !item.props.disabled) || String(item.props.tabindex) === '0' || item.type === 'input') },
    querySelector() { return undefined },
    getClientRects() { return [{}] },
  }
  return Vue.markRaw(value)
}
const renderer = Vue.createRenderer<Host, Host>({
  createElement: type => node(type), createText: value => node('text', value), createComment: value => node('comment', value),
  setText: (item, value) => { item.text = value }, setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
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
const originalGet = api.searchSessions
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
  const Card = await component()
  const root = node('root')
  app = renderer.createApp({ render: () => Vue.h(Card, props()) })
  app.mount(root)
  await settle()
  return root
}
async function settle() { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick() }
afterEach(() => {
  app?.unmount(); app = undefined
  api.searchSessions = originalGet
  listeners.clear()
  if (originalDocumentClass) Object.defineProperty(globalThis, 'Document', originalDocumentClass)
  else delete (globalThis as any).Document
  if (originalShadowRoot) Object.defineProperty(globalThis, 'ShadowRoot', originalShadowRoot)
  else delete (globalThis as any).ShadowRoot
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: unknown }).document
})


const session = { id: 'old-history', title: '<script>session</script>', directory: '/project', time: { created: 1, updated: 1 } }
function input(root: Host) { return descendants(root).find(item => item.type === 'input')! }
async function typeQuery(root: Host, value: string) {
  input(root).props['onUpdate:modelValue'](value)
  await settle()
  await new Promise(resolve => setTimeout(resolve, 230))
  await settle()
}
test('real search renders safe snippets and selects historical results with message navigation metadata', async () => {
  api.searchSessions = async () => ({ results: [{ session: session as any, messageID: 'message-old', snippet: '<img src=x onerror=alert(1)>中文' }], hasMore: true })
  let selected: any
  const root = await mount(() => ({ directory: '/project', recentSessions: [], onSelect: (value: any) => { selected = value } }))
  await typeQuery(root, '中文')
  expect(text(root)).toContain('仅显示前 50 个')
  expect(text(root)).toContain('消息匹配')
  const snippet = descendants(root).find(item => item.props.class === 'result-snippet')!
  expect(snippet.props.innerHTML).toContain('&lt;img')
  expect(snippet.props.innerHTML).not.toContain('<img')
  const modal = descendants(root).find(item => item.props.role === 'dialog')!
  modal.props.onKeydown({ key: 'Enter', target: input(root), preventDefault() {} })
  expect(selected.session.id).toBe('old-history')
  expect(selected.messageID).toBe('message-old')
})
test('real search handles empty results, IME, retry, Escape and focus restoration', async () => {
  let fail = true
  let selected = 0
  let closes = 0
  api.searchSessions = async () => { if (fail) throw new Error('offline'); return { results: [], hasMore: false } }
  const root = await mount(() => ({ directory: '/project', recentSessions: [session], onSelect: () => { selected++ }, onClose: () => { closes++ } }))
  const modal = descendants(root).find(item => item.props.role === 'dialog')!
  modal.props.onKeydown({ key: 'Enter', target: input(root), isComposing: true, preventDefault() {} })
  expect(selected).toBe(0)
  await typeQuery(root, 'term')
  expect(text(root)).toContain('offline')
  expect(text(root)).not.toContain('没有匹配')
  fail = false
  button(root, '重试').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 230)); await settle()
  expect(text(root)).toContain('当前项目中没有匹配')
  modal.props.onKeydown({ key: 'ArrowDown', target: input(root), preventDefault() {} })
  modal.props.onKeydown({ key: 'Enter', target: input(root), preventDefault() {} })
  expect(selected).toBe(0)
  listeners.get('keydown')!({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  expect(closes).toBe(1)
  app!.unmount(); app = undefined
  expect(restoredFocus).toBe(true)
})
