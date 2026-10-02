import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import * as Icons from 'lucide-vue-next'
import { compileScript, parse } from 'vue/compiler-sfc'
import { api } from '../src/api/client'
import { useSessionChanges } from '../src/composables/useSessionChanges'
import { useModalFocus } from '../src/composables/useModalFocus'

// Compile and mount the real SFC; only the DOM host and read-only API are synthetic.
async function component() {
  const { descriptor } = parse(await Bun.file(new URL('../src/components/SessionChangesPanel.vue', import.meta.url)).text())
  const { content } = compileScript(descriptor, { id: 'session-changes', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_full, imports: string, module: string) => {
      const owner = module === 'vue' ? 'Vue' : module === 'lucide-vue-next' ? 'Icons' : 'deps'
      return `const { ${imports.replace(/\bas\b/g, ':')} } = ${owner};`
    }).replace('export default', 'return')
  return new Function('Vue', 'Icons', 'deps', compiled)(Vue, Icons, { useSessionChanges, useModalFocus })
}
type Host = { type: string; text: string; props: Record<string, any>; children: Host[]; parent?: Host; isConnected: boolean; focus(): void; contains(other: Host): boolean; querySelectorAll(): Host[]; getClientRects(): object[] }
let active: any
const listeners = new Map<string, (event: any) => void>()
function node(type: string, text = ''): Host {
  const value: Host = { type, text, props: {}, children: [], isConnected: true,
    focus() { active = value }, contains(other) { return descendants(value).includes(other) },
    querySelectorAll() { return descendants(value).filter(item => item.type === 'button' && !item.props.disabled) },
    getClientRects() { return [{}] },
  }
  return value
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
  return value
}
const originalGet = api.getSessionChanges
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
let app: ReturnType<typeof renderer.createApp> | undefined
let restoredFocus = false
async function mount(props: () => any) {
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
  api.getSessionChanges = originalGet
  listeners.clear()
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: unknown }).document
})

test('real panel expands escaped before/after text and closes with Escape, restoring focus', async () => {
  const untrusted = '<script>alert("example")</script>'
  api.getSessionChanges = async () => [{ file: 'src/a.ts', before: 'old', after: untrusted, additions: 1, deletions: 1 }]
  let closes = 0
  const root = await mount(() => ({ sessionId: 'A', directory: '/A', isStreaming: false, onClose: () => { closes++ } }))
  expect(text(root)).toContain('1 个文件')
  expect(text(root)).not.toContain(untrusted)
  button(root, 'src/a.ts').props.onClick(); await settle()
  expect(text(root)).toContain(untrusted)
  expect(descendants(root).some(item => item.type === 'script')).toBe(false)
  expect(descendants(root).some(item => item.props.innerHTML !== undefined)).toBe(false)
  listeners.get('keydown')!({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  expect(closes).toBe(1)
  app!.unmount(); app = undefined
  expect(restoredFocus).toBe(true)
})

test('real panel preserves a failed snapshot and supports retry and session switch', async () => {
  let fail = false
  api.getSessionChanges = async id => { if (fail) throw new Error('offline'); return [{ file: `${id}.ts`, before: '', after: 'new', additions: 1, deletions: 0 }] }
  const id = Vue.ref('A')
  const root = await mount(() => ({ sessionId: id.value, directory: '/'+id.value, isStreaming: false }))
  fail = true
  await button(root, '刷新文件变更').props.onClick(); await settle()
  expect(text(root)).toContain('offline')
  expect(text(root)).toContain('上次成功读取的快照')
  expect(text(root)).toContain('A.ts')
  fail = false
  await button(root, '重试').props.onClick(); await settle()
  expect(text(root)).not.toContain('offline')
  id.value = 'B'; await settle()
  expect(text(root)).toContain('B.ts')
  expect(text(root)).not.toContain('A.ts')
})

test('real panel refreshes once after execution ends and bounds rendered file content', async () => {
  let calls = 0
  api.getSessionChanges = async () => { calls++; return [{ file: 'large.txt', before: '', after: 'x'.repeat(100_100), additions: 1, deletions: 0 }] }
  const running = Vue.ref(true)
  const root = await mount(() => ({ sessionId: 'A', directory: '/A', isStreaming: running.value }))
  expect(text(root)).toContain('任务仍在运行')
  button(root, 'large.txt').props.onClick(); await settle()
  expect(text(root)).toContain('仅显示前 100000 个字符')
  expect(descendants(root).filter(item => item.type === 'pre').at(-1)?.text.length).toBe(100_000)
  running.value = false; await settle()
  expect(calls).toBe(2)
  expect(text(root)).not.toContain('任务仍在运行')
})


test('a binary or empty-file snapshot is not presented as verified empty contents', async () => {
  api.getSessionChanges = async () => [{ file: 'image.png', before: '', after: '', additions: 0, deletions: 0 }]
  const root = await mount(() => ({ sessionId: 'A', directory: '/A', isStreaming: false }))
  button(root, 'image.png').props.onClick(); await settle()
  expect(text(root)).toContain('此快照未提供文本差异')
  expect(descendants(root).some(item => item.type === 'pre')).toBe(false)
})

test('diff publication after idle replaces an early empty snapshot without losing expansion', async () => {
  let published = false
  api.getSessionChanges = async () => published ? [{ file: 'late.ts', before: '', after: 'persisted', additions: 1, deletions: 0 }] : []
  const running = Vue.ref(true)
  const revision = Vue.ref(0)
  const root = await mount(() => ({ sessionId: 'A', directory: '/A', isStreaming: running.value, revision: revision.value }))
  running.value = false; await settle()
  expect(text(root)).toContain('尚无已记录的文件变更')
  published = true
  revision.value++; await settle()
  expect(text(root)).toContain('late.ts')
  button(root, 'late.ts').props.onClick(); await settle()
  revision.value++; await settle()
  expect(text(root)).toContain('persisted')
})

test('the dialog host uses a viewport overlay outside clipped application columns', async () => {
  const source = await Bun.file(new URL('../src/App.vue', import.meta.url)).text()
  expect(source).toMatch(/<Teleport to="body">\s*<div v-if="showChangesPanel && currentSession" class="changes-overlay"/)
  expect(source).toMatch(/\.changes-overlay\s*\{\s*position:\s*fixed;\s*inset:\s*0;/)
  expect(source).toContain(':revision="changesRevision"')
})

test('interrupted live updates are visible while manual refresh stays available', async () => {
  api.getSessionChanges = async () => []
  const live = Vue.ref(false)
  const root = await mount(() => ({ sessionId: 'A', directory: '/A', isStreaming: false, liveConnected: live.value }))
  expect(text(root)).toContain('实时快照更新尚未连接')
  expect(button(root, '刷新文件变更').props.disabled).toBe(false)
  live.value = true; await settle()
  expect(text(root)).not.toContain('实时快照更新尚未连接')
})

test('search entry closes the lower changes modal before taking focus', async () => {
  const source = await Bun.file(new URL('../src/App.vue', import.meta.url)).text()
  expect(source).toMatch(/function openSearch\(\) \{[\s\S]*?showChangesPanel\.value = false\s*showSearch\.value = true\s*\}/)
  expect(source).toContain('@open-search="openSearch"')
  expect(source).toContain('else openSearch()')
})
