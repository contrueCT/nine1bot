import { ref, computed } from 'vue'
import { getApiDirectory } from '../api/client'
import { providerApi, configApi, mcpApi, skillApi, authApi, nine1botConfigApi, customProviderApi, platformApi, importAuthFromOpencode as importAuthFromOpencodeApi } from '../api/client'
import type { Provider, McpServer, Skill, Config, McpConfig, CustomProvider, AuthImportResult, PlatformSummary, PlatformDetail, PlatformConfigPatch, PlatformActionResult } from '../api/client'
import { authenticateMcpWithPopup } from '../utils/mcp-auth'

const showSettings = ref(false)
const activeTab = ref<'models' | 'mcp' | 'skills' | 'auth' | 'preferences' | 'platforms' | 'profile' | 'about' | 'browser'>('models')

// Providers and models
const providers = ref<Provider[]>([])
const providerDefaults = ref<Record<string, string>>({})
const connectedProviders = ref<string[]>([])
const currentProvider = ref<string>('')
const currentModel = ref<string>('')
const loadingProviders = ref(false)
const importingAuth = ref(false)
const providerSearchQuery = ref('')
const customProviders = ref<Record<string, CustomProvider>>({})
const authImportResult = ref<AuthImportResult | null>(null)

// 供应商优先级（热门供应商排在前面）
const PROVIDER_PRIORITY: Record<string, number> = {
  anthropic: 1,
  openai: 2,
  google: 3,
  'github-copilot': 4,
  openrouter: 5,
}

// MCP servers
const mcpServers = ref<McpServer[]>([])
const loadingMcp = ref(false)

// Skills
const skills = ref<Skill[]>([])
const loadingSkills = ref(false)

// Platform adapters
const platforms = ref<PlatformSummary[]>([])
const selectedPlatformId = ref<string>('')
const selectedPlatform = ref<PlatformDetail | null>(null)
const loadingPlatforms = ref(false)
const savingPlatform = ref(false)
const platformActionRunning = ref<string>('')
const platformError = ref('')
const platformActionResult = ref<PlatformActionResult | null>(null)

// Config
const config = ref<Config>({})

// Nine1Bot 默认模型（持久化在 nine1bot.config.jsonc）
const defaultProvider = ref<string>('')
const defaultModel = ref<string>('')
const settingsError = ref('')
const savingModel = ref(false)
let platformRequest = 0
let providerRequest = 0
let configRequest = 0
let modelRequest = 0
let defaultModelRequest = 0
let modelQueue: Promise<unknown> = Promise.resolve()
let defaultModelQueue: Promise<unknown> = Promise.resolve()
const tabRequests = new Map<string, Promise<void>>()
const tabLoadedAt = new Map<string, number>()
let settingsDirectory = ''

function reportSettingsError(error: unknown) {
  settingsError.value = error instanceof Error ? error.message : '操作失败，请重试'
}

