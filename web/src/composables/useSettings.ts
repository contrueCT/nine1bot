import { ref, computed } from 'vue'
import { providerApi, configApi, mcpApi, skillApi, authApi, nine1botConfigApi, customProviderApi, importAuthFromOpencode as importAuthFromOpencodeApi } from '../api/client'
import type { Provider, McpServer, Skill, Config, McpConfig, CustomProvider, AuthImportResult } from '../api/client'
import { authenticateMcpWithPopup } from '../utils/mcp-auth'

const showSettings = ref(false)
const activeTab = ref<'models' | 'mcp' | 'skills' | 'auth' | 'preferences' | 'profile'>('models')

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

// Config
const config = ref<Config>({})

// Nine1Bot 默认模型（持久化在 nine1bot.config.jsonc）
const defaultProvider = ref<string>('')
const defaultModel = ref<string>('')

export function useSettings() {
  function openSettings() {
    showSettings.value = true
    authImportResult.value = null
    loadCustomProviders().then(() => loadProviders())
    loadMcpServers()
    loadSkills()
    loadConfig()
    loadNine1botConfig()
  }

  function closeSettings() {
    showSettings.value = false
  }

  async function loadProviders() {
    loadingProviders.value = true
    try {
      // 并行获取 providers 和 auth methods
      const [providerData, authMethods, authedProviderIds] = await Promise.all([
        providerApi.list(),
        providerApi.getAuthMethods().catch(() => ({} as Record<string, any[]>)),
        authApi.list().catch(() => [])
      ])
      const authSet = new Set(authedProviderIds)

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
    } finally {
      loadingProviders.value = false
    }
  }

  async function loadMcpServers() {
    loadingMcp.value = true
    try {
      mcpServers.value = await mcpApi.list()
    } catch (e) {
      console.error('Failed to load MCP servers:', e)
    } finally {
      loadingMcp.value = false
    }
  }

  async function loadSkills() {
    loadingSkills.value = true
    try {
      skills.value = await skillApi.list()
    } catch (e) {
      console.error('Failed to load skills:', e)
    } finally {
      loadingSkills.value = false
    }
  }

  async function loadConfig() {
    try {
      config.value = await configApi.get()
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
    try {
      // 后端期望 model 格式为 "provider/model"
      const modelStr = `${providerId}/${modelId}`
      await configApi.update({ model: modelStr })
      currentProvider.value = providerId
      currentModel.value = modelId
    } catch (e) {
      console.error('Failed to update model:', e)
    }
  }

  async function connectMcp(name: string) {
    try {
      await mcpApi.connect(name)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to connect MCP:', e)
    }
  }

  async function disconnectMcp(name: string) {
    try {
      await mcpApi.disconnect(name)
      await loadMcpServers()
    } catch (e) {
      console.error('Failed to disconnect MCP:', e)
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
    }
  }

  async function setApiKey(providerId: string, apiKey: string) {
    try {
      await authApi.setApiKey(providerId, apiKey)
      await loadProviders()
    } catch (e) {
      console.error('Failed to set API key:', e)
    }
  }

  async function removeAuth(providerId: string) {
    try {
      await authApi.remove(providerId)
      await loadProviders()
    } catch (e) {
      console.error('Failed to remove auth:', e)
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
      await nine1botConfigApi.update({ customProviders: list })
    } catch (e) {
      console.error('Failed to load custom providers:', e)
      customProviders.value = {}
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
    try {
      const data = await nine1botConfigApi.get()
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
    try {
      const modelStr = `${providerId}/${modelId}`
      await nine1botConfigApi.update({ model: modelStr })
      defaultProvider.value = providerId
      defaultModel.value = modelId
    } catch (e) {
      console.error('Failed to set default model:', e)
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
    config,
    openSettings,
    closeSettings,
    loadProviders,
    loadCustomProviders,
    loadConfig,
    loadNine1botConfig,
    loadMcpServers,
    loadSkills,
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
