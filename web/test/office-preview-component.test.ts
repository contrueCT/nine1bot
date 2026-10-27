import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import { compileComponent, deferred, descendants, node, renderer, settle, type Host } from './sfc-review-harness'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalFetch = globalThis.fetch
let app: ReturnType<typeof renderer.createApp> | undefined
function preview(id: string, content: string | undefined = btoa(id)) {
  return { id, filename: `${id}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content, path: `/tmp/${id}.docx`, size: 10, sessionID: 'session' }
}
async function mount(renderAsync: (blob: Blob, target: Host) => Promise<void>, initial = preview('first')) {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (type: string) => node(type) } })
  const Component = await compileComponent('preview/OfficePreview.vue', { docx: { renderAsync } }, true)
  const props = Vue.reactive({ preview: initial })
  const root = node('root')
  app = renderer.createApp({ render: () => Vue.h(Component, props) })
  app.mount(root)
  await settle()
  return { props, root, container: () => descendants(root).find(item => item.props.class === 'docx-container')! }
}
afterEach(() => {
  app?.unmount(); app = undefined
  globalThis.fetch = originalFetch
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as any).document
})

test('the real DOCX component renders into its mounted container on first open', async () => {
  const calls: string[] = []
  const view = await mount(async (blob, target) => {
    const content = await blob.text()
    calls.push(content)
    target.replaceChildren(node('p', content))
  })
  await settle()
  expect(calls).toEqual(['first'])
  expect(view.container().style.display).not.toBe('none')
  expect(descendants(view.container()).some(item => item.text === 'first')).toBe(true)
})

test('a slow previous DOCX render cannot overwrite a newer preview or hide its loading state', async () => {
  const pending = { first: deferred(), second: deferred() }
  const view = await mount(async (blob, target) => {
    const content = await blob.text() as keyof typeof pending
    await pending[content].promise
    target.replaceChildren(node('p', content))
  })
  view.props.preview = preview('second'); await settle()
  pending.first.resolve(undefined); await settle()
  expect(view.container().style.display).toBe('none')
  expect(descendants(view.root).some(item => item.props.class === 'loading')).toBe(true)
  pending.second.resolve(undefined); await settle()
  expect(descendants(view.container()).some(item => item.text === 'second')).toBe(true)
  expect(descendants(view.container()).some(item => item.text === 'first')).toBe(false)
})

test('a stale render error cannot replace a successfully rendered newer document', async () => {
  const first = deferred()
  const view = await mount(async (blob, target) => {
    const text = await blob.text()
    if (text === 'first') await first.promise
    target.replaceChildren(node('p', text))
  })
  view.props.preview = preview('second'); await settle()
  first.reject(new Error('stale document corrupt')); await settle()
  expect(descendants(view.container()).some(item => item.text === 'second')).toBe(true)
  expect(descendants(view.root).some(item => item.props.class === 'error-state')).toBe(false)
})

test('late successful renders stay detached after preview replacement or unmount', async () => {
  const pending = { first: deferred(), second: deferred(), third: deferred() }
  const view = await mount(async (blob, target) => {
    const text = await blob.text() as keyof typeof pending
    await pending[text].promise
    target.replaceChildren(node('p', text))
  })
  view.props.preview = preview('second'); await settle()
  pending.second.resolve(undefined); await settle()
  pending.first.resolve(undefined); await settle()
  expect(descendants(view.container()).some(item => item.text === 'second')).toBe(true)
  expect(descendants(view.container()).some(item => item.text === 'first')).toBe(false)
  view.props.preview = preview('third'); await settle()
  const container = view.container()
  app!.unmount(); app = undefined
  pending.third.resolve(undefined); await settle()
  expect(container.children).toHaveLength(0)
})

test('preview changes abort the old fetch and a current fetch failure shows a retryable error', async () => {
  let signal: AbortSignal | undefined
  const read = deferred<Response>()
  globalThis.fetch = ((_input: unknown, options: RequestInit) => { signal = options.signal as AbortSignal; return read.promise }) as typeof fetch
  const first = preview('first'); first.content = undefined
  const view = await mount(async (_blob, target) => { target.replaceChildren(node('p', 'rendered')) }, first)
  expect(signal?.aborted).toBe(false)
  view.props.preview = preview('second'); await settle()
  expect(signal?.aborted).toBe(true)
  read.resolve(new Response('missing', { status: 404 })); await settle()
  expect(descendants(view.root).some(item => item.props.class === 'error-state')).toBe(false)
  globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch
  const broken = preview('missing'); broken.content = undefined
  view.props.preview = broken; await settle()
  expect(descendants(view.root).some(item => item.props.class === 'error-state')).toBe(true)
  expect(descendants(view.root).some(item => item.text.includes('HTTP 404'))).toBe(true)
})
