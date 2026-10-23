import { describe, expect, it } from 'bun:test'
import { createPreviewWindowOpener, PREVIEW_WINDOW_NAVIGATION_TIMEOUT_MS } from '../src/utils/preview-window'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { useFilePreview } from '../src/composables/useFilePreview'
import { decodeBase64Utf8 } from '../src/utils/encoding'

function fixture() {
  const target = { closed: false, document: { URL: 'about:blank', readyState: 'complete' } }
  let tick: (() => void) | undefined
  let pagehide: (() => void) | undefined
  const created: string[] = []
  const revoked: string[] = []
  const opened: string[] = []
  let blocked = false
  let throwing = false
  let cleared = 0
  let now = 0
  const host = {
    open(url: string) {
      opened.push(url)
      if (throwing) throw new Error('window open failed')
      return blocked ? null : target
    },
    setInterval(callback: () => void) { tick = callback; return 1 },
    clearInterval() { tick = undefined; cleared++ },
    addEventListener(_type: string, callback: () => void) { pagehide = callback },
    removeEventListener() { pagehide = undefined },
  }
  const urls = {
    createObjectURL(blob: Blob) { const url = URL.createObjectURL(blob); created.push(url); return url },
    revokeObjectURL(url: string) { revoked.push(url); URL.revokeObjectURL(url) },
  }
  const opener = createPreviewWindowOpener(host as any, urls, () => now)
  return { target, created, revoked, opened, opener, tick: () => tick?.(), pagehide: () => pagehide?.(),
    blocked: () => { blocked = true }, throwing: () => { throwing = true }, cleared: () => cleared, advance: (ms: number) => { now += ms } }
}
const preview = { id: 'preview-local-id', mime: 'text/html', content: Buffer.from('<h1>你好</h1>').toString('base64') }

describe('HTML preview window ownership', () => {
  it('keeps loaded inline content usable for reload and late reads until its window closes', async () => {
    const f = fixture()
    expect(f.opener.open(preview)).toBe(true)
    const url = f.created[0]!
    f.tick()
    expect(f.revoked).toEqual([]) // initial about:blank is already complete
    expect(await (await fetch(url)).text()).toBe('<h1>你好</h1>')
    f.target.document = { URL: url, readyState: 'loading' }
    f.tick()
    expect(f.revoked).toEqual([])
    f.target.document.readyState = 'complete'
    f.tick()
    expect(f.revoked).toEqual([])
    f.advance(PREVIEW_WINDOW_NAVIGATION_TIMEOUT_MS * 2)
    f.tick()
    expect(await (await fetch(url)).text()).toBe('<h1>你好</h1>')
    f.target.closed = true
    f.tick()
    expect(f.revoked).toEqual([url])
    expect(f.cleared()).toBe(1)
    await expect(fetch(url)).rejects.toThrow()
  })

  it('retains an interactive document while its subresources are still loading', () => {
    const f = fixture()
    f.opener.open(preview)
    f.target.document = { URL: f.created[0]!, readyState: 'interactive' }
    f.tick()
    f.advance(PREVIEW_WINDOW_NAVIGATION_TIMEOUT_MS * 2)
    f.tick()
    expect(f.revoked).toEqual([])
    f.opener.dispose()
    expect(f.cleared()).toBe(1)
  })

  it('bounds URL ownership when a navigation never leaves about:blank', async () => {
    const f = fixture()
    f.opener.open(preview)
    f.advance(PREVIEW_WINDOW_NAVIGATION_TIMEOUT_MS - 1)
    f.tick()
    expect(f.revoked).toEqual([])
    expect(await (await fetch(f.created[0]!)).text()).toBe('<h1>你好</h1>')
    f.advance(1)
    f.tick()
    expect(f.revoked).toEqual(f.created)
    expect(f.cleared()).toBe(1)
  })

  it('releases blocked and failed popups immediately', () => {
    const blocked = fixture()
    blocked.blocked()
    expect(blocked.opener.open(preview)).toBe(false)
    expect(blocked.revoked).toEqual(blocked.created)
    const throwing = fixture()
    throwing.throwing()
    expect(() => throwing.opener.open(preview)).toThrow('window open failed')
    expect(throwing.revoked).toEqual(throwing.created)
  })

  it('reclaims closed windows, including a window closed before navigation completes', () => {
    const f = fixture()
    f.opener.open(preview)
    f.target.closed = true
    f.tick()
    expect(f.revoked).toEqual(f.created)
    expect(f.cleared()).toBe(1)
  })

  it('uses server URLs for server-only content and blobs for local empty HTML', () => {
    const f = fixture()
    f.opener.open({ id: 'server id', mime: 'text/html' })
    expect(f.opened).toEqual(['/file/preview/server%20id'])
    expect(f.created).toEqual([])
    f.opener.open({ id: 'preview-manual', mime: 'text/html', content: '' })
    expect(f.created).toHaveLength(1)
    f.opener.dispose()
  })

  it('owns pending windows independently of a preview component and cleans up on page exit', () => {
    const f = fixture()
    let componentPreview: typeof preview | undefined = { ...preview }
    f.opener.open(componentPreview)
    componentPreview = undefined // component/preview can disappear while navigation is pending
    f.tick()
    expect(f.revoked).toEqual([])
    f.target.document = { URL: f.created[0]!, readyState: 'complete' }
    f.tick()
    expect(f.revoked).toEqual([])
    f.target.document = { URL: 'https://example.org', readyState: 'complete' }
    f.tick()
    expect(f.revoked).toEqual(f.created)
    f.opener.open(preview)
    f.pagehide()
    expect(f.revoked).toEqual(f.created)
    expect(f.cleared()).toBe(2)
  })

  it('releases its blob when the opened window navigates to another origin', () => {
    const f = fixture()
    f.opener.open(preview)
    Object.defineProperty(f.target, 'document', { get() { throw new Error('cross-origin') } })
    f.tick()
    expect(f.revoked).toEqual(f.created)
  })

  it('releases a loaded window when it later navigates to about:blank', async () => {
    const f = fixture()
    f.opener.open(preview)
    f.target.document = { URL: f.created[0]!, readyState: 'interactive' }
    f.tick()
    expect(f.revoked).toEqual([])
    f.target.document = { URL: 'about:blank', readyState: 'complete' }
    f.tick()
    expect(f.revoked).toEqual(f.created)
    expect(f.cleared()).toBe(1)
    await expect(fetch(f.created[0]!)).rejects.toThrow()
  })
})

