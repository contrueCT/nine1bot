import { afterEach, describe, expect, it } from 'bun:test'
import { api, authApi, configApi, customProviderApi, mcpApi, nine1botConfigApi, permissionApi, platformApi, providerApi, questionApi, setApiDirectory, type Session } from '../src/api/client'
import { getComposerDraft } from '../src/composables/composer-drafts'
import { useSession } from '../src/composables/useSession'
import { useSettings } from '../src/composables/useSettings'
import { useFiles } from '../src/composables/useFiles'

const originals = [api, authApi, configApi, customProviderApi, mcpApi, nine1botConfigApi, permissionApi, platformApi, providerApi, questionApi].map(object => [object, { ...object }] as const)
const originalFetch = globalThis.fetch
let current: ReturnType<typeof useSession> | undefined
afterEach(() => {
  current?.unsubscribe()
  current = undefined
  for (const [object, methods] of originals) Object.assign(object, methods)
  globalThis.fetch = originalFetch
  setApiDirectory('')
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const session = (id: string): Session => ({ id, title: id, directory: `/workspace/${id}`, time: { created: 1, updated: 1 } })
function setupSession() {
  api.subscribeSessionRuntimeEvents = () => ({ ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 })
  api.getMessages = async () => []
  api.getSessions = async () => []
  api.getSessionStatus = async () => ({})
  permissionApi.list = async () => []
  questionApi.list = async () => []
  current = useSession()
  return current
}

describe('chat and settings reliability', () => {
  it('retains a busy conversation and displays the backend deletion failure', async () => {
    const state = setupSession()
    state.sessions.value = [session('A')]
    await state.selectSession(session('A'))
    api.deleteSession = async () => { throw new Error('会话正在运行，请先停止任务再删除') }
    await expect(state.deleteSession('A')).rejects.toThrow('请先停止')
    expect(state.sessions.value).toHaveLength(1)
    expect(state.currentSession.value?.id).toBe('A')
    expect(state.sessionNotifications.value.at(-1)?.message).toContain('请先停止')
  })

  it('does not overwrite a newer edit after navigating A to B and back to A', async () => {
    const state = setupSession()
    const msg = () => ({ info: { id: 'm', sessionID: 'A', role: 'user' as const, time: { created: 1 } }, parts: [{ id: 'p', type: 'text' as const, text: 'original' }] })
    api.getMessages = async (id) => id === 'A' ? [msg()] : []
    await state.selectSession(session('A'))
    const old = deferred<any>()
    api.updateMessagePart = () => old.promise
    const pending = state.updateMessagePart('m', 'p', { text: 'old edit' })
    await state.selectSession(session('B'))
    await state.selectSession(session('A'))
    api.updateMessagePart = async () => ({ id: 'p', type: 'text', text: 'new acknowledged edit' })
    await state.updateMessagePart('m', 'p', { text: 'new acknowledged edit' })
    old.resolve({ id: 'p', type: 'text', text: 'old edit' })
    await pending
    expect(state.messages.value[0].parts[0].text).toBe('new acknowledged edit')
  })

  it('does not apply a stale delete response after returning to the same session', async () => {
    const state = setupSession()
    api.getMessages = async (id) => id === 'A' ? [{ info: { id: 'm', sessionID: 'A', role: 'user', time: { created: 1 } }, parts: [{ id: 'p', type: 'text', text: 'restored content' }] }] : []
    await state.selectSession(session('A'))
    const old = deferred<boolean>()
    api.deleteMessagePart = () => old.promise
    const pending = state.deleteMessagePart('m', 'p')
    await state.selectSession(session('B'))
    await state.selectSession(session('A'))
    old.resolve(true)
    await pending
    expect(state.messages.value[0].parts[0].text).toBe('restored content')
  })

  it('updates titles from events for current, background and draft-mode conversations', async () => {
    const state = setupSession()
    let receive!: Parameters<typeof api.subscribeEvents>[0]
    api.subscribeEvents = handler => {
      receive = handler
      return { ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 }
    }
    state.sessions.value = [session('A'), session('B')]
    await state.selectSession(session('A'))
    state.subscribeToEvents()
    receive({ type: 'session.updated', properties: { info: { ...session('A'), title: '自动生成标题' } } })
    expect(state.currentSession.value?.title).toBe('自动生成标题')
    expect(state.sessions.value[0].title).toBe('自动生成标题')
    receive({ type: 'session.updated', properties: { info: { ...session('B'), title: '后台会话标题' } } })
    expect(state.currentSession.value?.id).toBe('A')
    expect(state.currentSession.value?.title).toBe('自动生成标题')
    expect(state.sessions.value[1].title).toBe('后台会话标题')
    state.createSession('/workspace/draft')
    receive({ type: 'session.updated', properties: { info: { ...session('A'), title: '草稿期间更新' } } })
    expect(state.currentSession.value).toBeNull()
    expect(state.sessions.value[0].title).toBe('草稿期间更新')
  })

  it('never sends a pending draft to the session selected while creation was in flight', async () => {
    const state = setupSession()
    const created = deferred<Session>()
    api.createSession = () => created.promise
    let sends = 0
    api.sendMessage = async () => { sends++; return { accepted: true, sessionId: 'wrong' } }
    state.createSession('/workspace/A')
    const sending = state.sendMessage('for A')
    await new Promise(resolve => setTimeout(resolve, 0))
    await state.selectSession(session('B'))
    created.resolve(session('A'))
    expect(await sending).toBe(false)
    expect(sends).toBe(0)
    expect(state.currentSession.value?.id).toBe('B')
  })

  it('shares an in-flight session creation between upload and send', async () => {
    const state = setupSession()
    const created = deferred<Session>()
    let creates = 0
    api.createSession = () => { creates++; return created.promise }
    state.createSession('/workspace/A')
    const first = state.ensureSession()
    const second = state.ensureSession()
    created.resolve(session('A'))
    expect((await first)?.id).toBe('A')
    expect((await second)?.id).toBe('A')
    expect(creates).toBe(1)
  })

  it('reuses pending creation when returning to the same unsent draft', async () => {
    const state = setupSession()
    const created = deferred<Session>()
    let creates = 0
    api.createSession = () => { creates++; return created.promise }
    state.createSession('/workspace/A')
    const originalDraft = state.composerKey.value
    getComposerDraft(originalDraft).text = 'unsent A'
    const first = state.ensureSession()
    await state.selectSession(session('B'))
    state.createSession('/workspace/A')
    const second = state.ensureSession()
    created.resolve(session('A'))
    await Promise.all([first, second])
    expect(creates).toBe(1)
    expect(state.currentSession.value?.id).toBe('A')
    expect(getComposerDraft(state.composerKey.value).text).toBe('unsent A')
    state.clearDrafts()
  })

  it('shows history before a slow auxiliary request and keeps it when that request fails', async () => {
    const state = setupSession()
    const permissions = deferred<any>()
    permissionApi.list = () => permissions.promise.then(() => { throw new Error('offline') })
    api.getMessages = async () => [{ info: { id: 'm', role: 'user', sessionID: 'A', time: { created: 1 } }, parts: [] }]
    const loading = state.selectSession(session('A'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.messages.value).toHaveLength(1)
    expect(state.isLoading.value).toBe(false)
    permissions.resolve(null)
    await loading
    expect(state.messages.value).toHaveLength(1)
    expect(state.historyError.value).toContain('权限请求')
  })

  it('rejects HTTP failures instead of returning empty history or confirming a saved model', async () => {
    globalThis.fetch = async () => Response.json({ error: 'service unavailable' }, { status: 503 })
    await expect(api.getMessages('A')).rejects.toThrow('service unavailable')
    await expect(configApi.update({ model: 'p/a' })).rejects.toThrow('service unavailable')
    const settings = useSettings()
    settings.defaultModel.value = 'previous'
    expect(await settings.setDefaultModel('p', 'new')).toBe(false)
    expect(settings.defaultModel.value).toBe('previous')
    expect(settings.settingsError.value).toBe('service unavailable')
  })

  it('loads custom providers without writing configuration', async () => {
    customProviderApi.list = async () => ({})
    let writes = 0
    nine1botConfigApi.update = async () => { writes++ }
    await useSettings().loadCustomProviders()
    expect(writes).toBe(0)
  })

  it('loads only the active settings category and reuses its data for the provider subpage', async () => {
    setApiDirectory('/settings-read-only-test')
    let providerLoads = 0
    let mcpLoads = 0
    let writes = 0
    customProviderApi.list = async () => ({})
    providerApi.list = async () => { providerLoads++; return { providers: [], connected: [], defaults: {} } }
    providerApi.getAuthMethods = async () => ({})
    authApi.list = async () => []
    configApi.get = async () => ({})
    nine1botConfigApi.get = async () => ({ configPath: '' })
    nine1botConfigApi.update = async () => { writes++ }
    mcpApi.list = async () => { mcpLoads++; return [] }
    const settings = useSettings()
    settings.platformError.value = ''
    await settings.loadSettingsTab('models', true)
    await settings.loadSettingsTab('auth')
    expect(providerLoads).toBe(1)
    expect(mcpLoads).toBe(0)
    expect(writes).toBe(0)
    await settings.loadSettingsTab('mcp')
    expect(mcpLoads).toBe(1)
  })

  it('returns to an unsent draft after visiting an existing conversation', async () => {
    const state = setupSession()
    state.createSession('/workspace/A')
    getComposerDraft(state.composerKey.value).text = 'keep this draft'
    await state.selectSession(session('B'))
    state.createSession('/workspace/A')
    expect(getComposerDraft(state.composerKey.value).text).toBe('keep this draft')
    state.clearDrafts()
  })

  it('rejects failed MCP connections and API key writes', async () => {
    globalThis.fetch = async () => Response.json({ error: 'offline' }, { status: 500 })
    await expect(mcpApi.connect('server')).rejects.toThrow('offline')
    await expect(mcpApi.disconnect('server')).rejects.toThrow('offline')
    await expect(authApi.setApiKey('provider', 'test-key')).rejects.toThrow('offline')
  })

  it('ignores a previous platform response after another platform was selected', async () => {
    const older = deferred<any>()
    platformApi.get = id => id === 'A' ? older.promise : Promise.resolve({ id: 'B' } as any)
    const settings = useSettings()
    const first = settings.loadPlatformDetail('A')
    await settings.loadPlatformDetail('B')
    older.resolve({ id: 'A' })
    await first
    expect(settings.selectedPlatformId.value).toBe('B')
    expect(settings.selectedPlatform.value?.id).toBe('B')
  })

  it('serializes model writes so the last choice is also the last server write', async () => {
    const firstWrite = deferred<any>()
    const writes: string[] = []
    configApi.update = async config => { writes.push(config.model!); if (config.model === 'p/A') await firstWrite.promise; return config }
    const settings = useSettings()
    const first = settings.selectModel('p', 'A')
    const second = settings.selectModel('p', 'B')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual(['p/A'])
    firstWrite.resolve({})
    await Promise.all([first, second])
    expect(writes).toEqual(['p/A', 'p/B'])
    expect(settings.currentModel.value).toBe('B')
  })

  it('invalidates pending file and search responses when cleared', async () => {
    const files = useFiles()
    const search = deferred<any>()
    const content = deferred<any>()
    api.searchFiles = () => search.promise
    api.getFileContent = () => content.promise
    const searching = files.searchFiles('old')
    const loading = files.loadFileContent('old')
    files.clearSearch()
    files.clearFileContent()
    search.resolve([{ path: 'old' }])
    content.resolve({ content: 'old' })
    await Promise.all([searching, loading])
    expect(files.searchResults.value).toEqual([])
    expect(files.fileContent.value).toBeNull()
    expect(files.isSearching.value).toBe(false)
    expect(files.isLoadingContent.value).toBe(false)
  })
})
