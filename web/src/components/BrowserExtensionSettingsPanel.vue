<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { CheckCircle2, Link2, Server, Sparkles, Wrench, X } from 'lucide-vue-next'
import {
  mcpApi,
  nine1botConfigApi,
  platformApi,
  providerApi,
  skillApi,
  type BrowserExtensionConfig,
  type McpServer,
  type PlatformToolSummary,
  type Provider,
  type Skill,
} from '../api/client'
import { getTrustedExtensionParentContext, isTrustedExtensionParentEvent } from '../utils/extension-parent'
import { platformToolRows } from '../utils/platform-tool-catalog'
import { platformSettingsUrl } from '../utils/settings-deeplink'

const emit = defineEmits<{
  close: []
}>()

type SettingsTab = 'models' | 'prompt' | 'mcp' | 'skills' | 'tools' | 'relay'

interface BrowserRelaySettings {
  origin: string
  bootstrapUrl: string
  extensionUrl: string
  serverReachable: boolean
  relayConnected: boolean
  message?: string
}

const activeTab = ref<SettingsTab>('models')
const loading = ref(true)
const saving = ref(false)
const statusMessage = ref('')
const statusTone = ref<'neutral' | 'success' | 'error'>('neutral')

const providers = ref<Provider[]>([])
const mcpServers = ref<McpServer[]>([])
const skills = ref<Skill[]>([])
const platformTools = ref<PlatformToolSummary[]>([])
const config = ref<BrowserExtensionConfig>({})

const selectedModel = ref('')
const promptDraft = ref('')
const selectedMcpServers = ref<string[]>([])
const selectedSkills = ref<string[]>([])
const selectedRegisteredTools = ref<string[]>([])

const relaySettings = ref<BrowserRelaySettings>({
  origin: '',
  bootstrapUrl: '',
  extensionUrl: '',
  serverReachable: true,
  relayConnected: true,
})
const relayDraft = ref('')
const relayMessage = ref('')
const relayTone = ref<'neutral' | 'success' | 'error'>('neutral')

const pendingRelayRequests = new Map<string, {
  resolve: (value: any) => void
  reject: (reason?: unknown) => void
  timer: ReturnType<typeof setTimeout>
}>()

const sortedProviders = computed(() => [...providers.value].sort((a, b) => {
  if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1
  return (a.name || a.id).localeCompare(b.name || b.id)
}))

const enabledMcpServers = computed(() =>
  mcpServers.value.filter((server) => server.status !== 'disabled'),
)
const registeredToolRows = computed(() => platformToolRows(platformTools.value))
const staleRegisteredToolIDs = computed(() => {
  const known = new Set(registeredToolRows.value.map((tool) => tool.id))
  return selectedRegisteredTools.value.filter((toolID) => !known.has(toolID)).sort()
})

function getStatusText(status: string): string {
  switch (status) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中...'
    case 'auth_in_progress': return '授权中...'
    case 'disabled': return '已断开'
    case 'failed': return '连接失败'
    case 'needs_auth': return '需要授权'
    case 'needs_client_registration': return '需要静态客户端'
    default: return status
  }
}

const selectedModelParts = computed(() => {
  if (!selectedModel.value) return null
  const [providerID, ...modelParts] = selectedModel.value.split('/')
  const modelID = modelParts.join('/')
  return providerID && modelID ? { providerID, modelID } : null
})

function modelValue(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}

function setStatus(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
  statusMessage.value = message
  statusTone.value = tone
}

function setRelayMessage(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
  relayMessage.value = message
  relayTone.value = tone
}

function applyConfig(next: BrowserExtensionConfig) {
  config.value = next
  selectedModel.value = next.model ? modelValue(next.model.providerID, next.model.modelID) : ''
  promptDraft.value = next.prompt || ''
  selectedMcpServers.value = [...(next.mcpServers || [])]
  selectedSkills.value = [...(next.skills || [])]
  selectedRegisteredTools.value = [...(next.registeredTools || [])]
}

function applyRelaySettings(next?: BrowserRelaySettings) {
  if (!next) return
  relaySettings.value = next
  relayDraft.value = next.origin || relayDraft.value
}

function toggleValue(list: string[], value: string) {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value]
}

function toggleMcp(name: string) {
  selectedMcpServers.value = toggleValue(selectedMcpServers.value, name)
}

function toggleSkill(name: string) {
  selectedSkills.value = toggleValue(selectedSkills.value, name)
}