// Exercise both actual SFC click handlers through Vue, including unmount while
// the new tab still shows its initial about:blank document.
type Node = { type: string; props: Record<string, any>; children: Node[]; parent?: Node }
const node = (type: string): Node => ({ type, props: {}, children: [] })
const renderer = Vue.createRenderer<Node, Node>({
  createElement: node, createText: () => node('text'), createComment: () => node('comment'),
  setText() {}, setElementText() {}, patchProp(element, key, _old, value) { element.props[key] = value },
  insert(child, parent) { child.parent = parent; parent.children.push(child) },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
  parentNode: child => child.parent || null, nextSibling: () => null,
})
function descendants(root: Node): Node[] { return [root, ...root.children.flatMap(descendants)] }
async function mountPreview(name: string, open: ReturnType<typeof createPreviewWindowOpener>['open']) {
  const source = await Bun.file(new URL(`../src/components/${name}.vue`, import.meta.url)).text()
  const { descriptor } = parse(source)
  const script = compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/g, (_match, imports: string) => `const { ${imports.replace(/\bas\b/g, ':')} } = Vue;`)
    .replace(/^import .+;?$/gm, '')
    .replace('export default', 'return')
  const Empty = { render: () => null }
  const icons = ['Eye', 'X', 'Download', 'ExternalLink', 'Copy', 'Check', 'RefreshCw', 'Code', 'ImagePreview', 'CodePreview', 'MarkdownPreview', 'HtmlPreview', 'OfficePreview']
  const dependencies = { ...Object.fromEntries(icons.map(name => [name, Empty])), useFilePreview, decodeBase64Utf8, openPreviewInNewTab: open, copyText: async () => true }
  const Component = new Function('Vue', 'dependencies', `const { ${Object.keys(dependencies).join(', ')} } = dependencies; ${code}`)(Vue, dependencies)
  const info = { ...preview, sessionID: '', path: '/tmp/local.html', filename: 'local.html', size: 20 }
  useFilePreview().handleSSEEvent({ type: 'file-preview.open', properties: info })
  const root = node('root')
  const app = renderer.createApp(Component, { preview: info })
  app.mount(root)
  return { root, app }
}

for (const name of ['PreviewContent', 'preview/HtmlPreview']) {
  it(`${name} keeps an opened tab usable across component unmount and releases its URL on close`, async () => {
    const f = fixture()
    const { root, app } = await mountPreview(name, f.opener.open)
    try {
      const button = descendants(root).find(item => item.type === 'button' && item.props.title === '新标签页打开')
      expect(button).toBeDefined()
      button!.props.onClick()
      app.unmount()
      useFilePreview().closeAllPreviews()
      f.tick()
      expect(f.revoked).toEqual([])
      expect(await (await fetch(f.created[0]!)).text()).toBe('<h1>你好</h1>')
      f.target.document = { URL: f.created[0]!, readyState: 'complete' }
      f.tick()
      expect(f.revoked).toEqual([])
      expect(await (await fetch(f.created[0]!)).text()).toBe('<h1>你好</h1>')
      f.target.closed = true
      f.tick()
      expect(f.revoked).toEqual(f.created)
    } finally {
      f.opener.dispose()
      useFilePreview().closeAllPreviews()
    }
  })
}