export function useSettings() {
  function openSettings() {
    showSettings.value = true
    settingsError.value = ''
    authImportResult.value = null
    void loadSettingsTab(activeTab.value)
  }

  async function loadSettingsTab(tab = activeTab.value, force = false) {
    const directory = getApiDirectory()
    if (settingsDirectory !== directory) {
      tabLoadedAt.clear()
      settingsDirectory = directory
    }
    const section = tab === 'auth' ? 'models' : tab
    const key = `${directory}\u0000${section}`
    const pending = tabRequests.get(key)
    if (pending) return pending
    if (!force && Date.now() - (tabLoadedAt.get(key) || 0) < 30000) return
    settingsError.value = ''
    const request = (async () => {
      if (section === 'models') {
        await Promise.all([loadCustomProviders().then(loadProviders), loadConfig(), loadNine1botConfig()])
      } else if (section === 'mcp') await loadMcpServers()
      else if (section === 'skills') await loadSkills()
      else if (section === 'platforms') await Promise.all([loadPlatforms(), loadProviders()])
      if (!settingsError.value && !platformError.value) tabLoadedAt.set(key, Date.now())
    })().finally(() => tabRequests.delete(key))
    tabRequests.set(key, request)
    return request
  }

  function closeSettings() {
    showSettings.value = false
  }

  async function loadProviders() {
    const request = ++providerRequest
    const directory = getApiDirectory()
    loadingProviders.value = true
    try {
      // 并行获取 providers 和 auth methods
      const [providerData, authMethods, authedProviderIds] = await Promise.all([
        providerApi.list(),
        providerApi.getAuthMethods().catch(() => ({} as Record<string, any[]>)),
        authApi.list().catch(() => [])
      ])
      if (request !== providerRequest || directory !== getApiDirectory()) return
      const authSet = new Set([...authedProviderIds, ...providerData.connected])

      // 保存 defaults 和 connected
      providerDefaults.value = providerData.defaults
      connectedProviders.value = providerData.connected

      // 合并 authMethods 到 providers，为没有 authMethods 的供应商添加默认的 API Key 方法
      providers.value = providerData.providers.map(p => {
        const methods = authMethods[p.id]?.map((m: any) => ({
          type: m.type === 'apiKey' ? 'api' : m.type,
          name: m.name
        })) || []

        // 如果没有认证方法，默认添加 API Key（几乎所有供应商都支持）
        if (methods.length === 0) {
          methods.push({ type: 'api', name: 'API Key' })
        }

        return {
          ...p,
          authenticated: authSet.has(p.id),
          authMethods: methods,
          isCustom: p.id in customProviders.value,
        }
      })
    } catch (e) {
      console.error('Failed to load providers:', e)
      if (request === providerRequest) reportSettingsError(e)
    } finally {
      if (request === providerRequest) loadingProviders.value = false
    }
  }

  async function loadMcpServers() {
    const directory = getApiDirectory()
    loadingMcp.value = true
    try {
      const loaded = await mcpApi.list()
      if (directory === getApiDirectory()) mcpServers.value = loaded
    } catch (e) {
      console.error('Failed to load MCP servers:', e)
      reportSettingsError(e)
    } finally {
      loadingMcp.value = false
    }
  }

  async function loadSkills() {
    const directory = getApiDirectory()
    loadingSkills.value = true
    try {
      const loaded = await skillApi.list()
      if (directory === getApiDirectory()) skills.value = loaded
    } catch (e) {
      console.error('Failed to load skills:', e)
      reportSettingsError(e)
    } finally {
      loadingSkills.value = false
    }
  }

  async function loadPlatforms() {
    loadingPlatforms.value = true
    platformError.value = ''
    try {
      platforms.value = await platformApi.list()
      const selectedStillExists = platforms.value.some((platform) => platform.id === selectedPlatformId.value)
      if (platforms.value.length === 0) {
        selectedPlatformId.value = ''
        selectedPlatform.value = null
        return
      }
      if (!selectedPlatformId.value || !selectedStillExists) {
        selectedPlatformId.value = platforms.value[0].id
      }
      await loadPlatformDetail(selectedPlatformId.value)
    } catch (e: any) {
      console.error('Failed to load platforms:', e)
      platformError.value = e?.message || '加载平台适配失败'
      platforms.value = []
      selectedPlatformId.value = ''
      selectedPlatform.value = null
    } finally {
      loadingPlatforms.value = false
    }
  }

  async function loadPlatformDetail(id: string) {
    const request = ++platformRequest
    const directory = getApiDirectory()
    platformError.value = ''
    selectedPlatformId.value = id
    selectedPlatform.value = null
    try {
      const detail = await platformApi.get(id)
      if (request === platformRequest && directory === getApiDirectory()) selectedPlatform.value = detail
    } catch (e: any) {
      if (request !== platformRequest || directory !== getApiDirectory()) return
      console.error('Failed to load platform detail:', e)
      platformError.value = e?.message || '加载平台详情失败'
      selectedPlatform.value = null
    }
  }

  async function updatePlatform(id: string, patch: PlatformConfigPatch) {
    savingPlatform.value = true
    platformError.value = ''
    try {
      const updated = await platformApi.update(id, patch)
      if (selectedPlatformId.value === id) selectedPlatform.value = updated
      platforms.value = await platformApi.list()
    } catch (e: any) {
      console.error('Failed to update platform:', e)
      platformError.value = e?.message || '保存平台配置失败'
      throw e
    } finally {
      savingPlatform.value = false
    }
  }

  async function refreshPlatformStatus(id: string) {
    platformActionRunning.value = 'health'
    platformError.value = ''
    try {
      const result = await platformApi.health(id)
      if (result.platform && selectedPlatformId.value === id) selectedPlatform.value = result.platform
      platforms.value = await platformApi.list()
    } catch (e: any) {
      console.error('Failed to refresh platform status:', e)
      platformError.value = e?.message || '刷新平台状态失败'
      throw e
    } finally {
      platformActionRunning.value = ''
    }
  }

  async function executePlatformAction(id: string, actionId: string, input?: unknown, confirm?: boolean) {
    platformActionRunning.value = actionId
    platformActionResult.value = null
    platformError.value = ''
    try {
      platformActionResult.value = await platformApi.action(id, actionId, { input, confirm })
      if (platformActionResult.value.openUrl) {
        window.open(platformActionResult.value.openUrl, '_blank', 'noopener,noreferrer')
      }
      await loadPlatformDetail(id)
      platforms.value = await platformApi.list()
      return platformActionResult.value
    } catch (e: any) {
      console.error('Failed to execute platform action:', e)
      platformError.value = e?.message || '执行平台操作失败'
      throw e
    } finally {
      platformActionRunning.value = ''
    }
  }

  async function loadConfig() {
    const request = ++configRequest
    const directory = getApiDirectory()
    const modelVersion = modelRequest
    try {
      const loaded = await configApi.get()
      if (request !== configRequest || directory !== getApiDirectory() || modelVersion !== modelRequest) return
      config.value = loaded
      // 后端的 model 格式是 "provider/model"
      let modelStr = config.value.model || ''

      // 如果没有配置模型，尝试使用第一个已连接的 provider 的默认模型
      if (!modelStr && connectedProviders.value.length > 0) {
        const firstConnected = connectedProviders.value[0]
        const defaultModel = providerDefaults.value[firstConnected]
        if (defaultModel) {
          modelStr = `${firstConnected}/${defaultModel}`
        }
      }

      if (modelStr.includes('/')) {
        const [provider, ...modelParts] = modelStr.split('/')
        currentProvider.value = provider
        currentModel.value = modelParts.join('/')
      } else {
        currentProvider.value = ''
        currentModel.value = modelStr
      }
    } catch (e) {
      console.error('Failed to load config:', e)
    }
  }

  async function selectModel(providerId: string, modelId: string) {
    const request = ++modelRequest
    const directory = getApiDirectory()
    savingModel.value = true
    settingsError.value = ''
    const save = modelQueue.catch(() => {}).then(() => configApi.update({ model: `${providerId}/${modelId}` }, directory))
    modelQueue = save
    try {
      await save
      if (request === modelRequest && directory === getApiDirectory()) {
        currentProvider.value = providerId
        currentModel.value = modelId
      }
      return true
    } catch (e) {
      if (request === modelRequest) reportSettingsError(e)
      return false
    } finally {
      if (request === modelRequest) savingModel.value = false
    }
  }

  async function connectMcp(name: string) {
    try {
      await mcpApi.connect(name)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to connect MCP:', e)
      throw e
    }
  }

  async function disconnectMcp(name: string) {
    try {
      await mcpApi.disconnect(name)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to disconnect MCP:', e)
      throw e
    }
  }

  async function addMcp(name: string, config: McpConfig) {
    try {
      await mcpApi.add(name, config)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to add MCP:', e)
      throw e
    }
  }

  async function removeMcp(name: string) {
    try {
      await mcpApi.remove(name)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to remove MCP:', e)
      throw e
    }
  }

  async function authenticateMcp(name: string) {
    try {
      await authenticateMcpWithPopup(name, {
        onUpdate: (servers) => {
          mcpServers.value = servers
        },
      })
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to authenticate MCP:', e)
      throw e
    }
  }

  async function startOAuth(providerId: string) {
    try {
      const { url } = await providerApi.startOAuth(providerId)
      window.open(url, '_blank', 'width=600,height=700')
    } catch (e) {
      console.error('Failed to start OAuth:', e)
      throw e
    }
  }

  async function setApiKey(providerId: string, apiKey: string) {
    settingsError.value = ''
    try {
      await authApi.setApiKey(providerId, apiKey)
      await loadProviders()
      return true
    } catch (e) {
      reportSettingsError(e)
      return false
    }
  }

  async function removeAuth(providerId: string) {
    try {
      await authApi.remove(providerId)
      await loadProviders()
    } catch (e) {
      console.error('Failed to remove auth:', e)
      reportSettingsError(e)
    }
  }

  async function importAuthFromOpencode() {
    importingAuth.value = true
    try {
      authImportResult.value = null
      authImportResult.value = await importAuthFromOpencodeApi()
      await loadProviders()
    } catch (e) {
      console.error('Failed to import auth from OpenCode:', e)
      throw e
    } finally {
      importingAuth.value = false
    }
  }

  async function loadCustomProviders() {
    try {
      const list = await customProviderApi.list()
      customProviders.value = list
    } catch (e) {
      console.error('Failed to load custom providers:', e)
      reportSettingsError(e)
    }
  }

  async function upsertCustomProvider(providerId: string, provider: CustomProvider) {
    await customProviderApi.upsert(providerId, provider)
    await loadCustomProviders()
    await loadProviders()
  }

  async function removeCustomProvider(providerId: string) {
    await customProviderApi.remove(providerId)
    await loadCustomProviders()
    await loadProviders()
  }

  async function healthMcp(name: string) {
    try {
      await mcpApi.health(name)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to run MCP health check:', e)
      throw e
    }
  }

  async function loadNine1botConfig() {
    const version = defaultModelRequest
    try {
      const data = await nine1botConfigApi.get()
      if (version !== defaultModelRequest) return
      const modelStr = data.model || ''
      if (modelStr.includes('/')) {
        const [provider, ...modelParts] = modelStr.split('/')
        defaultProvider.value = provider
        defaultModel.value = modelParts.join('/')
      } else {
        defaultProvider.value = ''
        defaultModel.value = modelStr
      }
    } catch (e) {
      console.error('Failed to load nine1bot config:', e)
    }
  }

  async function setDefaultModel(providerId: string, modelId: string) {
    const request = ++defaultModelRequest
    settingsError.value = ''
    const save = defaultModelQueue.catch(() => {}).then(() => nine1botConfigApi.update({ model: `${providerId}/${modelId}` }))
    defaultModelQueue = save
    try {
      await save
      if (request === defaultModelRequest) {
        defaultProvider.value = providerId
        defaultModel.value = modelId
      }
      return true
    } catch (e) {
      if (request === defaultModelRequest) reportSettingsError(e)
      return false
    }
  }

  // 过滤并排序后的供应商
  const filteredProviders = computed(() => {
    const query = providerSearchQuery.value.toLowerCase().trim()
    let list = providers.value

    if (query) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query)
      )
    }

    // 已认证的供应商排前面，同认证状态内按优先级排序
    return [...list].sort((a, b) => {
      if (a.authenticated !== b.authenticated) {
        return a.authenticated ? -1 : 1
      }
      const pa = PROVIDER_PRIORITY[a.id] ?? 99
      const pb = PROVIDER_PRIORITY[b.id] ?? 99
      if (pa !== pb) return pa - pb
      return a.name.localeCompare(b.name)
    })
  })

  // 模型页面使用：不受搜索词影响，但保持“已认证优先 + 优先级排序”
  const modelProviders = computed(() => {
    return [...providers.value].sort((a, b) => {
      if (a.authenticated !== b.authenticated) {
        return a.authenticated ? -1 : 1
      }
      const pa = PROVIDER_PRIORITY[a.id] ?? 99
      const pb = PROVIDER_PRIORITY[b.id] ?? 99
      if (pa !== pb) return pa - pb
      return a.name.localeCompare(b.name)
    })
  })

  return {
    loadSettingsTab,
    settingsError,
    savingModel,
    showSettings,
    activeTab,
    providers,
    modelProviders,
    filteredProviders,
    providerSearchQuery,
    customProviders,
    currentProvider,
    currentModel,
    defaultProvider,
    defaultModel,
    loadingProviders,
    importingAuth,
    authImportResult,
    mcpServers,
    loadingMcp,
    skills,
    loadingSkills,
    platforms,
    selectedPlatformId,
    selectedPlatform,
    loadingPlatforms,
    savingPlatform,
    platformActionRunning,
    platformError,
    platformActionResult,
    config,
    openSettings,
    closeSettings,
    loadProviders,
    loadCustomProviders,
    loadConfig,
    loadNine1botConfig,
    loadMcpServers,
    loadSkills,
    loadPlatforms,
    loadPlatformDetail,
    updatePlatform,
    refreshPlatformStatus,
    executePlatformAction,
    selectModel,
    setDefaultModel,
    connectMcp,
    authenticateMcp,
    disconnectMcp,
    addMcp,
    removeMcp,
    healthMcp,

    startOAuth,
    setApiKey,
    removeAuth,
    importAuthFromOpencode,
    upsertCustomProvider,
    removeCustomProvider
  }
}
