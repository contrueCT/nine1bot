<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleQuestionMark,
  Copy,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Send,
  Trash2,
} from 'lucide-vue-next'
import {
  mcpApi,
  nine1botConfigApi,
  projectApi,
  providerApi,
  webhookApi,
  type McpServer,
  type Provider,
  type Session,
  type WebhookRequestGuards,
  type WebhookRun,
  type WebhookSource,
  type WebhookStatus,
} from '../api/client'
import { copyText as copyToClipboard } from '../utils/clipboard'
import type { ProjectInfo } from './Sidebar.vue'
import {
  WEBHOOK_PRESETS,
  cloneWebhookGuards,
  defaultWebhookGuards,
  findWebhookPresetForConfig,
  parseWebhookMapping,
  previewWebhookConfig,
  webhookPresetById,
  type WebhookPresetId,
} from '../utils/webhooks'

const props = withDefaults(defineProps<{
  projects: ProjectInfo[]
  embedded?: boolean
}>(), {
  embedded: false,
})

const emit = defineEmits<{
  selectSession: [session: Session]
}>()

const DEFAULT_PRESET = webhookPresetById('generic')
const RUN_PAGE_SIZE = 10
const helpText = {
  guards: '防护规则会在创建 Agent 会话前，拦截噪声、重复或过期的 Webhook 请求。',
  rateLimit: '限制此来源在一个时间窗口内可接受的请求数量。',
  cooldown: '接受一次请求后，此来源会等待一段时间再接受下一个请求。',
  dedupe: '拒绝在 TTL 内渲染出相同去重键的请求。',
  dedupeKey: '从映射字段、body、headers、query、来源或项目值构建一个稳定的键。',
  replayProtection: '要求携带时间戳 header，并拒绝超出允许时间偏差的请求。',
  timestampHeader: '外部服务必须携带此 header，值为 Unix 秒、Unix 毫秒或 ISO 时间戳。',
  requestMapping: '将 body、headers 或 query 中的 JSON 路径映射为字段，这些字段可在模板中以 {{fields.name}} 使用。',
  promptTemplate: 'Webhook 事件被接受后，此内容将作为发送给 Agent 的第一条用户消息。',
  samplePayload: '粘贴一个示例 JSON 负载，即可在不产生运行记录的情况下预览字段、Prompt 渲染和去重键。',
  preview: '预览仅在浏览器本地更新，不会调用 Webhook 端点或启动 Agent。',
}

const status = ref<WebhookStatus | null>(null)
const sources = ref<WebhookSource[]>([])
const runs = ref<WebhookRun[]>([])
const providers = ref<Provider[]>([])
const mcpServers = ref<McpServer[]>([])
const selectedSourceId = ref('')
const isLoading = ref(false)
const isSaving = ref(false)
const isSendingTest = ref(false)
const error = ref('')
const notice = ref('')
const showCreateForm = ref(false)
const revealedSecret = ref('')
const revealedSecretSourceId = ref('')
const showMcpPicker = ref(false)
const pendingMcpServers = ref<string[]>([])
const fullPermissionConfirmed = ref(false)
const defaultModelLabel = ref('使用用户配置中的默认模型')
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)
const selectedRunId = ref('')
const runPage = ref(1)
const runPageItems = ref<WebhookRun[]>([])
const runPageHasNext = ref(false)
const isRunPageLoading = ref(false)
const endpointPanel = ref<HTMLElement | null>(null)
let runPageLoadGeneration = 0

const form = ref(defaultForm())

const isEmbedded = computed(() => props.embedded)
const selectedSource = computed(() => sources.value.find((source) => source.id === selectedSourceId.value) || null)
const selectedRun = computed(() => runPageItems.value.find((run) => run.id === selectedRunId.value) || null)

const sortedProjects = computed(() => props.projects.slice().sort((a, b) => b.time.updated - a.time.updated))
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === form.value.modelProviderID))
const selectedProviderModels = computed(() => selectedProvider.value?.models || [])
const defaultMcpServers = computed(() => mcpServers.value.filter((server) => server.status !== 'disabled').map((server) => server.name))
const addedMcpServers = computed(() => form.value.mcpServers.filter((server) => server.trim()))
const availableMcpServers = computed(() => mcpServers.value.filter((server) => server.status !== 'disabled'))
const effectiveMcpServers = computed(() => {
  if (form.value.resourcesMode === 'default') {
    return defaultMcpServers.value
  }
  return [...new Set([...defaultMcpServers.value, ...addedMcpServers.value])]
})
const mcpModeDescription = computed(() => {
  if (form.value.resourcesMode === 'default') {
    return 'Webhook 会话仅继承默认 MCP 配置。'
  }
  return 'Webhook 会话继承默认 MCP，并额外添加所选的 MCP 服务器。'
})
const selectedPreset = computed(() => webhookPresetById(form.value.presetID))
const configPreview = computed(() => previewWebhookConfig({
  sourceName: form.value.name,
  projectName: projectLabel(form.value.projectID),
  requestMappingText: form.value.requestMappingText,
  promptTemplate: form.value.promptTemplate,
  samplePayloadText: form.value.samplePayloadText,
  dedupeKeyTemplate: form.value.guards.dedupe.enabled ? form.value.guards.dedupe.keyTemplate : '',
}))

const enabledCount = computed(() => sources.value.filter((source) => source.enabled).length)
const rejectedTodayCount = computed(() => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return runs.value.filter((run) => run.status === 'rejected' && run.time.received >= start.getTime()).length
})

function defaultForm() {
  return {
    presetID: DEFAULT_PRESET.id as WebhookPresetId,
    name: '',
    enabled: true,
    projectID: '',
    requestMappingText: JSON.stringify(DEFAULT_PRESET.requestMapping, null, 2),
    promptTemplate: DEFAULT_PRESET.promptTemplate,
    samplePayloadText: JSON.stringify(DEFAULT_PRESET.samplePayload, null, 2),
    modelMode: 'default' as 'default' | 'custom',
    modelProviderID: '',
    modelID: '',
    resourcesMode: 'default' as 'default' | 'default-plus-selected',
    mcpServers: [] as string[],
    permissionMode: 'default' as 'default' | 'full',
    guards: defaultWebhookGuards(),
  }
}

function cloneGuards(guards?: WebhookRequestGuards): WebhookRequestGuards {
  return cloneWebhookGuards(guards)
}