function toggleRegisteredTool(tool: ReturnType<typeof platformToolRows>[number]) {
  const selected = selectedRegisteredTools.value.includes(tool.id)
  if (!selected && !tool.selectable) return
  selectedRegisteredTools.value = toggleValue(selectedRegisteredTools.value, tool.id)
}

function removeStaleRegisteredTool(toolID: string) {
  selectedRegisteredTools.value = selectedRegisteredTools.value.filter((item) => item !== toolID)
}

function registeredToolStatus(tool: ReturnType<typeof platformToolRows>[number]) {
  if (tool.status === 'registered') return '可用'
  if (tool.status === 'auth-required') return '需要认证'
  if (tool.status === 'conflict') return '与当前项目工具冲突'
  if (tool.status === 'disabled') return '平台已停用'
  if (tool.status === 'error') return '状态检查失败'
  return '当前不可用'
}

function openPlatformSettings(tool: ReturnType<typeof platformToolRows>[number]) {
  if (!tool.canOpenSettings) return
  try {
    const baseUrl = relaySettings.value.origin || window.location.origin
    window.open(platformSettingsUrl(baseUrl, tool.ownerId), '_blank', 'noopener,noreferrer')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '无法打开平台设置。', 'error')
  }
}

function requestRelay(type: string, payload: Record<string, unknown> = {}) {
  const parentContext = getTrustedExtensionParentContext()
  if (!parentContext) {
    return Promise.reject(new Error('当前页面不在受信任的浏览器插件侧边栏内。'))
  }

  const requestId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRelayRequests.delete(requestId)
      reject(new Error('插件连接设置请求超时。'))
    }, 4000)
    pendingRelayRequests.set(requestId, { resolve, reject, timer })
    parentContext.parent.postMessage({ type, requestId, ...payload }, parentContext.origin)
  })
}

function handleParentMessage(event: MessageEvent) {
  if (!isTrustedExtensionParentEvent(event)) return
  const message = event.data as {
    type?: string
    requestId?: string
    settings?: BrowserRelaySettings
    ok?: boolean
    message?: string
  } | undefined
  if (!message?.type) return

  if (message.type === 'nine1bot.relayStatus') {
    applyRelaySettings(message.settings)
    return
  }

  if (!message.requestId) return
  const pending = pendingRelayRequests.get(message.requestId)
  if (!pending) return
  pendingRelayRequests.delete(message.requestId)
  clearTimeout(pending.timer)
  pending.resolve(message)
}

async function loadSettings() {
  loading.value = true
  setStatus('')
  try {
    const [browserConfig, providerResult, servers, skillList, toolList, relay] = await Promise.all([
      nine1botConfigApi.getBrowserExtension(),
      providerApi.list(),
      mcpApi.list().catch(() => [] as McpServer[]),
      skillApi.list().catch(() => [] as Skill[]),
      platformApi.tools({ templateIds: ['browser-generic'] }).catch(() => [] as PlatformToolSummary[]),
      requestRelay('nine1bot.getBrowserRelaySettings').catch(() => undefined),
    ])
    applyConfig(browserConfig)
    providers.value = providerResult.providers
    mcpServers.value = servers
    skills.value = skillList
    platformTools.value = toolList
    applyRelaySettings(relay?.settings)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载插件设置失败。', 'error')
  } finally {
    loading.value = false
  }
}

async function saveDefaults() {
  saving.value = true
  setStatus('正在保存插件默认配置...')
  try {
    const next = await nine1botConfigApi.updateBrowserExtension({
      model: selectedModelParts.value,
      prompt: promptDraft.value.trim() || null,
      mcpServers: selectedMcpServers.value,
      skills: selectedSkills.value,
      registeredTools: selectedRegisteredTools.value,
    })
    applyConfig(next)
    setStatus('插件默认配置已保存。', 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存插件默认配置失败。', 'error')
  } finally {
    saving.value = false
  }
}

async function testRelay() {
  setRelayMessage('正在测试连接...')
  try {
    const result = await requestRelay('nine1bot.testBrowserRelayOrigin', { origin: relayDraft.value })
    applyRelaySettings(result.settings)
    setRelayMessage(result.message || (result.ok ? '连接成功。' : '连接失败。'), result.ok ? 'success' : 'error')
  } catch (error) {
    setRelayMessage(error instanceof Error ? error.message : '测试连接失败。', 'error')
  }
}

async function saveRelay() {
  setRelayMessage('正在保存并重连...')
  try {
    const result = await requestRelay('nine1bot.saveBrowserRelayOrigin', { origin: relayDraft.value })
    applyRelaySettings(result.settings)
    setRelayMessage(result.message || (result.ok ? '已保存。' : '保存后仍无法连接。'), result.ok ? 'success' : 'error')
  } catch (error) {
    setRelayMessage(error instanceof Error ? error.message : '保存连接设置失败。', 'error')
  }
}

function close() {
  emit('close')
}

onMounted(() => {
  window.addEventListener('message', handleParentMessage)
  loadSettings()
})

onUnmounted(() => {
  window.removeEventListener('message', handleParentMessage)
  for (const [id, pending] of pendingRelayRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error('设置面板已关闭。'))
    pendingRelayRequests.delete(id)
  }
})
</script>

