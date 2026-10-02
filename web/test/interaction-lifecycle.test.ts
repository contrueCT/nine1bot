import { afterEach, describe, expect, it } from 'bun:test'
import * as Vue from 'vue'
import { visiblePreferenceText } from '../../opencode/packages/opencode/src/preferences/permission'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createInteractionResponder } from '../src/composables/interaction-state'
import { api, permissionApi, questionApi } from '../src/api/client'
import { useSession } from '../src/composables/useSession'

// Compile the actual SFC and mount it with Vue's renderer, without a browser/backend.
async function component(name: string) {
  const source = await Bun.file(new URL(`../src/components/${name}.vue`, import.meta.url)).text()
  const { descriptor } = parse(source)
  const { content } = compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/g, (_, imports: string) => `const { ${imports.replace(/\bas\b/g, ':')} } = Vue;`)
    .replace(/import\s*\{\s*visiblePreferenceText\s*\}\s*from\s*["'][^"']+preferences\/permission["'];?/g, '')
    .replace('export default', 'return')
  return new Function('Vue', 'visiblePreferenceText', compiled)(Vue, visiblePreferenceText)
}
type Node = { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const node = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] })
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
function text(root: Node): string { return root.type === 'comment' ? '' : root.text + root.children.map(text).join('') }
function button(root: Node, label: string) {
  const match = descendants(root).find(node => node.type === 'button' && text(node).includes(label))
  if (!match) throw new Error(`Button not found: ${label}: ${text(root)}`)
  return match
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const mounted: ReturnType<typeof renderer.createApp>[] = []
const originals = [api, permissionApi, questionApi].map(object => [object, { ...object }] as const)
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  for (const [object, methods] of originals) Object.assign(object, methods)
})
async function mount(name: string, props: () => any) {
  const Card = await component(name)
  const root = node('root')
  const app = renderer.createApp({ render: () => Vue.h(Card, props()) })
  mounted.push(app)
  app.mount(root)
  return root
}

