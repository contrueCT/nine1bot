import { ref } from 'vue'
import { providerApi, configApi, mcpApi, skillApi, authApi } from '../api/client'
import type { Provider, McpServer, Skill, Config } from '../api/client'

const showSettings = ref(false)
const activeTab = ref<'models' | 'mcp' | 'skills' | 'auth'>('models')

// Providers and models
const providers = ref<Provider[]>([])
const providerDefaults = ref<Record<string, string>>({})
const connectedProviders = ref<string[]>([])
const currentProvider = ref<string>('')
const currentModel = ref<string>('')
const loadingProviders = ref(false)

// MCP servers
const mcpServers = ref<McpServer[]>([])
const loadingMcp = ref(false)

// Skills
const skills = ref<Skill[]>([])
const loadingSkills = ref(false)

// Config
const config = ref<Config>({})

export function useSettings() {
  function openSettings() {
    showSettings.value = true
    loadProviders()
    loadMcpServers()
    loadSkills()
    loadConfig()
  }

  function closeSettings() {
    showSettings.value = false
  }

  async function loadProviders() {
    loadingProviders.value = true
    try {
      // 并行获取 providers 和 auth methods
      const [providerData, authMethods] = await Promise.all([
        providerApi.list(),
        providerApi.getAuthMethods().catch(() => ({} as Record<string, any[]>))
      ])

      // 保存 defaults 和 connected
      providerDefaults.value = providerData.defaults
      connectedProviders.value = providerData.connected

      // 合并 authMethods 到 providers
      providers.value = providerData.providers.map(p => ({
        ...p,
        authMethods: authMethods[p.id]?.map((m: any) => ({
          type: m.type,
          name: m.name
        })) || []
      }))
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

  return {
    showSettings,
    activeTab,
    providers,
    currentProvider,
    currentModel,
    loadingProviders,
    mcpServers,
    loadingMcp,
    skills,
    loadingSkills,
    config,
    openSettings,
    closeSettings,
    loadProviders,
    loadConfig,
    loadMcpServers,
    loadSkills,
    selectModel,
    connectMcp,
    disconnectMcp,
    startOAuth,
    setApiKey,
    removeAuth
  }
}