<template>
  <div class="modal-overlay" @click.self="close">
    <div class="extension-settings-modal">
      <div class="modal-header">
        <h2>设置</h2>
        <button class="close-btn" type="button" title="关闭" @click="close">
          <X :size="18" />
        </button>
      </div>

      <div class="settings-tabs">
        <button class="tab" :class="{ active: activeTab === 'models' }" type="button" @click="activeTab = 'models'">模型</button>
        <button class="tab" :class="{ active: activeTab === 'prompt' }" type="button" @click="activeTab = 'prompt'">提示词</button>
        <button class="tab" :class="{ active: activeTab === 'mcp' }" type="button" @click="activeTab = 'mcp'">MCP</button>
        <button class="tab" :class="{ active: activeTab === 'skills' }" type="button" @click="activeTab = 'skills'">技能</button>
        <button class="tab" :class="{ active: activeTab === 'tools' }" type="button" @click="activeTab = 'tools'">工具</button>
        <button class="tab" :class="{ active: activeTab === 'relay' }" type="button" @click="activeTab = 'relay'">连接</button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="loading-state">加载中...</div>

        <template v-else>
          <section v-if="activeTab === 'models'" class="settings-section">
            <h3>AI 模型</h3>
            <p>选择浏览器插件会话默认使用的模型。不设置时沿用 Nine1Bot 全局默认模型。</p>
            <button
              class="default-card"
              :class="{ active: selectedModel === '' }"
              type="button"
              @click="selectedModel = ''"
            >
              <span class="radio"></span>
              <span>
                <strong>使用 Nine1Bot 默认模型</strong>
                <small>跟随普通对话的全局模型配置</small>
              </span>
            </button>

            <div v-for="provider in sortedProviders" :key="provider.id" class="provider-section">
              <div class="provider-header">
                <div class="provider-title">
                  <span class="provider-icon"><Server :size="16" /></span>
                  <strong>{{ provider.name || provider.id }}</strong>
                </div>
                <span class="auth-badge" :class="{ ok: provider.authenticated }">
                  {{ provider.authenticated ? '已认证' : '未认证' }}
                </span>
              </div>
              <div class="model-grid">
                <button
                  v-for="model in provider.models"
                  :key="model.id"
                  class="model-card"
                  :class="{ active: selectedModel === modelValue(provider.id, model.id), disabled: !provider.authenticated }"
                  type="button"
                  :disabled="!provider.authenticated"
                  @click="selectedModel = modelValue(provider.id, model.id)"
                >
                  <span class="radio"></span>
                  <span class="model-text">
                    <strong>{{ model.name || model.id }}</strong>
                    <small v-if="selectedModel === modelValue(provider.id, model.id)">设为插件默认</small>
                  </span>
                </button>
              </div>
            </div>
          </section>

          <section v-if="activeTab === 'prompt'" class="settings-section">
            <h3>插件提示词</h3>
            <p>这段提示词只会注入浏览器插件会话，不影响普通 Web 对话。</p>
            <textarea v-model="promptDraft" placeholder="例如：回答时优先结合当前浏览器页面上下文，必要时说明你引用了哪个页面。" />
          </section>

          <section v-if="activeTab === 'mcp'" class="settings-section">
            <h3>MCP</h3>
            <p>选择浏览器插件会话默认追加的 MCP 服务器。全局认证和添加/删除仍复用 Nine1Bot 设置。</p>
            <div v-if="enabledMcpServers.length === 0" class="empty-state">暂无可用 MCP 服务器。</div>
            <div v-else class="resource-list">
              <button
                v-for="server in enabledMcpServers"
                :key="server.name"
                class="resource-card"
                :class="{ active: selectedMcpServers.includes(server.name) }"
                type="button"
                @click="toggleMcp(server.name)"
              >
                <span class="resource-icon"><Wrench :size="16" /></span>
                <span class="resource-main">
                  <strong>{{ server.name }}</strong>
                  <small>{{ getStatusText(server.status) }}<template v-if="server.tools?.length"> · {{ server.tools.length }} 个工具</template></small>
                </span>
                <CheckCircle2 v-if="selectedMcpServers.includes(server.name)" :size="16" />
              </button>
            </div>
          </section>

          <section v-if="activeTab === 'skills'" class="settings-section">
            <h3>技能</h3>
            <p>选择浏览器插件会话默认追加的 Skills。技能内容仍由 Nine1Bot 的全局/项目技能目录提供。</p>
            <div v-if="skills.length === 0" class="empty-state">暂无可用技能。</div>
            <div v-else class="resource-list">
              <button
                v-for="skill in skills"
                :key="skill.name"
                class="resource-card"
                :class="{ active: selectedSkills.includes(skill.name) }"
                type="button"
                @click="toggleSkill(skill.name)"
              >
                <span class="resource-icon"><Sparkles :size="16" /></span>
                <span class="resource-main">
                  <strong>{{ skill.name }}</strong>
                  <small>{{ skill.source === 'builtin' ? '内置' : '插件' }}<template v-if="skill.description"> · {{ skill.description }}</template></small>
                </span>
                <CheckCircle2 v-if="selectedSkills.includes(skill.name)" :size="16" />
              </button>
            </div>
          </section>

          <section v-if="activeTab === 'tools'" class="settings-section">
            <h3>平台注册工具</h3>
            <p>选择以后新建的浏览器插件会话默认声明哪些平台专属工具。现有会话不会被修改。</p>
            <div v-if="registeredToolRows.length === 0 && staleRegisteredToolIDs.length === 0" class="empty-state">
              当前项目没有可由用户选择的平台工具。
            </div>
            <div v-else class="resource-list">
              <div
                v-for="tool in registeredToolRows"
                :key="tool.id"
                class="resource-card tool-resource-card"
                :class="{
                  active: selectedRegisteredTools.includes(tool.id),
                  unavailable: !tool.selectable,
                }"
              >
                <span class="resource-icon"><Wrench :size="16" /></span>
                <span class="resource-main">
                  <strong>{{ tool.id }}</strong>
                  <small>
                    {{ tool.description }} · {{ registeredToolStatus(tool) }}
                    <template v-if="tool.unavailableReason"> · {{ tool.unavailableReason }}</template>
                  </small>
                </span>
                <div class="tool-row-actions">
                  <button
                    v-if="tool.selectable || selectedRegisteredTools.includes(tool.id)"
                    class="tool-action-btn"
                    type="button"
                    @click="toggleRegisteredTool(tool)"
                  >
                    <CheckCircle2 v-if="selectedRegisteredTools.includes(tool.id)" :size="15" />
                    <span>{{ selectedRegisteredTools.includes(tool.id) ? '取消' : '选择' }}</span>
                  </button>
                  <button
                    v-if="tool.canOpenSettings"
                    class="tool-action-btn"
                    type="button"
                    @click="openPlatformSettings(tool)"
                  >
                    打开平台设置
                  </button>
                </div>
              </div>

              <div
                v-for="toolID in staleRegisteredToolIDs"
                :key="`stale:${toolID}`"
                class="resource-card tool-resource-card unavailable"
              >
                <span class="resource-icon"><Wrench :size="16" /></span>
                <span class="resource-main">
                  <strong>{{ toolID }}</strong>
                  <small>已保存，但当前项目未注册或平台已停用。可取消后保存配置。</small>
                </span>
                <button class="tool-action-btn" type="button" @click="removeStaleRegisteredTool(toolID)">
                  取消
                </button>
              </div>
            </div>
          </section>

          <section v-if="activeTab === 'relay'" class="settings-section">
            <h3>浏览器 relay</h3>
            <p>修改浏览器插件连接到的 Nine1Bot Origin。Bootstrap 与 WebSocket 端点会自动派生。</p>
            <label>浏览器 relay Origin</label>
            <input v-model="relayDraft" type="url" spellcheck="false" placeholder="http://127.0.0.1:4096" />
            <div class="relay-actions">
              <button class="primary-btn" type="button" @click="saveRelay">保存并重连</button>
              <button class="secondary-btn" type="button" @click="testRelay">测试连接</button>
            </div>
            <div class="endpoint-list">
              <div>
                <span>Bootstrap</span>
                <code>{{ relaySettings.bootstrapUrl || '-' }}</code>
              </div>
              <div>
                <span>插件</span>
                <code>{{ relaySettings.extensionUrl || '-' }}</code>
              </div>
            </div>
            <div class="relay-state">
              <Link2 :size="15" />
              <span>
                {{ relaySettings.serverReachable ? 'Nine1Bot 主进程可访问' : 'Nine1Bot 主进程不可访问' }}
                <template v-if="relaySettings.serverReachable"> · {{ relaySettings.relayConnected ? 'relay 已连接' : 'relay 重连中' }}</template>
              </span>
            </div>
            <div v-if="relayMessage" class="status-message" :class="relayTone">{{ relayMessage }}</div>
          </section>
        </template>
      </div>

      <div v-if="activeTab !== 'relay'" class="modal-footer">
        <div class="status-message" :class="statusTone">{{ statusMessage }}</div>
        <button class="primary-btn" type="button" :disabled="saving || loading" @click="saveDefaults">
          {{ saving ? '保存中...' : '保存插件默认配置' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.extension-settings-modal {
  width: min(820px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: var(--bg-elevated);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.24);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
}

.modal-header h2 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 650;
}

.close-btn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.close-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.settings-tabs {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 4px;
  margin: 0 24px;
  padding: 4px;
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
}

.tab {
  height: 30px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-13);
  cursor: pointer;
}

