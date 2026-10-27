import { afterEach, expect, test } from 'bun:test'
import * as Vue from 'vue'
import { projectApi } from '../src/api/client'
import { compileComponent, deferred, node, renderer, settle } from './sfc-review-harness'

const originalApi = { ...projectApi }
const originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
let app: ReturnType<typeof renderer.createApp> | undefined
function project(id: string) { return { id, name: id, instructions: '', time: { updated: 1 }, worktree: `/${id}` } }
async function mount() {
  const Component = await compileComponent('ProjectsPage.vue', { projectApi, DirectoryBrowser: {} })
  const props = Vue.reactive({ projects: [project('A'), project('B')], currentProject: project('A') as any, projectContextRevision: 0 })
  let state: any
  const setup = Component.setup
  Component.setup = (props: any, context: any) => {
    state = setup(props, context)
    return () => Vue.h('div')
  }
  app = renderer.createApp({ render: () => Vue.h(Component, props) })
  app.mount(node('root'))
  await settle()
  return { props, state }
}
function defaults() {
  projectApi.sessions = async () => []
  projectApi.getEnvironment = async () => ({ keys: [], variables: {} })
  projectApi.listSharedFiles = async () => []
}
afterEach(() => {
  app?.unmount(); app = undefined
  Object.assign(projectApi, originalApi)
  if (originalReader) Object.defineProperty(globalThis, 'FileReader', originalReader)
  else delete (globalThis as any).FileReader
})

test('project B retains its sessions, environment and files when A finishes last; stale rows cannot delete B', async () => {
  const pending: Record<string, ReturnType<typeof deferred>> = {}
  for (const id of ['A', 'B']) for (const kind of ['sessions', 'environment', 'files']) pending[id + kind] = deferred()
  projectApi.sessions = id => pending[id + 'sessions'].promise
  projectApi.getEnvironment = id => pending[id + 'environment'].promise
  projectApi.listSharedFiles = id => pending[id + 'files'].promise
  const { props, state } = await mount()
  props.currentProject = project('B'); await settle()
  expect(state.sessions.value).toEqual([])
  expect(state.sharedFiles.value).toEqual([])
  for (const id of ['B', 'A']) {
    pending[id + 'sessions'].resolve([{ id: `${id}-session` }])
    pending[id + 'environment'].resolve({ keys: [`${id}_KEY`], variables: {} })
    pending[id + 'files'].resolve([{ relativePath: `${id}.txt` }, { relativePath: 'shared.txt', name: id }])
    await settle()
  }
  expect(state.sessions.value[0].id).toBe('B-session')
  expect(state.environment.value.keys).toEqual(['B_KEY'])
  expect(state.sharedFiles.value[1].name).toBe('B')
  const deleted: any[] = []
  projectApi.deleteSharedFile = async (...args) => { deleted.push(args); return true }
  projectApi.deleteEnvironmentKey = async (...args) => { deleted.push(args); return {} }
  await state.deleteSharedFile('A.txt')
  await state.deleteEnvironmentVariable('A_KEY')
  expect(deleted).toEqual([])
})

test('leaving and reopening A invalidates its earlier load, including stale errors', async () => {
  defaults()
  const old = deferred()
  let calls = 0
  projectApi.listSharedFiles = async () => ++calls === 1 ? old.promise : [{ relativePath: 'new.txt' }] as any
  const { props, state } = await mount()
  props.currentProject = null; await settle()
  expect(state.isLoadingSharedFiles.value).toBe(false)
  props.currentProject = project('A'); await settle()
  old.reject(new Error('old A failed')); await settle()
  expect(state.sharedFiles.value[0].relativePath).toBe('new.txt')
  expect(state.sharedFileError.value).toBe('')
})

function mockReader() {
  let reader: any
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: class {
    result = 'data:text/plain;base64,YQ=='
    onload: any; onerror: any; onabort: any
    constructor() { reader = this }
    readAsDataURL() {}
  } })
  return () => reader
}
test('file reads retain the selected project across project changes and leaving the detail view', async () => {
  defaults()
  const getReader = mockReader()
  const uploaded: string[] = []
  projectApi.uploadSharedFile = async id => { uploaded.push(id); return {} as any }
  const { props, state } = await mount()
  await state.onSharedFilePicked({ target: { files: [new File(['a'], 'a.txt')], value: 'a.txt' } })
  props.currentProject = project('B'); await settle()
  await getReader().onload(); await settle()
  expect(uploaded).toEqual(['A'])
  expect(state.sharedFileNotice.value).toBe('')
  await state.onSharedFilePicked({ target: { files: [new File(['b'], 'b.txt')], value: 'b.txt' } })
  props.currentProject = null; await settle()
  await getReader().onload(); await settle()
  expect(uploaded).toEqual(['A', 'B'])
})

test('finishing an old environment save cannot clear the new project draft or replace its errors', async () => {
  defaults()
  const saving = deferred()
  const requests: any[] = []
  projectApi.setEnvironmentKey = async (...args) => { requests.push(args); return saving.promise }
  const { props, state } = await mount()
  state.envKey.value = 'A_KEY'; state.envValue.value = 'a'
  const result = state.saveEnvironmentVariable()
  props.currentProject = project('B'); await settle()
  state.envKey.value = 'B_KEY'; state.envValue.value = 'b'
  saving.resolve({ A_KEY: 'a' }); await result; await settle()
  expect(requests).toEqual([['A', 'A_KEY', 'a']])
  expect(state.envKey.value).toBe('B_KEY')
  expect(state.envValue.value).toBe('b')
  expect(state.isSavingEnv.value).toBe(false)
})

test('an in-flight shared-file deletion stays owned by A and cannot refresh or notify B', async () => {
  defaults()
  const deleting = deferred<boolean>()
  const loads: string[] = []
  const requests: any[] = []
  projectApi.listSharedFiles = async id => { loads.push(id); return [{ relativePath: 'shared.txt', name: id }] as any }
  projectApi.deleteSharedFile = async (...args) => { requests.push(args); return deleting.promise }
  const { props, state } = await mount()
  const result = state.deleteSharedFile('shared.txt')
  props.currentProject = project('B'); await settle()
  deleting.resolve(true); await result; await settle()
  expect(requests).toEqual([['A', 'shared.txt']])
  expect(loads).toEqual(['A', 'B'])
  expect(state.sharedFiles.value[0].name).toBe('B')
  expect(state.sharedFileNotice.value).toBe('')
  expect(state.deletingSharedFile.value).toBe('')
})

test('file read, upload and delete failures remain visible and release pending controls', async () => {
  defaults()
  const getReader = mockReader()
  projectApi.listSharedFiles = async () => [{ relativePath: 'shared.txt' }] as any
  const { state } = await mount()
  const pick = () => state.onSharedFilePicked({ target: { files: [new File(['a'], 'a.txt')], value: 'a.txt' } })
  await pick(); getReader().onerror()
  expect(state.sharedFileError.value).toContain('读取文件失败')
  expect(state.isUploadingSharedFile.value).toBe(false)
  projectApi.uploadSharedFile = async () => { throw new Error('upload offline') }
  await pick(); await getReader().onload()
  expect(state.sharedFileError.value).toContain('upload offline')
  expect(state.isUploadingSharedFile.value).toBe(false)
  projectApi.deleteSharedFile = async () => { throw new Error('delete denied') }
  await state.deleteSharedFile('shared.txt')
  expect(state.sharedFileError.value).toContain('delete denied')
  expect(state.deletingSharedFile.value).toBe('')
  expect(state.sharedFiles.value).toHaveLength(1)
})