function projectLabel(projectID: string) {
  const project = props.projects.find((item) => item.id === projectID)
  return project?.name || project?.rootDirectory || project?.worktree || projectID
}

function resetCreateForm() {
  const next = defaultForm()
  next.projectID = sortedProjects.value[0]?.id || ''
  next.modelProviderID = providers.value[0]?.id || ''
  next.modelID = providers.value[0]?.models[0]?.id || ''
  form.value = next
  fullPermissionConfirmed.value = false
  selectedRunId.value = ''
}

function loadFormFromSource(source: WebhookSource | null) {
  if (!source) {
    resetCreateForm()
    return
  }
  const model = source.runtimeProfile.model
  const preset = findWebhookPresetForConfig(source.requestMapping || {}, source.promptTemplate || '') || DEFAULT_PRESET
  form.value = {
    presetID: preset.id,
    name: source.name,
    enabled: source.enabled,
    projectID: source.projectID,
    requestMappingText: JSON.stringify(source.requestMapping || {}, null, 2),
    promptTemplate: source.promptTemplate || preset.promptTemplate,
    samplePayloadText: JSON.stringify(preset.samplePayload, null, 2),
    modelMode: source.runtimeProfile.modelMode,
    modelProviderID: model?.providerID || providers.value[0]?.id || '',
    modelID: model?.modelID || providers.value[0]?.models[0]?.id || '',
    resourcesMode: source.runtimeProfile.resourcesMode,
    mcpServers: [...(source.runtimeProfile.mcpServers || [])],
    permissionMode: source.permissionPolicy.mode,
    guards: cloneGuards(source.requestGuards),
  }
  fullPermissionConfirmed.value = source.permissionPolicy.mode === 'full'
}

watch(selectedSource, (source) => {
  if (!showCreateForm.value) {
    loadFormFromSource(source)
  }
})

watch(
  () => props.projects,
  () => {
    if (!form.value.projectID && sortedProjects.value[0]) {
      form.value.projectID = sortedProjects.value[0].id
    }
  },
  { immediate: true },
)

watch(selectedProviderModels, (models) => {
  if (form.value.modelMode === 'custom' && models.length > 0 && !models.some((model) => model.id === form.value.modelID)) {
    form.value.modelID = models[0].id
  }
})

watch(
  () => form.value.resourcesMode,
  (mode) => {
    if (mode === 'default') {
      showMcpPicker.value = false
    }
  },
)

async function loadAll() {
  isLoading.value = true
  error.value = ''
  try {
    const [nextStatus, nextSources, nextRuns, providerData, nextMcpServers, config] = await Promise.all([
      webhookApi.status(),
      webhookApi.sources(),
      webhookApi.runs({ limit: 100 }),
      providerApi.list().catch(() => ({ providers: [], defaults: {}, connected: [] })),
      mcpApi.list().catch(() => []),
      nine1botConfigApi.get().catch(() => ({ model: '' })),
    ])
    status.value = nextStatus
    sources.value = nextSources
    runs.value = nextRuns
    providers.value = providerData.providers
    mcpServers.value = nextMcpServers
    defaultModelLabel.value = defaultModelFromConfig(config.model, providerData)
    if (!selectedSourceId.value && nextSources[0]) {
      selectedSourceId.value = nextSources[0].id
    }
    if (!selectedSourceId.value) {
      resetCreateForm()
      resetRunPagination()
      showCreateForm.value = true
    } else {
      loadFormFromSource(selectedSource.value)
      await refreshRunPage()
    }
  } catch (err) {
    error.value = friendlyError(err)
  } finally {
    isLoading.value = false
  }
}

function friendlyError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  if (/signal is aborted|aborterror|aborted/i.test(message)) {
    return '请求已取消或超时，请刷新重试。'
  }
  return message
}

function defaultModelFromConfig(model: string | undefined, providerData: { providers: Provider[]; defaults: Record<string, string>; connected: string[] }) {
  if (model?.includes('/')) {
    const [providerID, ...modelParts] = model.split('/')
    return modelLabelFromList(providerData.providers, providerID, modelParts.join('/'))
  }
  const providerID = providerData.connected[0] || providerData.providers[0]?.id
  const modelID = providerID ? providerData.defaults[providerID] || providerData.providers.find((provider) => provider.id === providerID)?.models[0]?.id : undefined
  return modelLabelFromList(providerData.providers, providerID, modelID) || '使用用户配置中的默认模型'
}

function modelLabelFromList(list: Provider[], providerID?: string, modelID?: string) {
  if (!providerID || !modelID) return ''
  const provider = list.find((item) => item.id === providerID)
  const model = provider?.models.find((item) => item.id === modelID)
  return `${provider?.name || providerID} / ${model?.name || modelID}`
}

function endpointUrl(source: WebhookSource | null, secret?: string, publicUrl = false) {
  if (!source || !status.value) return ''
  const template = publicUrl ? status.value.publicWebhookUrl : status.value.localWebhookUrl
  if (!template) return ''
  return template
    .replace('{sourceId}', source.id)
    .replace('{secret}', secret || source.secretMasked)
}

function parseMapping() {
  return parseWebhookMapping(form.value.requestMappingText)
}

function sourceInput() {
  const requestMapping = parseMapping()
  return {
    name: form.value.name.trim(),
    enabled: form.value.enabled,
    projectID: form.value.projectID,
    requestMapping,
    promptTemplate: form.value.promptTemplate,
    runtimeProfile: {
      modelMode: form.value.modelMode,
      model: form.value.modelMode === 'custom' && form.value.modelProviderID && form.value.modelID
        ? { providerID: form.value.modelProviderID, modelID: form.value.modelID }
        : undefined,
      resourcesMode: form.value.resourcesMode,
      mcpServers: form.value.resourcesMode === 'default-plus-selected' ? addedMcpServers.value : [],
    },
    permissionPolicy: {
      mode: form.value.permissionMode,
    },
    requestGuards: cloneGuards(form.value.guards),
  }
}

function validateForm() {
  if (!form.value.name.trim()) throw new Error('请填写来源名称')
  if (!form.value.projectID) throw new Error('请选择项目')
  if (form.value.modelMode === 'custom' && (!form.value.modelProviderID || !form.value.modelID)) {
    throw new Error('自定义模型需要选择服务商和模型。')
  }
}

