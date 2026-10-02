import { afterEach, expect, test } from 'bun:test'
import { preferencesApi, setApiDirectory, type Preference, type PreferencesState } from '../src/api/client'
import { usePreferences } from '../src/composables/usePreferences'

const original = { ...preferencesApi }
const originalFetch = globalThis.fetch
afterEach(() => { Object.assign(preferencesApi, original); globalThis.fetch = originalFetch; setApiDirectory('') })

function record(id: string, scope: 'global' | 'project' = 'global'): Preference {
  return { id, content: id, scope, source: 'user', createdAt: 1, ...(scope === 'project' ? { projectID: 'a' } : {}) }
}
function state(directory: string, project: Preference[] = []): PreferencesState {
  return { directory, projectID: directory, preferences: project, global: [], project, unresolved: [] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

test('requests pin query and headers to the displayed project after active project changes', async () => {
  const calls: { url: string; options?: RequestInit }[] = []
  globalThis.fetch = (async (input, options) => {
    calls.push({ url: String(input), options })
    return Response.json(record('saved', 'project'))
  }) as typeof fetch
  setApiDirectory('/project-b')
  await preferencesApi.add('saved', 'project', 'user', '/project-a')
  expect(calls[0].url).toBe('/preferences?directory=%2Fproject-a')
  expect(new Headers(calls[0].options?.headers).get('x-opencode-directory')).toBe('/project-a')
})

test('separate panels and out-of-order loads cannot reuse another project state', async () => {
  const first = deferred<PreferencesState>()
  const second = deferred<PreferencesState>()
  preferencesApi.list = (directory) => directory === '/a' ? first.promise : second.promise
  const panel = usePreferences()
  const a = panel.loadPreferences('/a')
  const b = panel.loadPreferences('/b')
  second.resolve(state('/b', [record('B', 'project')]))
  await b
  first.resolve(state('/a', [record('A', 'project')]))
  await a
  expect(panel.directory.value).toBe('/b')
  expect(panel.projectPreferences.value.map((item) => item.id)).toEqual(['B'])
  expect(usePreferences().preferences.value).toEqual([])
})

test('failed edits and deletes preserve content and allow retry', async () => {
  preferencesApi.list = async () => ({ ...state('/a'), global: [record('original')], preferences: [record('original')] })
  const panel = usePreferences()
  await panel.loadPreferences('/a')
  panel.startEdit(record('original'))
  panel.editingContent.value = 'draft'
  preferencesApi.update = async () => { throw new Error('disk is read-only') }
  expect(await panel.saveEdit()).toBe(false)
  expect(panel.editingId.value).toBe('original')
  expect(panel.editingContent.value).toBe('draft')
  expect(panel.error.value).toBe('disk is read-only')
  preferencesApi.update = async (_id, content) => ({ ...record('original'), content })
  expect(await panel.saveEdit()).toBe(true)
  expect(panel.editingId.value).toBeNull()
  expect(panel.globalPreferences.value[0].content).toBe('draft')
  preferencesApi.delete = async () => { throw new Error('retry me') }
  expect(await panel.deletePreference('original')).toBe(false)
  expect(panel.globalPreferences.value).toHaveLength(1)
  preferencesApi.delete = async () => true
  expect(await panel.deletePreference('original')).toBe(true)
  expect(panel.preferences.value).toEqual([])
})

test('add is repeat-click guarded, pinned to loaded context and does not depend on a second GET', async () => {
  const pending = deferred<Preference>()
  preferencesApi.list = async () => state('/a')
  const panel = usePreferences()
  await panel.loadPreferences('/a')
  setApiDirectory('/b')
  let calls = 0
  preferencesApi.add = async (_content, _scope, _source, directory) => {
    calls++
    expect(directory).toBe('/a')
    return pending.promise
  }
  preferencesApi.list = async () => { throw new Error('a successful write must not be reported as failure by reloading') }
  const write = panel.addPreference('saved', 'project')
  expect(await panel.addPreference('saved', 'project')).toBeNull()
  pending.resolve(record('saved', 'project'))
  expect(await write).toBeTruthy()
  expect(calls).toBe(1)
  expect(panel.projectPreferences.value).toHaveLength(1)
  expect(panel.error.value).toBeNull()
})

test('legacy records are shown separately and assigning moves only the selected record', async () => {
  preferencesApi.list = async () => ({ ...state('/a'), unresolved: [{ ...record('legacy', 'project'), projectID: undefined }] })
  preferencesApi.assign = async (_id, directory) => { expect(directory).toBe('/a'); return record('legacy', 'project') }
  const panel = usePreferences()
  await panel.loadPreferences('/a')
  expect(panel.preferences.value).toEqual([])
  expect(panel.unresolvedPreferences.value).toHaveLength(1)
  expect(await panel.assignPreference('legacy')).toBe(true)
  expect(panel.unresolvedPreferences.value).toEqual([])
  expect(panel.projectPreferences.value).toHaveLength(1)
})

test('component retains drafts and delete confirmation until mutations succeed', async () => {
  const source = await Bun.file(new URL('../src/components/PreferencesPanel.vue', import.meta.url)).text()
  expect(source).toContain("if (saved && newContent.value === content) newContent.value = ''")
  expect(source).toContain('if (await deletePreference(deletingId.value)) deletingId.value = null')
  expect(source).toContain('loading || !!newContent.trim() || !!editingId || !!deletingId')
  expect(source).toContain('maxlength="4096"')
  expect(source).toContain('当前项目：{{ directory }}')
})