.tab.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.modal-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px;
}

.settings-section h3 {
  margin: 0 0 6px;
  font-size: var(--text-md);
  font-weight: 650;
}

.settings-section p {
  margin: 0 0 18px;
  color: var(--text-muted);
  font-size: var(--text-13);
  line-height: 1.5;
}

.loading-state,
.empty-state {
  padding: 28px;
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-muted);
  text-align: center;
  font-size: var(--text-13);
}

.default-card,
.model-card,
.resource-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.default-card {
  width: min(360px, 100%);
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  padding: 14px;
}

.provider-section + .provider-section {
  margin-top: 24px;
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.provider-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.provider-icon,
.resource-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  flex-shrink: 0;
}

.auth-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--warning-subtle, rgba(245, 158, 11, 0.12));
  color: var(--warning);
  font-size: var(--text-xs);
}

.auth-badge.ok {
  background: rgba(34, 197, 94, 0.12);
  color: var(--success);
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.model-card {
  min-height: 68px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
}

.model-card.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.default-card.active,
.model-card.active,
.resource-card.active {
  border-color: var(--accent);
  background: var(--accent-subtle);
}

.radio {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--border-default);
  flex-shrink: 0;
}

.active > .radio {
  border: 4px solid var(--accent);
}

.default-card strong,
.model-card strong,
.resource-card strong {
  display: block;
  font-size: var(--text-13);
  font-weight: 600;
}