async function createSource() {
  error.value = ''
  notice.value = ''
  try {
    validateForm()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return
  }
  isSaving.value = true
  try {
    const created = await webhookApi.createSource(sourceInput())
    sources.value = await webhookApi.sources()
    selectedSourceId.value = created.source.id
    showCreateForm.value = false
    revealedSecretSourceId.value = created.source.id
    revealedSecret.value = created.secret
    resetRunPagination()
    notice.value = 'Webhook 来源已创建。请立即复制完整 URL，secret 仅显示一次。'
    await refreshRuns()
    await nextTick()
    scrollEndpointIntoView()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function saveSource() {
  const source = selectedSource.value
  if (!source) return
  error.value = ''
  notice.value = ''
  try {
    validateForm()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return
  }
  isSaving.value = true
  try {
    const updated = await webhookApi.updateSource(source.id, sourceInput())
    const index = sources.value.findIndex((item) => item.id === updated.id)
    if (index >= 0) {
      sources.value[index] = updated
    }
    notice.value = 'Webhook 来源已保存。'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function sendTest() {
  const source = selectedSource.value
  if (!source) return
  error.value = ''
  notice.value = ''
  let payload: unknown
  try {
    payload = JSON.parse(form.value.samplePayloadText || '{}')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return
  }
  isSendingTest.value = true
  try {
    const result = await webhookApi.sendTest(source.id, payload)
    notice.value = `测试已发送，HTTP 状态 ${result.status}。`
    resetRunPagination()
    await refreshRuns()
    if (result.body && typeof result.body === 'object' && 'runId' in result.body) {
      selectedRunId.value = String((result.body as { runId?: unknown }).runId || '')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSendingTest.value = false
  }
}

async function refreshSecret() {
  const source = selectedSource.value
  if (!source) return
  const ok = confirm('刷新后原有 webhook URL 会立即失效，需要更新外部服务中的 URL。确定刷新 secret 吗？')
  if (!ok) return
  error.value = ''
  notice.value = ''
  isSaving.value = true
  try {
    const refreshed = await webhookApi.refreshSecret(source.id)
    const index = sources.value.findIndex((item) => item.id === refreshed.source.id)
    if (index >= 0) {
      sources.value[index] = refreshed.source
    }
    revealedSecretSourceId.value = refreshed.source.id
    revealedSecret.value = refreshed.secret
    notice.value = 'Webhook secret 已刷新。请立即复制新的完整 URL，旧 URL 已失效。'
    await nextTick()
    scrollEndpointIntoView()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function deleteSource() {
  const source = selectedSource.value
  if (!source) return
  if (!confirm(`确定删除 Webhook 来源「${source.name}」吗？历史运行记录将保留。`)) return
  error.value = ''
  notice.value = ''
  isSaving.value = true
  try {
    await webhookApi.deleteSource(source.id)
    sources.value = await webhookApi.sources()
    selectedSourceId.value = sources.value[0]?.id || ''
    resetRunPagination()
    if (!selectedSourceId.value) {
      showCreateForm.value = true
      resetCreateForm()
    }
    notice.value = 'Webhook 来源已删除。'
    await refreshRuns()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function refreshRuns() {
  const [nextRuns] = await Promise.all([
    webhookApi.runs({ limit: 100 }),
    refreshRunPage(),
  ])
  runs.value = nextRuns
}

function resetRunPagination() {
  runPage.value = 1
  runPageItems.value = []
  runPageHasNext.value = false
  selectedRunId.value = ''
}

async function refreshRunPage() {
  const sourceID = selectedSourceId.value
  const page = runPage.value
  const generation = ++runPageLoadGeneration
  if (!sourceID) {
    runPageItems.value = []
    runPageHasNext.value = false
    isRunPageLoading.value = false
    return
  }

  isRunPageLoading.value = true
  try {
    const pageRuns = await webhookApi.runs({
      sourceID,
      limit: RUN_PAGE_SIZE + 1,
      offset: (page - 1) * RUN_PAGE_SIZE,
    })
    if (generation !== runPageLoadGeneration || sourceID !== selectedSourceId.value || page !== runPage.value) return
    runPageItems.value = pageRuns.slice(0, RUN_PAGE_SIZE)
    runPageHasNext.value = pageRuns.length > RUN_PAGE_SIZE
    if (selectedRunId.value && !runPageItems.value.some((run) => run.id === selectedRunId.value)) {
      selectedRunId.value = ''
    }
  } finally {
    if (generation === runPageLoadGeneration) {
      isRunPageLoading.value = false
    }
  }
}

async function previousRunPage() {
  if (runPage.value <= 1 || isRunPageLoading.value) return
  runPage.value -= 1
  selectedRunId.value = ''
  try {
    await refreshRunPage()
  } catch (err) {
    error.value = friendlyError(err)
  }
}

async function nextRunPage() {
  if (!runPageHasNext.value || isRunPageLoading.value) return
  runPage.value += 1
  selectedRunId.value = ''
  try {
    await refreshRunPage()
  } catch (err) {
    error.value = friendlyError(err)
  }
}

async function copyText(text: string) {
  if (!text) return
  error.value = ''
  notice.value = ''
  try {
    if (!await copyToClipboard(text)) throw new Error('copy failed')
    notice.value = '已复制。'
  } catch {
    error.value = '自动复制失败，请手动复制。'
  }
}

async function openRunSession(run: WebhookRun) {
  if (!run.sessionID) return
  error.value = ''
  try {
    const sessions = await projectApi.sessions(run.projectID, { roots: true, limit: 300 })
    const session = sessions.find((item) => item.id === run.sessionID)
    if (!session) {
      throw new Error('会话已不存在')
    }
    emit('selectSession', session)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function beginCreate() {
  showCreateForm.value = true
  selectedSourceId.value = ''
  resetRunPagination()
  revealedSecret.value = ''
  revealedSecretSourceId.value = ''
  resetCreateForm()
}

function selectSource(source: WebhookSource) {
  showCreateForm.value = false
  selectedSourceId.value = source.id
  resetRunPagination()
  showMcpPicker.value = false
  void refreshRunPage().catch((err) => {
    error.value = friendlyError(err)
  })
}

function selectRun(run: WebhookRun) {
  selectedRunId.value = selectedRunId.value === run.id ? '' : run.id
}

function scrollEndpointIntoView() {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  endpointPanel.value?.scrollIntoView({
    behavior: reducedMotion ? 'auto' : 'smooth',
    block: 'start',
  })
}

function applyPreset(presetID: WebhookPresetId) {
  const preset = webhookPresetById(presetID)
  form.value.presetID = preset.id
  form.value.name = preset.sourceName
  form.value.requestMappingText = JSON.stringify(preset.requestMapping, null, 2)
  form.value.promptTemplate = preset.promptTemplate
  form.value.samplePayloadText = JSON.stringify(preset.samplePayload, null, 2)
  form.value.guards = cloneGuards(preset.guards)
}

function openMcpPicker() {
  pendingMcpServers.value = [...form.value.mcpServers]
  showMcpPicker.value = true
}

function confirmMcpPicker() {
  form.value.mcpServers = [...new Set(pendingMcpServers.value)]
  form.value.resourcesMode = form.value.mcpServers.length > 0 ? 'default-plus-selected' : form.value.resourcesMode
  showMcpPicker.value = false
}

function removeMcp(server: string) {
  form.value.mcpServers = form.value.mcpServers.filter((item) => item !== server)
}

function handlePermissionModeChange() {
  if (form.value.permissionMode !== 'full') {
    fullPermissionConfirmed.value = false
    return
  }
  const ok = confirm('完全权限模式将自动允许 Webhook 会话的所有权限请求，确定继续吗？')
  if (!ok) {
    form.value.permissionMode = 'default'
    fullPermissionConfirmed.value = false
    return
  }
  fullPermissionConfirmed.value = true
}

function handleModelProviderChange() {
  form.value.modelID = selectedProviderModels.value[0]?.id || ''
}

function formatTime(value?: number) {
  if (!value) return ''
  return new Date(value).toLocaleString()
}

function statusClass(run: WebhookRun) {
  if (run.status === 'succeeded' || run.status === 'running' || run.status === 'accepted') return 'ok'
  if (run.status === 'rejected') return 'warn'
  return 'danger'
}

function runSummary(run: WebhookRun) {
  return run.guardReason || run.error || run.renderedPromptPreview || ''
}

function runStatusLabel(status: WebhookRun['status']) {
  const labels: Record<WebhookRun['status'], string> = {
    received: '已接收',
    accepted: '已接受',
    running: '运行中',
    succeeded: '成功',
    failed: '失败',
    rejected: '已拦截',
  }
  return labels[status] || status
}

function guardTypeLabel(guardType?: WebhookRun['guardType']) {
  if (!guardType) return ''
  const labels: Record<NonNullable<WebhookRun['guardType']>, string> = {
    dedupe: '去重',
    rateLimit: '速率限制',
    cooldown: '冷却时间',
    replayProtection: '重放检查',
  }
  return labels[guardType] || guardType
}

function permissionModeLabel(mode: string) {
  return mode === 'full' ? '完全' : '默认'
}

function tunnelStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    active: '已启用',
    disabled: '已禁用',
    error: '错误',
  }
  return labels[status || ''] || status || '已禁用'
}

function currentSecretFor(source: WebhookSource | null) {
  return source && revealedSecretSourceId.value === source.id ? revealedSecret.value : undefined
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

onMounted(() => {
  void loadAll()
  pollingTimer.value = setInterval(() => {
    void refreshRuns().catch(() => undefined)
  }, 5000)
})

onUnmounted(() => {
  if (pollingTimer.value) {
    clearInterval(pollingTimer.value)
  }
})
</script>

<template>
  <div class="webhooks-page" :class="{ embedded: isEmbedded }">
    <header v-if="!isEmbedded" class="webhooks-header">
      <div>
        <h1>Webhooks</h1>
        <div class="header-meta">
          <span class="pill ok">已启用 {{ enabledCount }}</span>
          <span class="pill warn">今日拦截 {{ rejectedTodayCount }}</span>
          <span>绑定项目的外部触发器</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn" @click="loadAll" :disabled="isLoading">
          <RefreshCw :size="16" :class="{ spin: isLoading }" />
          刷新
        </button>
        <button class="btn primary" @click="beginCreate">
          <Plus :size="16" />
          新建来源
        </button>
      </div>
    </header>

    <section class="status-band">
      <div class="address-card">
        <div class="address-heading">
          <span>本地地址</span>
          <span class="pill ok">{{ status?.listening ? '监听中' : '已停止' }}</span>
        </div>
        <code>{{ status?.localWebhookUrl || '加载中...' }}</code>
      </div>
      <div class="address-card">
        <div class="address-heading">
          <span>隧道地址</span>
          <span class="pill" :class="status?.tunnel.enabled ? 'ok' : 'muted'">{{ tunnelStatusLabel(status?.tunnel.status) }}</span>
        </div>
        <code>{{ status?.publicWebhookUrl || '暂无隧道 URL' }}</code>
      </div>
      <button class="btn copy-base" @click="copyText(status?.localWebhookUrl || '')">
        <Copy :size="16" />
        复制 URL
      </button>
    </section>

    <div v-if="error" class="notice error">
      <AlertTriangle :size="16" />
      {{ error }}
    </div>
    <div v-if="notice" class="notice">
      <CheckCircle2 :size="16" />
      {{ notice }}
    </div>

    <section class="webhooks-workspace">
      <aside class="sources-column">
        <div class="column-header">
          <h2>来源</h2>
          <span class="pill blue">共 {{ sources.length }} 个</span>
        </div>
        <button
          v-for="source in sources"
          :key="source.id"
          class="source-item"
          :class="{ active: selectedSourceId === source.id }"
          @click="selectSource(source)"
        >
          <span class="source-icon"><Activity :size="16" /></span>
          <span class="source-copy">
            <strong>{{ source.name }}</strong>
            <span>{{ projectLabel(source.projectID) }} · {{ permissionModeLabel(source.permissionPolicy.mode) }}权限</span>
          </span>
          <span class="source-runs">{{ runs.filter((run) => run.sourceID === source.id).length }} 次运行</span>
        </button>
        <div v-if="sources.length === 0" class="empty-note">
          暂无 Webhook 来源。
        </div>
      </aside>

      <main class="detail-column">
        <div class="detail-header">
          <div>
            <h2>{{ showCreateForm ? '新建 Webhook 来源' : selectedSource?.name || 'Webhook 来源' }}</h2>
            <p>{{ showCreateForm ? '创建一个通用 JSON Webhook 入口。' : projectLabel(selectedSource?.projectID || '') }}</p>
          </div>
          <div v-if="selectedSource && !showCreateForm" class="detail-actions">
            <button class="btn" @click="copyText(endpointUrl(selectedSource, currentSecretFor(selectedSource)))">
              <Copy :size="16" />
              复制
            </button>
            <button class="btn" @click="sendTest" :disabled="isSaving || isSendingTest">
              <Send :size="16" />
              发送测试
            </button>
            <button class="btn" @click="refreshSecret" :disabled="isSaving">
              <RotateCw :size="16" />
              刷新 secret
            </button>
            <button class="btn danger" @click="deleteSource" :disabled="isSaving">
              <Trash2 :size="16" />
              删除
            </button>
          </div>
        </div>

        <div class="detail-grid">
          <section v-if="showCreateForm" class="panel wide">
            <h3>预设</h3>
            <div class="preset-grid">
              <button
                v-for="preset in WEBHOOK_PRESETS"
                :key="preset.id"
                class="preset-card"
                :class="{ active: selectedPreset.id === preset.id }"
                @click="applyPreset(preset.id)"
              >
                <strong>{{ preset.name }}</strong>
                <span>{{ preset.description }}</span>
              </button>
            </div>
          </section>

          <section ref="endpointPanel" class="panel wide">
            <h3>端点</h3>
            <div class="field-grid">
              <label>
                <span>本地 URL</span>
                <div class="endpoint-row">
                  <code>{{ endpointUrl(selectedSource, currentSecretFor(selectedSource)) || '创建来源后获取 URL' }}</code>
                  <button class="icon-btn" @click="copyText(endpointUrl(selectedSource, currentSecretFor(selectedSource)))">
                    <Copy :size="15" />
                  </button>
                </div>
              </label>
              <label v-if="status?.publicWebhookUrl">
                <span>公网 URL</span>
                <div class="endpoint-row">
                  <code>{{ endpointUrl(selectedSource, currentSecretFor(selectedSource), true) }}</code>
                  <button class="icon-btn" @click="copyText(endpointUrl(selectedSource, currentSecretFor(selectedSource), true))">
                    <Copy :size="15" />
                  </button>
                </div>
              </label>
              <p v-if="revealedSecretSourceId === selectedSource?.id && revealedSecret" class="hint success">
                完整 URL 仅显示一次，请在离开此来源前复制。
              </p>
            </div>
          </section>

          <section class="panel">
            <h3>来源</h3>
            <div class="field-grid">
              <label>
                <span>名称</span>
                <input v-model="form.name" placeholder="Uptime Kuma 生产环境" />
              </label>
              <label>
                <span>项目</span>
                <select v-model="form.projectID">
                  <option value="" disabled>选择项目</option>
                  <option v-for="project in sortedProjects" :key="project.id" :value="project.id">
                    {{ projectLabel(project.id) }}
                  </option>
                </select>
              </label>
              <label class="check">
                <input v-model="form.enabled" type="checkbox" />
                已启用
              </label>
            </div>
          </section>

          <section class="panel">
            <h3>权限</h3>
            <div class="segmented">
              <label><input v-model="form.permissionMode" type="radio" value="default" @change="handlePermissionModeChange" /> 默认</label>
              <label><input v-model="form.permissionMode" type="radio" value="full" @change="handlePermissionModeChange" /> 完全</label>
            </div>
            <p class="hint" :class="{ danger: form.permissionMode === 'full' }">
              {{ form.permissionMode === 'full' ? 'Webhook 会话的权限请求将被自动允许。' : '权限与提问请求将被自动拒绝。' }}
            </p>
            <p v-if="form.permissionMode === 'full' && fullPermissionConfirmed" class="hint danger">
              已确认完全权限模式。
            </p>
          </section>

          <section class="panel wide">
            <h3>运行时</h3>
            <div class="runtime-grid">
              <div class="runtime-card">
                <div class="section-title">模型</div>
                <div class="segmented">
                  <label><input v-model="form.modelMode" type="radio" value="default" /> 默认</label>
                  <label><input v-model="form.modelMode" type="radio" value="custom" /> 自定义</label>
                </div>
                <div v-if="form.modelMode === 'default'" class="summary-line">{{ defaultModelLabel }}</div>
                <div v-else class="model-selectors">
                  <select v-model="form.modelProviderID" @change="handleModelProviderChange">
                    <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
                  </select>
                  <select v-model="form.modelID">
                    <option v-for="model in selectedProviderModels" :key="model.id" :value="model.id">{{ model.name || model.id }}</option>
                  </select>
                </div>
              </div>

              <div class="runtime-card">
                <div class="section-title">MCP 服务器</div>
                <div class="mode-options">
                  <label class="mode-option" :class="{ active: form.resourcesMode === 'default' }">
                    <input v-model="form.resourcesMode" type="radio" value="default" />
                    <span>
                      <strong>默认</strong>
                      <small>仅使用默认 MCP</small>
                    </span>
                  </label>
                  <label class="mode-option" :class="{ active: form.resourcesMode === 'default-plus-selected' }">
                    <input v-model="form.resourcesMode" type="radio" value="default-plus-selected" />
                    <span>
                      <strong>添加</strong>
                      <small>默认 MCP 加所选 MCP</small>
                    </span>
                  </label>
                </div>
                <p class="hint">{{ mcpModeDescription }}</p>

                <div class="mcp-group current">
                  <span>Agent 当前可用的 MCP</span>
                  <div class="chips">
                    <span v-for="server in effectiveMcpServers" :key="server" class="chip strong">{{ server }}</span>
                    <span v-if="effectiveMcpServers.length === 0" class="chip muted">暂无可用 MCP</span>
                  </div>
                </div>

                <div class="mcp-group">
                  <span>默认 MCP</span>
                  <div class="chips">
                    <span v-for="server in defaultMcpServers" :key="server" class="chip">{{ server }}</span>
                    <span v-if="defaultMcpServers.length === 0" class="chip muted">暂无默认 MCP</span>
                  </div>
                </div>

                <div class="mcp-group">
                  <span>{{ form.resourcesMode === 'default' ? '已添加 MCP（默认模式下不使用）' : '已添加 MCP' }}</span>
                  <div class="chips">
                    <button
                      v-for="server in addedMcpServers"
                      :key="server"
                      class="chip removable"
                      :class="{ inactive: form.resourcesMode === 'default' }"
                      @click="removeMcp(server)"
                    >
                      {{ server }}
                    </button>
                    <span v-if="addedMcpServers.length === 0" class="chip muted">暂无额外 MCP</span>
                  </div>
                </div>
                <button
                  class="btn"
                  @click="openMcpPicker"
                  :disabled="form.resourcesMode === 'default'"
                  :title="form.resourcesMode === 'default' ? '请先切换到添加模式再选择 MCP 服务器。' : '添加 MCP 服务器'"
                >
                  添加 MCP
                </button>
                <div v-if="showMcpPicker && form.resourcesMode === 'default-plus-selected'" class="picker">
                  <label v-for="server in availableMcpServers" :key="server.name" class="check">
                    <input v-model="pendingMcpServers" type="checkbox" :value="server.name" />
                    {{ server.name }}
                  </label>
                  <div class="picker-actions">
                    <button class="btn" @click="showMcpPicker = false">取消</button>
                    <button class="btn primary" @click="confirmMcpPicker">确认</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>防护规则</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.guards">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.guards }}</span>
              </span>
            </div>
            <p class="section-description">防止此来源创建过多会话或重放过期事件。</p>
            <div class="guard-cards">
              <section class="guard-card" :class="{ enabled: form.guards.rateLimit.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.rateLimit.enabled" type="checkbox" />
                    <strong>速率限制</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.rateLimit">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.rateLimit }}</span>
                  </span>
                </div>
                <p class="setting-help">
                  每 {{ form.guards.rateLimit.windowSeconds || 0 }} 秒最多接受
                  {{ form.guards.rateLimit.maxRequests || 0 }} 个请求。
                </p>
                <div class="guard-fields">
                  <label>
                    <span>最大请求数</span>
                    <input v-model.number="form.guards.rateLimit.maxRequests" type="number" min="1" />
                  </label>
                  <label>
                    <span>窗口秒数</span>
                    <input v-model.number="form.guards.rateLimit.windowSeconds" type="number" min="1" />
                  </label>
                </div>
              </section>

              <section class="guard-card" :class="{ enabled: form.guards.cooldown.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.cooldown.enabled" type="checkbox" />
                    <strong>冷却时间</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.cooldown">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.cooldown }}</span>
                  </span>
                </div>
                <p class="setting-help">适用于一次故障可能在短时间内发送大量重复通知的场景。</p>
                <div class="guard-fields single">
                  <label>
                    <span>冷却秒数</span>
                    <input v-model.number="form.guards.cooldown.seconds" type="number" min="0" />
                  </label>
                </div>
              </section>

              <section class="guard-card" :class="{ enabled: form.guards.dedupe.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.dedupe.enabled" type="checkbox" />
                    <strong>去重</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.dedupe">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.dedupe }}</span>
                  </span>
                </div>
                <p class="setting-help">在 TTL 过期前，拒绝渲染出相同键的事件。</p>
                <div class="guard-fields">
                  <label>
                    <span class="field-label-row">
                      键模板
                      <span class="help-tip" tabindex="0" :aria-label="helpText.dedupeKey">
                        <CircleQuestionMark :size="13" />
                        <span class="tooltip">{{ helpText.dedupeKey }}</span>
                      </span>
                    </span>
                    <input v-model="form.guards.dedupe.keyTemplate" placeholder="{{fields.service}}:{{fields.status}}" />
                  </label>
                  <label>
                    <span>TTL 秒数</span>
                    <input v-model.number="form.guards.dedupe.ttlSeconds" type="number" min="1" />
                  </label>
                </div>
              </section>

              <section class="guard-card" :class="{ enabled: form.guards.replayProtection.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.replayProtection.enabled" type="checkbox" />
                    <strong>时间戳重放检查</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.replayProtection">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.replayProtection }}</span>
                  </span>
                </div>
                <p class="setting-help">当外部服务可以发送请求时间戳 header 时使用。</p>
                <div class="guard-fields">
                  <label>
                    <span class="field-label-row">
                      时间戳 header
                      <span class="help-tip" tabindex="0" :aria-label="helpText.timestampHeader">
                        <CircleQuestionMark :size="13" />
                        <span class="tooltip">{{ helpText.timestampHeader }}</span>
                      </span>
                    </span>
                    <input v-model="form.guards.replayProtection.timestampHeader" placeholder="x-nine1bot-timestamp" />
                  </label>
                  <label>
                    <span>最大偏差秒数</span>
                    <input v-model.number="form.guards.replayProtection.maxSkewSeconds" type="number" min="1" />
                  </label>
                </div>
              </section>
            </div>
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>请求映射</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.requestMapping">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.requestMapping }}</span>
              </span>
            </div>
            <p class="section-description">从传入的 Webhook JSON 中提取需要的值。</p>
            <textarea v-model="form.requestMappingText" spellcheck="false" />
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>Prompt 模板</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.promptTemplate">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.promptTemplate }}</span>
              </span>
            </div>
            <p class="section-description">描述 Agent 应如何处理映射后的事件数据。</p>
            <textarea v-model="form.promptTemplate" class="prompt-template" spellcheck="false" />
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>示例负载</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.samplePayload">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.samplePayload }}</span>
              </span>
            </div>
            <p class="section-description">请使用接近真实的事件，以便预览与线上请求一致。</p>
            <textarea v-model="form.samplePayloadText" class="sample-payload" spellcheck="false" />
            <div class="preview-heading">
              <span>预览</span>
              <span class="help-tip" tabindex="0" :aria-label="helpText.preview">
                <CircleQuestionMark :size="14" />
                <span class="tooltip">{{ helpText.preview }}</span>
              </span>
            </div>
            <div class="preview-grid">
              <div class="preview-card" :class="{ danger: !configPreview.ok }">
                <span>字段</span>
                <pre>{{ configPreview.ok ? formatJson(configPreview.fields) : configPreview.error }}</pre>
              </div>
              <div class="preview-card">
                <span>渲染后的 Prompt</span>
                <pre>{{ configPreview.renderedPrompt || '预览不可用' }}</pre>
              </div>
              <div class="preview-card">
                <span>去重键</span>
                <pre>{{ configPreview.dedupeKey || '暂无法预览去重键' }}</pre>
              </div>
            </div>
          </section>

          <div class="form-actions">
            <button v-if="showCreateForm" class="btn primary" @click="createSource" :disabled="isSaving">
              <Send :size="16" />
              创建来源
            </button>
            <button v-else class="btn primary" @click="saveSource" :disabled="!selectedSource || isSaving">
              <Save :size="16" />
              保存来源
            </button>
          </div>

          <section v-if="!showCreateForm" class="panel wide">
            <h3>最近运行</h3>
            <div class="run-list">
              <div
                v-for="run in runPageItems"
                :key="run.id"
                class="run-row"
                :class="{ active: selectedRunId === run.id }"
                @click="selectRun(run)"
              >
                <span class="pill" :class="statusClass(run)">{{ runStatusLabel(run.status) }}</span>
                <span>{{ formatTime(run.time.received) }}</span>
                <span>{{ run.httpStatus || '-' }}</span>
                <span class="run-error">{{ runSummary(run) }}</span>
                <button v-if="run.sessionID" class="link-btn" @click.stop="openRunSession(run)">打开会话</button>
                <span v-else class="muted-text">{{ guardTypeLabel(run.guardType) || '无会话' }}</span>
              </div>
              <div v-if="isRunPageLoading && runPageItems.length === 0" class="empty-note">
                正在加载运行记录...
              </div>
              <div v-else-if="runPageItems.length === 0" class="empty-note">
                暂无运行记录。
              </div>
            </div>
            <div v-if="runPageItems.length > 0 || runPage > 1" class="run-pagination">
              <button class="btn" @click="previousRunPage" :disabled="runPage <= 1 || isRunPageLoading">
                上一页
              </button>
              <span>第 {{ runPage }} 页</span>
              <button class="btn" @click="nextRunPage" :disabled="!runPageHasNext || isRunPageLoading">
                下一页
              </button>
            </div>
            <div v-if="selectedRun" class="run-detail">
              <div class="run-detail-head">
                <strong>{{ selectedRun.id }}</strong>
                <span class="pill" :class="statusClass(selectedRun)">{{ runStatusLabel(selectedRun.status) }}</span>
                <button v-if="selectedRun.sessionID" class="link-btn" @click="openRunSession(selectedRun)">打开会话</button>
              </div>
              <div class="run-detail-grid">
                <label>
                  <span>HTTP 响应</span>
                  <pre>{{ selectedRun.httpStatus || '-' }}</pre>
                </label>
                <label>
                  <span>防护</span>
                  <pre>{{ selectedRun.guardType ? `${guardTypeLabel(selectedRun.guardType)}: ${selectedRun.guardReason || ''}` : '未触发防护' }}</pre>
                </label>
                <label>
                  <span>去重键</span>
                  <pre>{{ selectedRun.dedupeKey || '-' }}</pre>
                </label>
                <label>
                  <span>请求摘要</span>
                  <pre>{{ formatJson(selectedRun.requestSummary || {}) }}</pre>
                </label>
                <label>
                  <span>渲染 Prompt 预览</span>
                  <pre>{{ selectedRun.renderedPromptPreview || '-' }}</pre>
                </label>
                <label>
                  <span>响应体</span>
                  <pre>{{ formatJson(selectedRun.responseBody || {}) }}</pre>
                </label>
              </div>
            </div>
          </section>
        </div>
      </main>
    </section>
  </div>
</template>

<style scoped>
.webhooks-page {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  padding: var(--space-lg);
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.45;
  overflow: auto;
}

.webhooks-page.embedded {
  padding: 0;
  overflow: visible;
}

.webhooks-header,
.detail-header,
.header-actions,
.detail-actions,
.address-heading,
.endpoint-row,
.form-actions,
.picker-actions,
.chips,
.segmented {
  display: flex;
  align-items: center;
}

.webhooks-header {
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
}

.webhooks-header h1,
.detail-header h2 {
  margin: 0;
  font-weight: 650;
  line-height: 1.2;
}

.webhooks-header h1 {
  font-size: var(--text-3xl);
}

.detail-header h2 {
  font-size: var(--text-2xl);
}

.header-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-sm);
  color: var(--text-muted);
  margin-top: var(--space-xs);
}

.header-actions,
.detail-actions,
.form-actions,
.picker-actions,
.segmented {
  gap: var(--space-sm);
}

.btn,
.icon-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: var(--text-13);
  font-weight: 500;
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}

.btn {
  height: 36px;
  padding: 0 var(--space-md);
}

.icon-btn {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}

.btn:hover:not(:disabled),
.icon-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--border-hover);
}

.btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.btn.danger,
.hint.danger {
  color: var(--error);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-lg);
  box-shadow: var(--shadow-sm);
}

.address-card,
.panel,
.sources-column,
.detail-column {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
}

.address-card,
.panel {
  padding: var(--space-md);
  min-width: 0;
}

.address-heading {
  justify-content: space-between;
  gap: var(--space-sm);
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 650;
  margin-bottom: var(--space-sm);
}

code {
  font-family: var(--font-mono);
  word-break: break-all;
  font-size: var(--text-sm);
  font-weight: 500;
  line-height: 1.45;
}

.copy-base {
  align-self: center;
}

.webhooks-workspace {
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  gap: var(--space-lg);
  min-height: 620px;
  align-items: start;
}

.sources-column,
.detail-column {
  min-width: 0;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}

.column-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-md);
  border-bottom: 1px solid var(--border-default);
}

.column-header h2,
.panel h3 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 650;
  line-height: 1.2;
}

.panel h3 {
  margin-bottom: var(--space-md);
}

.source-item {
  width: calc(100% - var(--space-md) * 2);
  margin: var(--space-xs) var(--space-md);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: center;
  padding: var(--space-sm);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.source-item.active {
  background: var(--bg-secondary);
  border-color: var(--border-default);
}

.source-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-subtle);
}

