import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createCodeRenderer, markdownRenderMode } from '../src/utils/markdown-renderer'
import { applyBlockOps, createMarkdownBlockRenderer, diffBlocks } from '../src/utils/markdown-blocks'

type Node = {
  type: string; data: string; html: string; children: Node[]; parentNode?: Node; props: Record<string, any>
  appendData(value: string): void; replaceChildren(...nodes: Node[]): void
  insertAdjacentHTML(position: string, html: string): void; remove(): void; outerHTML: string; innerHTML: string
}
function node(type: string, data = ''): Node {
  const value: Node = { type, data, html: '', children: [], props: {},
    appendData(text) { this.data += text },
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = undefined }); this.children = nodes; nodes.forEach(child => { child.parentNode = this }) },
    insertAdjacentHTML(_position, html) { const child = node('html'); child.html = html; child.parentNode = this; this.children.push(child) },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = undefined },
    get outerHTML() { return this.html }, set outerHTML(html) { this.html = html },
    get innerHTML() { return this.children.map(child => child.html).join('') }, set innerHTML(html) { this.replaceChildren(); this.insertAdjacentHTML('beforeend', html) },
  }
  return Vue.markRaw(value)
}
const renderer = Vue.createRenderer<Node, Node>({
  createElement: type => node(type), createText: text => node('text', text), createComment: text => node('comment', text),
  setText: (item, text) => { item.data = text }, setElementText: (item, text) => { item.replaceChildren(node('text', text)) },
  patchProp: (item, key, _old, value) => { item.props[key] = value },
  insert(child, parent, anchor) { child.remove(); child.parentNode = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
  remove: item => item.remove(), parentNode: item => item.parentNode || null,
  nextSibling: item => item.parentNode?.children[item.parentNode.children.indexOf(item) + 1] || null,
})
const jobs: Array<{ source: string; done: (blocks: string[] | null) => void; cancelled: boolean }> = []
const sanitized: string[] = []
let inlineParses = 0
async function component() {
  const { descriptor } = parse(await Bun.file(new URL('../src/components/MarkdownText.vue', import.meta.url)).text())
  const script = compileScript(descriptor, { id: 'markdown-lifetime', inlineTemplate: true })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_full, imports: string, path: string) => `const { ${imports.replace(/\bas\b/g, ':')} } = ${path === 'vue' ? 'Vue' : 'deps'};`)
    .replace(/import\s+DOMPurify\s+from\s*['"]dompurify['"];?/, 'const DOMPurify = deps.DOMPurify;')
    .replace('export default', 'return')
  return new Function('Vue', 'deps', compiled)(Vue, {
    copyText: async () => true, createCodeRenderer, markdownRenderMode, applyBlockOps, diffBlocks,
    createMarkdownBlockRenderer: (options: any) => { const render = createMarkdownBlockRenderer(options); return (text: string) => { inlineParses++; return render(text) } },
    // This spy checks dispatch only. Real DOMPurify + Worker coverage lives in
    // browser/lifecycle.ts, which mounts this SFC in Chromium without substitutes.
    DOMPurify: { sanitize(html: string) { sanitized.push(html); return html } },
    markdownWorkerClient: { render(source: string, done: (blocks: string[] | null) => void) { const job = { source, done, cancelled: false }; jobs.push(job); return () => { job.cancelled = true } } },
  })
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
let app: ReturnType<typeof renderer.createApp> | undefined
async function mount(text: string, streaming: boolean) {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createTextNode: (value: string) => node('text', value) } })
  const Card = await component()
  const props = Vue.reactive({ text, streaming })
  const root = node('root')
  app = renderer.createApp({ render: () => Vue.h(Card, props) })
  app.mount(root)
  await Vue.nextTick()
  return { props, host: root.children[0] }
}
afterEach(() => {
  app?.unmount(); app = undefined; jobs.length = 0; sanitized.length = 0; inlineParses = 0
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as any).document
})

test('real component appends large live text without Markdown parsing or replacing its Text node', async () => {
  const source = '<script>unsafe</script>' + '长文本'.repeat(10000)
  const { props, host } = await mount(source, true)
  const textNode = host.children[0]
  expect(textNode.type).toBe('text')
  expect(textNode.data).toBe(source)
  props.text += '追加'
  await Vue.nextTick()
  expect(host.children[0]).toBe(textNode)
  expect(textNode.data).toBe(source + '追加')
  expect(inlineParses).toBe(0)
  expect(jobs.length).toBe(0)
})

test('component sends completed worker blocks through the sanitizer', async () => {
  const source = 'source '.repeat(2000)
  const { props, host } = await mount(source, true)
  props.streaming = false
  await Vue.nextTick()
  expect(jobs.length).toBe(1)
  expect(host.props['aria-busy']).toBe(true)
  jobs[0].done(['<p>formatted</p>'])
  await Vue.nextTick()
  expect(host.innerHTML).toBe('<p>formatted</p>')
  expect(sanitized).toContain('<p>formatted</p>')
  expect(host.props['aria-busy']).toBeUndefined()
})

test('real component cancels stale rendering on source replacement and on unmount', async () => {
  const { props, host } = await mount('old '.repeat(4000), false)
  expect(jobs.length).toBe(1)
  props.text = 'new '.repeat(4000)
  await Vue.nextTick()
  expect(jobs[0].cancelled).toBe(true)
  expect(jobs.length).toBe(2)
  jobs[0].done(['<p>old</p>'])
  expect(host.children[0].data).toBe(props.text)
  app!.unmount(); app = undefined
  expect(jobs[1].cancelled).toBe(true)
  jobs[1].done(['<p>new</p>'])
  expect(sanitized.length).toBe(0)
})

test('oversized completed content stays fully readable without rich-text DOM allocation', async () => {
  const source = '全文'.repeat(100000)
  const { host } = await mount(source, false)
  expect(host.children).toHaveLength(1)
  expect(host.children[0].data).toBe(source)
  expect(inlineParses).toBe(0)
  expect(jobs.length).toBe(0)
})
