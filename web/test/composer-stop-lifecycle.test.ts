import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { api, permissionApi, questionApi, type MessageSubmission } from '../src/api/client'
import { useSession } from '../src/composables/useSession'
import * as drafts from '../src/composables/composer-drafts'
import { useParallelSessions } from '../src/composables/useParallelSessions'

const originals = [api, permissionApi, questionApi].map(object => [object, { ...object }] as const)
const globals = { document: globalThis.document, Document: globalThis.Document, ShadowRoot: globalThis.ShadowRoot }
const icons = new Proxy({}, { get: () => ({ render: () => null }) })
let active: ReturnType<typeof useSession>
let app: ReturnType<typeof renderer.createApp> | undefined

type Node = {
  type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node
  style: Record<string, any>; value?: string; scrollHeight: number; tagName: string
  addEventListener(): void; removeEventListener(): void; setSelectionRange(): void; focus(): void
  getRootNode(): unknown; getAttribute(): null
}
const node = (type: string, text = ''): Node => ({
  type, text, props: {}, children: [], style: {}, scrollHeight: 20, tagName: type.toUpperCase(),
  addEventListener() {}, removeEventListener() {}, setSelectionRange() {}, focus() {},
  getRootNode() { return globalThis.document }, getAttribute() { return null },
})
const renderer = Vue.createRenderer<Node, Node>({
  createElement: type => node(type), createText: text => node('text', text), createComment: text => node('comment', text),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _previous, value) => { node.props[key] = value },
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child)
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index === -1) parent.children.push(child); else parent.children.splice(index, 0, child)
  },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
  parentNode: node => node.parent || null,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
})
function descendants(root: Node): Node[] { return [root, ...root.children.flatMap(descendants)] }
function text(root: Node): string { return root.text + root.children.map(text).join('') }
function button(root: Node, label: string) {
  const match = descendants(root).find(node => node.type === 'button' && (node.props.title === label || text(node) === label))
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function mountComposer() {
  const source = await Bun.file(new URL('../src/components/InputBox.vue', import.meta.url)).text()
  const { descriptor } = parse(source)
  const { content } = compileScript(descriptor, { id: 'InputBox', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/g, (_, imports: string) => `const { ${imports.replace(/\bas\b/g, ':')} } = Vue;`)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']lucide-vue-next["'];?/g, (_, imports: string) => `const { ${imports} } = icons;`)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["'][^"']+composer-drafts["'];?/g, (_, imports: string) => `const { ${imports} } = drafts;`)
    .replace('export default', 'return')
  const InputBox = new Function('Vue', 'drafts', 'icons', compiled)(Vue, drafts, icons)
  const sends: Promise<boolean>[] = []
  let aborting: Promise<void> | undefined
  const root = node('root')
  app = renderer.createApp({ render: () => Vue.h(InputBox, {
    disabled: false, draftKey: active.composerKey.value, isStreaming: active.isStreaming.value,
    onSend(content: string, files: any, _plan: boolean, onResult: (success: boolean) => void, attempt: drafts.SendAttempt) {
      const sending = active.sendMessage(content, { providerID: 'p', modelID: 'slow' }, files, attempt)
      sends.push(sending)
      void sending.then(onResult)
    },
    onAbort() { aborting = active.abortCurrentSession() },
  }) })
  app.mount(root)
  return { root, sends, stop: async () => { button(root, '停止').props.onClick(); await aborting; await Vue.nextTick() } }
}

beforeEach(async () => {
  globalThis.Document = class {} as any
  globalThis.ShadowRoot = class {} as any
  globalThis.document = { addEventListener() {}, removeEventListener() {} } as any
  api.subscribeSessionRuntimeEvents = () => ({ ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 })
  api.getMessages = async () => []
  api.getSessionStatus = async () => ({})
  api.getSessions = async () => []
  permissionApi.list = async () => []
  questionApi.list = async () => []
  api.abortSession = async () => {}
  active = useSession()
  await active.selectSession({ id: 'A', directory: '/workspace/A', title: 'A', time: { created: 1, updated: 1 } })
})
afterEach(() => {
  app?.unmount()
  app = undefined
  active?.unsubscribe()
  drafts.clearComposerDrafts()
  useParallelSessions().clearSession('A')
  for (const [object, methods] of originals) Object.assign(object, methods)
  Object.assign(globalThis, globals)
})