.source-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.source-copy strong,
.source-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-copy span,
.source-runs {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.detail-header p,
.muted-text,
.hint,
.runtime-list span,
.mcp-group span,
.summary-line {
  color: var(--text-muted);
  font-size: var(--text-13);
}

.detail-header {
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-md);
  border-bottom: 1px solid var(--border-default);
}

.detail-header p {
  margin: 2px 0 0;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
  padding: var(--space-lg);
}

.panel.wide,
.form-actions {
  grid-column: 1 / -1;
}

.section-heading {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-xs);
}

.section-heading h3 {
  margin: 0;
}

.section-description {
  margin: 0 0 var(--space-md);
  color: var(--text-muted);
  font-size: var(--text-13);
  line-height: 1.45;
}

.preview-heading {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin: var(--space-md) 0 var(--space-sm);
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 650;
}

.help-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-muted);
  cursor: help;
}

.help-tip:focus {
  outline: none;
}

.help-tip:hover,
.help-tip:focus-visible {
  color: var(--accent);
}

.help-tip .tooltip {
  position: absolute;
  z-index: var(--z-raised);
  left: 50%;
  bottom: calc(100% + 8px);
  width: 260px;
  transform: translateX(-50%);
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 500;
  line-height: 1.45;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.help-tip .tooltip::after {
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 9px;
  height: 9px;
  content: '';
  transform: translateX(-50%) rotate(45deg);
  border-right: 1px solid var(--border-default);
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-elevated);
}