.default-card small,
.model-card small,
.resource-card small {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: 1.35;
}

textarea,
input {
  width: 100%;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  outline: none;
}

textarea {
  min-height: 220px;
  padding: 12px;
  resize: vertical;
  line-height: 1.5;
}

input {
  height: 38px;
  padding: 0 11px;
  font-size: var(--text-13);
}

label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 600;
}

.resource-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.resource-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
}

.resource-main {
  min-width: 0;
  flex: 1;
}

.tool-resource-card {
  cursor: default;
}

.tool-resource-card.unavailable {
  border-color: var(--border-subtle);
}

.tool-row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.tool-action-btn {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
}

.relay-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.primary-btn,
.secondary-btn {
  height: 34px;
  border: 0;
  border-radius: var(--radius-md);
  padding: 0 13px;
  font-size: var(--text-13);
  font-weight: 600;
  cursor: pointer;
}

.primary-btn {
  background: var(--accent);
  color: var(--accent-fg);
}

.secondary-btn {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.endpoint-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 18px;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.endpoint-list div {
  display: grid;
  grid-template-columns: 82px 1fr;
  gap: 8px;
  align-items: start;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

code {
  padding: 3px 5px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  word-break: break-all;
}

.relay-state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px 18px;
  border-top: 1px solid var(--border-subtle);
}

.status-message {
  min-height: 18px;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.status-message.success {
  color: var(--success);
}

.status-message.error {
  color: var(--error);
}

@media (max-width: 640px) {
  .settings-tabs {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .tool-resource-card {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .tool-row-actions {
    width: 100%;
  }
}
</style>