test('mounted composer can send replacement text immediately after Stop while the old model request is unresolved', async () => {
  const oldModel = deferred<any>()
  const modelStarted = deferred()
  const postStarted = deferred()
  const posted = deferred<any>()
  let models = 0
  api.changeSessionModel = async () => {
    if (++models === 1) { modelStarted.resolve(); return oldModel.promise }
    return { sessionId: 'A', currentModel: { providerID: 'p', modelID: 'slow' } }
  }
  const requests: MessageSubmission[] = []
  api.sendMessage = async (_id, submission) => { requests.push(submission); postStarted.resolve(); return posted.promise }
  const mounted = await mountComposer()
  const draft = drafts.getComposerDraft('A')
  draft.text = 'old text'
  await Vue.nextTick()
  button(mounted.root, '发送').props.onClick()
  await modelStarted.promise
  await Vue.nextTick()
  await mounted.stop()
  expect(active.isStreaming.value).toBe(false)
  expect(draft.attempts[0].status).toBe('failed')
  expect(button(mounted.root, '重试').props.disabled).toBe(false)
  draft.text = 'replacement text'
  await Vue.nextTick()
  expect(button(mounted.root, '发送').props.disabled).toBe(false)
  button(mounted.root, '发送').props.onClick()
  await postStarted.promise
  active.streamingMessage.value = { info: { id: 'replacement', sessionID: 'A', role: 'assistant', time: { created: 1 } }, parts: [] }
  oldModel.resolve({ currentModel: { providerID: 'p', modelID: 'slow' } })
  expect(await mounted.sends[0]).toBe(false)
  await Vue.nextTick()
  expect(draft.attempts[1].status).toBe('sending')
  expect(active.streamingMessage.value?.info.id).toBe('replacement')
  expect(requests).toHaveLength(1)
  expect(JSON.parse(requests[0].body).parts[0].text).toBe('replacement text')
  posted.resolve({ accepted: true, sessionId: 'A' })
  expect(await mounted.sends[1]).toBe(true)
  await Vue.nextTick()
  expect(draft.attempts).toHaveLength(1)
  expect(draft.attempts[0].text).toBe('old text')
})

test('mounted composer retries a stopped attempt immediately and ignores the old completion generation', async () => {
  const first = deferred<any>()
  const retry = deferred<any>()
  const firstStarted = deferred()
  const retryStarted = deferred()
  let models = 0
  api.changeSessionModel = async () => {
    if (++models === 1) { firstStarted.resolve(); return first.promise }
    retryStarted.resolve()
    return retry.promise
  }
  const requests: MessageSubmission[] = []
  api.sendMessage = async (_id, submission) => { requests.push(submission); return { accepted: true, sessionId: 'A' } }
  const mounted = await mountComposer()
  const draft = drafts.getComposerDraft('A')
  draft.text = 'retry original'
  await Vue.nextTick()
  button(mounted.root, '发送').props.onClick()
  await firstStarted.promise
  const attempt = draft.attempts[0]
  const generation = attempt.generation
  await Vue.nextTick()
  await mounted.stop()
  expect(button(mounted.root, '重试').props.disabled).toBe(false)
  button(mounted.root, '重试').props.onClick()
  await retryStarted.promise
  expect(attempt.generation).toBeGreaterThan(generation)
  expect(attempt.status).toBe('sending')
  first.resolve({ currentModel: { providerID: 'p', modelID: 'slow' } })
  expect(await mounted.sends[0]).toBe(false)
  await Vue.nextTick()
  expect(attempt.status).toBe('sending')
  expect(draft.attempts).toHaveLength(1)
  expect(requests).toHaveLength(0)
  retry.resolve({ currentModel: { providerID: 'p', modelID: 'slow' } })
  expect(await mounted.sends[1]).toBe(true)
  await Vue.nextTick()
  expect(draft.attempts).toHaveLength(0)
  expect(requests).toHaveLength(1)
  expect(requests[0].requestID).toBe(attempt.id)
  expect(JSON.parse(requests[0].body).parts[0].text).toBe('retry original')
})