.help-tip:hover .tooltip,
.help-tip:focus-visible .tooltip {
  opacity: 1;
  transform: translateX(-50%) translateY(-2px);
}

.field-grid,
.runtime-card,
.mcp-group,
.mode-options,
.picker,
.run-list,
.preset-grid,
.preview-grid,
.run-detail-grid {
  display: grid;
  gap: var(--space-md);
}

label {
  display: grid;
  gap: var(--space-xs);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 650;
}

label span,
.section-title {
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 650;
}

input,
select,
textarea,
.endpoint-row {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-13);
}

input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
}

input,
select {
  height: 36px;
  padding: 0 var(--space-sm);
}

textarea {
  min-height: 120px;
  padding: var(--space-sm);
  resize: vertical;
  line-height: 1.45;
}

.prompt-template {
  min-height: 190px;
}

.endpoint-row {
  padding: 0 0 0 var(--space-sm);
  gap: var(--space-sm);
}

.endpoint-row code {
  flex: 1;
  min-width: 0;
}

.check,
.segmented label {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.check input,
.segmented input {
  width: 16px;
  height: 16px;
}

.runtime-grid,
.guard-grid,
.model-selectors,
.preset-grid,
.preview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
}

.guard-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.guard-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
}

.guard-card {
  display: grid;
  gap: var(--space-sm);
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  background: var(--bg-primary);
}