describe('parent-owned interaction cards', () => {
  it('preserves the selected answer after failure, blocks repeated submission, and shows success only after reply', async () => {
    const pending = deferred()
    const responder = createInteractionResponder()
    const request = { id: 'q1', sessionID: 'A', questions: [{ question: 'Choose', options: [{ label: 'yes' }], custom: false }] }
    let calls = 0
    let answers: string[][] | undefined
    let completion: Promise<boolean> | undefined
    const root = await mount('AgentQuestion', () => ({
      request, state: responder.states.value.q1,
      onAnswered(id: string, answer: string[][]) {
        answers = answer
        completion = responder.respond(id, 'answer', () => { calls++; return pending.promise }, () => {})
      },
    }))
    button(root, 'yes').props.onClick()
    await Vue.nextTick()
    const submit = button(root, '提交').props.onClick
    submit(); submit()
    await Vue.nextTick()
    expect(calls).toBe(1)
    expect(text(root)).not.toContain('已回答')
    expect(button(root, 'yes').props.disabled).toBe(true)
    pending.reject(new Error('temporary failure'))
    await completion
    await Vue.nextTick()
    expect(text(root)).toContain('temporary failure')
    expect(button(root, 'yes').props.class).toContain('selected')
    expect(button(root, '提交').props.disabled).toBe(false)
    expect(answers).toEqual([['yes']])
    responder.states.value.q1 = { status: 'success', action: 'answer' }
    await Vue.nextTick()
    expect(text(root)).toContain('已回答')
  })
  it('never displays refused before acting, uses session scope, and emits permission intent without making its own API request', async () => {
    let directApiCalls = 0
    permissionApi.reply = async () => { directApiCalls++ }
    const state = Vue.ref<any>()
    const responses: string[] = []
    const root = await mount('PermissionRequest', () => ({
      request: { id: 'p1', sessionID: 'A', permission: 'bash', patterns: ['ls *'] }, state: state.value,
      onResponded(reply: string) { responses.push(reply) },
    }))
    expect(text(root)).not.toContain('已拒绝')
    expect(text(root)).toContain('本会话内允许')
    button(root, '允许一次').props.onClick()
    await Vue.nextTick()
    expect(responses).toEqual(['once'])
    expect(directApiCalls).toBe(0)
    expect(text(root)).not.toContain('已允许一次')
    state.value = { status: 'pending', action: 'once' }
    await Vue.nextTick()
    expect(button(root, '拒绝').props.disabled).toBe(true)
    state.value = { status: 'error', action: 'once', error: 'try again' }
    await Vue.nextTick()
    expect(text(root)).toContain('try again')
    expect(text(root)).not.toContain('已拒绝')
    state.value = { status: 'success', action: 'once' }
    await Vue.nextTick()
    expect(text(root)).toContain('已允许一次')
  })
  it('keeps the escaped preference preview and blocks incomplete approvals through parent-owned retries', async () => {
    const request = Vue.ref<any>({ id: 'remember1', sessionID: 'A', permission: 'remember', metadata: {} })
    const responder = createInteractionResponder()
    const pending = deferred()
    let calls = 0
    let completion: Promise<boolean> | undefined
    const root = await mount('PermissionRequest', () => ({
      request: request.value, state: responder.states.value.remember1,
      onResponded(reply: string) {
        completion = responder.respond('remember1', reply, () => { calls++; return pending.promise }, () => {})
      },
    }))
    expect(button(root, '允许一次').props.disabled).toBe(true)
    expect(button(root, '本会话内允许').props.disabled).toBe(true)
    button(root, '允许一次').props.onClick()
    button(root, '本会话内允许').props.onClick()
    expect(calls).toBe(0)
    request.value = { ...request.value, metadata: { content: 'Keep \u202evisible', scope: 'project', directory: '/project/\u2066name' } }
    await Vue.nextTick()
    expect(text(root)).toContain('Keep \\u202evisible')
    expect(text(root)).toContain('/project/\\u2066name')
    expect(button(root, '允许一次').props.disabled).toBe(false)
    button(root, '允许一次').props.onClick()
    button(root, '允许一次').props.onClick()
    await Vue.nextTick()
    expect(calls).toBe(1)
    expect(button(root, '本会话内允许').props.disabled).toBe(true)
    pending.reject(new Error('permission reply unavailable'))
    await completion
    await Vue.nextTick()
    expect(text(root)).toContain('permission reply unavailable')
    expect(text(root)).toContain('Keep \\u202evisible')
    expect(text(root)).not.toContain('已允许一次')
    expect(button(root, '允许一次').props.disabled).toBe(false)
  })
  it('resets question input when a component is reused for a different request', async () => {
    const request = Vue.ref({ id: 'q1', sessionID: 'A', questions: [{ question: 'Choose', options: [{ label: 'yes' }], custom: false }] })
    const root = await mount('AgentQuestion', () => ({ request: request.value }))
    button(root, 'yes').props.onClick()
    await Vue.nextTick()
    expect(button(root, '提交').props.disabled).toBe(false)
    request.value = { ...request.value, id: 'q2' }
    await Vue.nextTick()
    expect(button(root, '提交').props.disabled).toBe(true)
  })
  it('sends one API request per interaction, allows retry after failure, and preserves another session on late completion', async () => {
    const state = useSession()
    const question = { id: 'q1', sessionID: 'A', questions: [] }
    state.pendingQuestions.value = [question]
    const first = deferred()
    let replies = 0
    questionApi.reply = async () => { replies++; await first.promise }
    const answering = state.answerQuestion('q1', [['yes']])
    expect(await state.answerQuestion('q1', [['no']])).toBe(false)
    expect(replies).toBe(1)
    first.reject(new Error('offline'))
    expect(await answering).toBe(false)
    expect(state.pendingQuestions.value).toHaveLength(1)
    expect(state.interactionStates.value.q1.status).toBe('error')
    const retry = deferred()
    questionApi.reply = () => retry.promise
    const retrying = state.answerQuestion('q1', [['yes']])
    state.pendingQuestions.value = [{ ...question, id: 'q2', sessionID: 'B' }]
    retry.resolve()
    expect(await retrying).toBe(true)
    expect(state.pendingQuestions.value[0].id).toBe('q2')
    expect(state.interactionStates.value.q2).toBeUndefined()

    state.pendingPermissions.value = [{ id: 'p1', sessionID: 'A', permission: 'bash', patterns: [], metadata: {}, always: [] }]
    const permission = deferred()
    let permissions = 0
    permissionApi.reply = async () => { permissions++; await permission.promise }
    const replying = state.respondPermission('p1', 'once')
    expect(await state.respondPermission('p1', 'reject')).toBe(false)
    expect(permissions).toBe(1)
    permission.resolve()
    expect(await replying).toBe(true)
    expect(state.pendingPermissions.value).toEqual([])
    state.unsubscribe()
  })
})