.guard-card.enabled {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default));
  background: color-mix(in srgb, var(--accent) 5%, var(--bg-primary));
}

.guard-card-head,
.field-label-row {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.guard-card-head {
  justify-content: space-between;
}

.guard-card-head .check {
  min-width: 0;
}

.guard-card-head strong {
  color: var(--text-primary);
  font-size: var(--text-base);
}

.setting-help {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: 1.45;
}

.guard-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.guard-fields.single {
  grid-template-columns: 1fr;
}

.preset-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.runtime-card,
.picker,
.preset-card,
.preview-card,
.run-detail {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}

.mode-options {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.mode-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  cursor: pointer;
}

.mode-option.active {
  border-color: var(--accent);
  background: var(--accent-subtle);
}

.mode-option input {
  width: 16px;
  height: 16px;
  padding: 0;
  margin-top: 2px;
}

.mode-option span {
  display: grid;
  gap: 2px;
}

.mode-option strong {
  font-size: var(--text-13);
  font-weight: 650;
  color: var(--text-primary);
}

.mode-option small {
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.35;
}

.mcp-group.current {
  padding: var(--space-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
}

.preset-card {
  display: grid;
  gap: var(--space-xs);
  text-align: left;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
}

.preset-card.active {
  border-color: var(--accent);
  background: var(--accent-subtle);
}

.preset-card span,
.preview-card span {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.sample-payload {
  min-height: 150px;
}

.preview-card {
  min-width: 0;
  background: var(--bg-secondary);
}

.preview-card.danger {
  border-color: var(--error);
}

.preview-card pre,
.run-detail pre {
  font-family: var(--font-mono);
  margin: var(--space-xs) 0 0;
  max-height: 230px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--text-sm);
  line-height: 1.45;
}

.chips {
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 24px;
  border-radius: var(--radius-full);
  padding: 0 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.chip.muted {
  color: var(--text-muted);
}

.chip.strong {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default));
  background: var(--accent-subtle);
}

.chip.inactive {
  opacity: 0.55;
  text-decoration: line-through;
}

.chip.removable {
  cursor: pointer;
}

.hint {
  margin: 0;
}

.hint.success {
  color: var(--success);
}

.run-row {
  display: grid;
  grid-template-columns: auto 170px 70px minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: center;
  min-height: 42px;
  border-bottom: 1px solid var(--border-default);
  font-size: var(--text-13);
  cursor: pointer;
}

.run-row:last-child {
  border-bottom: 0;
}

.run-row.active {
  background: var(--bg-secondary);
}

.run-error {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.run-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-md);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.run-pagination .btn {
  height: 32px;
  padding: 0 var(--space-sm);
}

.link-btn {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-weight: 650;
  cursor: pointer;
}

.run-detail {
  margin-top: var(--space-md);
  background: var(--bg-secondary);
}

.run-detail-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  justify-content: space-between;
  margin-bottom: var(--space-md);
}

.run-detail-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  border-radius: var(--radius-full);
  padding: 0 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 650;
  white-space: nowrap;
}

.pill.ok {
  color: var(--success);
  background: var(--success-subtle);
}

.pill.warn {
  color: var(--warning);
  background: var(--warning-subtle);
}

.pill.danger {
  color: var(--error);
  background: var(--error-subtle);
}

.pill.blue {
  color: var(--accent);
  background: var(--accent-subtle);
}

.pill.muted {
  color: var(--text-muted);
}

.notice {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-md);
  color: var(--success);
}

.notice.error {
  color: var(--error);
}

.empty-note {
  color: var(--text-muted);
  padding: var(--space-md);
}

.spin {
  animation: spin 1s linear infinite;
}

@media (max-width: 1100px) {
  .status-band,
  .webhooks-workspace,
  .detail-grid,
  .runtime-grid,
  .guard-grid,
  .guard-cards,
  .guard-fields,
  .model-selectors,
  .preset-grid,
  .preview-grid,
  .run-detail-grid {
    grid-template-columns: 1fr;
  }

  .run-row {
    grid-template-columns: 1fr;
    align-items: start;
    padding: var(--space-sm) 0;
  }
}
</style>
