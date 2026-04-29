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
const helpText = {
  guards: 'Guards reject noisy, duplicate, or stale webhook requests before they create an agent session.',
  rateLimit: 'Limits how many requests this source accepts within one time window.',
  cooldown: 'After a request is accepted, this source waits before accepting another one.',
  dedupe: 'Rejects requests that render the same dedupe key during the TTL.',
  dedupeKey: 'Build a stable key from mapped fields, body, headers, query, source, or project values.',
  replayProtection: 'Requires a timestamp header and rejects requests outside the allowed time skew.',
  timestampHeader: 'The external service must send this header with a Unix seconds, Unix milliseconds, or ISO timestamp.',
  requestMapping: 'Map JSON paths from body, headers, or query into fields. These fields are available as {{fields.name}} in templates.',
  promptTemplate: 'This becomes the first user message sent to the agent when a webhook event is accepted.',
  samplePayload: 'Paste an example JSON payload to preview fields, prompt rendering, and dedupe key without creating a run.',
  preview: 'Preview updates locally in the browser. It does not call the webhook endpoint or start an agent.',
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
const defaultModelLabel = ref('Default model from user config')
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)
const selectedRunId = ref('')
const endpointPanel = ref<HTMLElement | null>(null)

const form = ref(defaultForm())

const isEmbedded = computed(() => props.embedded)
const selectedSource = computed(() => sources.value.find((source) => source.id === selectedSourceId.value) || null)
const selectedRuns = computed(() => {
  if (!selectedSourceId.value) return runs.value
  return runs.value.filter((run) => run.sourceID === selectedSourceId.value)
})
const selectedRun = computed(() => selectedRuns.value.find((run) => run.id === selectedRunId.value) || null)

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
    return 'Webhook sessions inherit only the default MCP configuration.'
  }
  return 'Webhook sessions inherit default MCP and add the selected MCP servers.'
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
      showCreateForm.value = true
    } else {
      loadFormFromSource(selectedSource.value)
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
    return 'Request was cancelled or timed out. Refresh to retry.'
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
  return modelLabelFromList(providerData.providers, providerID, modelID) || 'Default model from user config'
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
  if (!form.value.name.trim()) throw new Error('Source name is required')
  if (!form.value.projectID) throw new Error('Project is required')
  if (form.value.modelMode === 'custom' && (!form.value.modelProviderID || !form.value.modelID)) {
    throw new Error('Custom model requires a provider and model.')
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
    notice.value = 'Webhook source created. Copy the full URL now; the secret is shown only once.'
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
    notice.value = 'Webhook source saved.'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function sendTest() {
  const source = selectedSource.value
  const secret = currentSecretFor(source)
  if (!source) return
  error.value = ''
  notice.value = ''
  if (!secret) {
    error.value = 'Send test requires the full URL shown after creating or refreshing the secret.'
    return
  }
  let payload: unknown
  try {
    payload = JSON.parse(form.value.samplePayloadText || '{}')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return
  }
  isSendingTest.value = true
  try {
    const result = await webhookApi.sendTest(endpointUrl(source, secret), payload)
    notice.value = `Test sent. HTTP ${result.status}.`
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
    notice.value = 'Webhook secret refreshed. Copy the new full URL now; the old URL is invalid.'
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
  if (!confirm(`Delete webhook source "${source.name}"? Historical runs will be kept.`)) return
  error.value = ''
  notice.value = ''
  isSaving.value = true
  try {
    await webhookApi.deleteSource(source.id)
    sources.value = await webhookApi.sources()
    selectedSourceId.value = sources.value[0]?.id || ''
    if (!selectedSourceId.value) {
      showCreateForm.value = true
      resetCreateForm()
    }
    notice.value = 'Webhook source deleted.'
    await refreshRuns()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function refreshRuns() {
  runs.value = await webhookApi.runs({ limit: 100 })
}

async function copyText(text: string) {
  if (!text) return
  error.value = ''
  notice.value = ''
  if (!navigator.clipboard?.writeText) {
    error.value = 'Clipboard is not available in this browser.'
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    notice.value = 'Copied.'
  } catch {
    error.value = 'Unable to copy to clipboard.'
  }
}

async function openRunSession(run: WebhookRun) {
  if (!run.sessionID) return
  error.value = ''
  try {
    const sessions = await projectApi.sessions(run.projectID, { roots: true, limit: 300 })
    const session = sessions.find((item) => item.id === run.sessionID)
    if (!session) {
      throw new Error('Session no longer exists')
    }
    emit('selectSession', session)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function beginCreate() {
  showCreateForm.value = true
  selectedSourceId.value = ''
  selectedRunId.value = ''
  revealedSecret.value = ''
  revealedSecretSourceId.value = ''
  resetCreateForm()
}

function selectSource(source: WebhookSource) {
  showCreateForm.value = false
  selectedSourceId.value = source.id
  selectedRunId.value = ''
  showMcpPicker.value = false
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
  const ok = confirm('Full permission mode will automatically allow permission requests for webhook sessions. Continue?')
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
          <span class="pill ok">{{ enabledCount }} enabled</span>
          <span class="pill warn">{{ rejectedTodayCount }} guarded today</span>
          <span>Project-bound external triggers</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn" @click="loadAll" :disabled="isLoading">
          <RefreshCw :size="16" :class="{ spin: isLoading }" />
          Refresh
        </button>
        <button class="btn primary" @click="beginCreate">
          <Plus :size="16" />
          New source
        </button>
      </div>
    </header>

    <section class="status-band">
      <div class="address-card">
        <div class="address-heading">
          <span>Local address</span>
          <span class="pill ok">{{ status?.listening ? 'Listening' : 'Stopped' }}</span>
        </div>
        <code>{{ status?.localWebhookUrl || 'Loading...' }}</code>
      </div>
      <div class="address-card">
        <div class="address-heading">
          <span>Tunnel address</span>
          <span class="pill" :class="status?.tunnel.enabled ? 'ok' : 'muted'">{{ status?.tunnel.status || 'disabled' }}</span>
        </div>
        <code>{{ status?.publicWebhookUrl || 'No tunnel URL available' }}</code>
      </div>
      <button class="btn copy-base" @click="copyText(status?.localWebhookUrl || '')">
        <Copy :size="16" />
        Copy URL
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
          <h2>Sources</h2>
          <span class="pill blue">{{ sources.length }} total</span>
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
            <span>{{ projectLabel(source.projectID) }} · {{ source.permissionPolicy.mode }} permissions</span>
          </span>
          <span class="source-runs">{{ runs.filter((run) => run.sourceID === source.id).length }} runs</span>
        </button>
        <div v-if="sources.length === 0" class="empty-note">
          No webhook sources yet.
        </div>
      </aside>

      <main class="detail-column">
        <div class="detail-header">
          <div>
            <h2>{{ showCreateForm ? 'New webhook source' : selectedSource?.name || 'Webhook source' }}</h2>
            <p>{{ showCreateForm ? 'Create a generic JSON webhook entry point.' : projectLabel(selectedSource?.projectID || '') }}</p>
          </div>
          <div v-if="selectedSource && !showCreateForm" class="detail-actions">
            <button class="btn" @click="copyText(endpointUrl(selectedSource, currentSecretFor(selectedSource)))">
              <Copy :size="16" />
              Copy
            </button>
            <button class="btn" @click="sendTest" :disabled="isSaving || isSendingTest || !currentSecretFor(selectedSource)">
              <Send :size="16" />
              Send test
            </button>
            <button class="btn" @click="refreshSecret" :disabled="isSaving">
              <RotateCw :size="16" />
              Refresh secret
            </button>
            <button class="btn danger" @click="deleteSource" :disabled="isSaving">
              <Trash2 :size="16" />
              Delete
            </button>
          </div>
        </div>

        <div class="detail-grid">
          <section v-if="showCreateForm" class="panel wide">
            <h3>Preset</h3>
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
            <h3>Endpoint</h3>
            <div class="field-grid">
              <label>
                <span>Local URL</span>
                <div class="endpoint-row">
                  <code>{{ endpointUrl(selectedSource, currentSecretFor(selectedSource)) || 'Create a source to get URL' }}</code>
                  <button class="icon-btn" @click="copyText(endpointUrl(selectedSource, currentSecretFor(selectedSource)))">
                    <Copy :size="15" />
                  </button>
                </div>
              </label>
              <label v-if="status?.publicWebhookUrl">
                <span>Public URL</span>
                <div class="endpoint-row">
                  <code>{{ endpointUrl(selectedSource, currentSecretFor(selectedSource), true) }}</code>
                  <button class="icon-btn" @click="copyText(endpointUrl(selectedSource, currentSecretFor(selectedSource), true))">
                    <Copy :size="15" />
                  </button>
                </div>
              </label>
              <p v-if="revealedSecretSourceId === selectedSource?.id && revealedSecret" class="hint success">
                Full URL is shown once. Copy it before leaving this source.
              </p>
              <p v-if="selectedSource && !currentSecretFor(selectedSource)" class="hint">
                Send test requires the one-time full URL from create or refresh secret.
              </p>
            </div>
          </section>

          <section class="panel">
            <h3>Source</h3>
            <div class="field-grid">
              <label>
                <span>Name</span>
                <input v-model="form.name" placeholder="Uptime Kuma Production" />
              </label>
              <label>
                <span>Project</span>
                <select v-model="form.projectID">
                  <option value="" disabled>Select project</option>
                  <option v-for="project in sortedProjects" :key="project.id" :value="project.id">
                    {{ projectLabel(project.id) }}
                  </option>
                </select>
              </label>
              <label class="check">
                <input v-model="form.enabled" type="checkbox" />
                Enabled
              </label>
            </div>
          </section>

          <section class="panel">
            <h3>Permissions</h3>
            <div class="segmented">
              <label><input v-model="form.permissionMode" type="radio" value="default" @change="handlePermissionModeChange" /> default</label>
              <label><input v-model="form.permissionMode" type="radio" value="full" @change="handlePermissionModeChange" /> full</label>
            </div>
            <p class="hint" :class="{ danger: form.permissionMode === 'full' }">
              {{ form.permissionMode === 'full' ? 'Permission requests are automatically allowed for webhook sessions.' : 'Permission and question asks are automatically denied.' }}
            </p>
            <p v-if="form.permissionMode === 'full' && fullPermissionConfirmed" class="hint danger">
              Full permission mode confirmed.
            </p>
          </section>

          <section class="panel wide">
            <h3>Runtime</h3>
            <div class="runtime-grid">
              <div class="runtime-card">
                <div class="section-title">Model</div>
                <div class="segmented">
                  <label><input v-model="form.modelMode" type="radio" value="default" /> default</label>
                  <label><input v-model="form.modelMode" type="radio" value="custom" /> custom</label>
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
                <div class="section-title">MCP Servers</div>
                <div class="mode-options">
                  <label class="mode-option" :class="{ active: form.resourcesMode === 'default' }">
                    <input v-model="form.resourcesMode" type="radio" value="default" />
                    <span>
                      <strong>default</strong>
                      <small>Use only default MCP</small>
                    </span>
                  </label>
                  <label class="mode-option" :class="{ active: form.resourcesMode === 'default-plus-selected' }">
                    <input v-model="form.resourcesMode" type="radio" value="default-plus-selected" />
                    <span>
                      <strong>add</strong>
                      <small>Default MCP plus selected MCP</small>
                    </span>
                  </label>
                </div>
                <p class="hint">{{ mcpModeDescription }}</p>

                <div class="mcp-group current">
                  <span>Current MCP available to agent</span>
                  <div class="chips">
                    <span v-for="server in effectiveMcpServers" :key="server" class="chip strong">{{ server }}</span>
                    <span v-if="effectiveMcpServers.length === 0" class="chip muted">No MCP available</span>
                  </div>
                </div>

                <div class="mcp-group">
                  <span>Default MCP</span>
                  <div class="chips">
                    <span v-for="server in defaultMcpServers" :key="server" class="chip">{{ server }}</span>
                    <span v-if="defaultMcpServers.length === 0" class="chip muted">No default MCP</span>
                  </div>
                </div>

                <div class="mcp-group">
                  <span>{{ form.resourcesMode === 'default' ? 'Added MCP not used in default mode' : 'Added MCP' }}</span>
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
                    <span v-if="addedMcpServers.length === 0" class="chip muted">No additional MCP</span>
                  </div>
                </div>
                <button
                  class="btn"
                  @click="openMcpPicker"
                  :disabled="form.resourcesMode === 'default'"
                  :title="form.resourcesMode === 'default' ? 'Switch to add mode before selecting MCP servers.' : 'Add MCP servers'"
                >
                  Add MCP
                </button>
                <div v-if="showMcpPicker && form.resourcesMode === 'default-plus-selected'" class="picker">
                  <label v-for="server in availableMcpServers" :key="server.name" class="check">
                    <input v-model="pendingMcpServers" type="checkbox" :value="server.name" />
                    {{ server.name }}
                  </label>
                  <div class="picker-actions">
                    <button class="btn" @click="showMcpPicker = false">Cancel</button>
                    <button class="btn primary" @click="confirmMcpPicker">Confirm</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>Guards</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.guards">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.guards }}</span>
              </span>
            </div>
            <p class="section-description">Keep this source from creating too many sessions or replaying stale events.</p>
            <div class="guard-cards">
              <section class="guard-card" :class="{ enabled: form.guards.rateLimit.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.rateLimit.enabled" type="checkbox" />
                    <strong>Rate limit</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.rateLimit">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.rateLimit }}</span>
                  </span>
                </div>
                <p class="setting-help">
                  Accept up to {{ form.guards.rateLimit.maxRequests || 0 }} requests every
                  {{ form.guards.rateLimit.windowSeconds || 0 }} seconds.
                </p>
                <div class="guard-fields">
                  <label>
                    <span>Max requests</span>
                    <input v-model.number="form.guards.rateLimit.maxRequests" type="number" min="1" />
                  </label>
                  <label>
                    <span>Window seconds</span>
                    <input v-model.number="form.guards.rateLimit.windowSeconds" type="number" min="1" />
                  </label>
                </div>
              </section>

              <section class="guard-card" :class="{ enabled: form.guards.cooldown.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.cooldown.enabled" type="checkbox" />
                    <strong>Cooldown</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.cooldown">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.cooldown }}</span>
                  </span>
                </div>
                <p class="setting-help">Useful when one incident can send repeated notifications in a short burst.</p>
                <div class="guard-fields single">
                  <label>
                    <span>Cooldown seconds</span>
                    <input v-model.number="form.guards.cooldown.seconds" type="number" min="0" />
                  </label>
                </div>
              </section>

              <section class="guard-card" :class="{ enabled: form.guards.dedupe.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.dedupe.enabled" type="checkbox" />
                    <strong>Dedupe</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.dedupe">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.dedupe }}</span>
                  </span>
                </div>
                <p class="setting-help">Reject events with the same rendered key until the TTL expires.</p>
                <div class="guard-fields">
                  <label>
                    <span class="field-label-row">
                      Key template
                      <span class="help-tip" tabindex="0" :aria-label="helpText.dedupeKey">
                        <CircleQuestionMark :size="13" />
                        <span class="tooltip">{{ helpText.dedupeKey }}</span>
                      </span>
                    </span>
                    <input v-model="form.guards.dedupe.keyTemplate" placeholder="{{fields.service}}:{{fields.status}}" />
                  </label>
                  <label>
                    <span>TTL seconds</span>
                    <input v-model.number="form.guards.dedupe.ttlSeconds" type="number" min="1" />
                  </label>
                </div>
              </section>

              <section class="guard-card" :class="{ enabled: form.guards.replayProtection.enabled }">
                <div class="guard-card-head">
                  <label class="check">
                    <input v-model="form.guards.replayProtection.enabled" type="checkbox" />
                    <strong>Timestamp replay check</strong>
                  </label>
                  <span class="help-tip" tabindex="0" :aria-label="helpText.replayProtection">
                    <CircleQuestionMark :size="14" />
                    <span class="tooltip">{{ helpText.replayProtection }}</span>
                  </span>
                </div>
                <p class="setting-help">Use when the external service can send a request timestamp header.</p>
                <div class="guard-fields">
                  <label>
                    <span class="field-label-row">
                      Timestamp header
                      <span class="help-tip" tabindex="0" :aria-label="helpText.timestampHeader">
                        <CircleQuestionMark :size="13" />
                        <span class="tooltip">{{ helpText.timestampHeader }}</span>
                      </span>
                    </span>
                    <input v-model="form.guards.replayProtection.timestampHeader" placeholder="x-nine1bot-timestamp" />
                  </label>
                  <label>
                    <span>Max skew seconds</span>
                    <input v-model.number="form.guards.replayProtection.maxSkewSeconds" type="number" min="1" />
                  </label>
                </div>
              </section>
            </div>
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>Request Mapping</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.requestMapping">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.requestMapping }}</span>
              </span>
            </div>
            <p class="section-description">Pick the important values out of the incoming webhook JSON.</p>
            <textarea v-model="form.requestMappingText" spellcheck="false" />
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>Prompt Template</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.promptTemplate">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.promptTemplate }}</span>
              </span>
            </div>
            <p class="section-description">Describe what the agent should do with the mapped event data.</p>
            <textarea v-model="form.promptTemplate" class="prompt-template" spellcheck="false" />
          </section>

          <section class="panel wide">
            <div class="section-heading">
              <h3>Sample Payload</h3>
              <span class="help-tip" tabindex="0" :aria-label="helpText.samplePayload">
                <CircleQuestionMark :size="15" />
                <span class="tooltip">{{ helpText.samplePayload }}</span>
              </span>
            </div>
            <p class="section-description">Use a real-looking event here so the preview matches production requests.</p>
            <textarea v-model="form.samplePayloadText" class="sample-payload" spellcheck="false" />
            <div class="preview-heading">
              <span>Preview</span>
              <span class="help-tip" tabindex="0" :aria-label="helpText.preview">
                <CircleQuestionMark :size="14" />
                <span class="tooltip">{{ helpText.preview }}</span>
              </span>
            </div>
            <div class="preview-grid">
              <div class="preview-card" :class="{ danger: !configPreview.ok }">
                <span>Fields</span>
                <pre>{{ configPreview.ok ? formatJson(configPreview.fields) : configPreview.error }}</pre>
              </div>
              <div class="preview-card">
                <span>Rendered prompt</span>
                <pre>{{ configPreview.renderedPrompt || 'Preview unavailable' }}</pre>
              </div>
              <div class="preview-card">
                <span>Dedupe key</span>
                <pre>{{ configPreview.dedupeKey || 'No dedupe key preview' }}</pre>
              </div>
            </div>
          </section>

          <div class="form-actions">
            <button v-if="showCreateForm" class="btn primary" @click="createSource" :disabled="isSaving">
              <Send :size="16" />
              Create source
            </button>
            <button v-else class="btn primary" @click="saveSource" :disabled="!selectedSource || isSaving">
              <Save :size="16" />
              Save source
            </button>
          </div>

          <section v-if="!showCreateForm" class="panel wide">
            <h3>Recent Runs</h3>
            <div class="run-list">
              <div
                v-for="run in selectedRuns"
                :key="run.id"
                class="run-row"
                :class="{ active: selectedRunId === run.id }"
                @click="selectRun(run)"
              >
                <span class="pill" :class="statusClass(run)">{{ run.status }}</span>
                <span>{{ formatTime(run.time.received) }}</span>
                <span>{{ run.httpStatus || '-' }}</span>
                <span class="run-error">{{ runSummary(run) }}</span>
                <button v-if="run.sessionID" class="link-btn" @click.stop="openRunSession(run)">Open session</button>
                <span v-else class="muted-text">{{ run.guardType || 'No session' }}</span>
              </div>
              <div v-if="selectedRuns.length === 0" class="empty-note">
                No runs for this source yet.
              </div>
            </div>
            <div v-if="selectedRun" class="run-detail">
              <div class="run-detail-head">
                <strong>{{ selectedRun.id }}</strong>
                <span class="pill" :class="statusClass(selectedRun)">{{ selectedRun.status }}</span>
                <button v-if="selectedRun.sessionID" class="link-btn" @click="openRunSession(selectedRun)">Open session</button>
              </div>
              <div class="run-detail-grid">
                <label>
                  <span>HTTP response</span>
                  <pre>{{ selectedRun.httpStatus || '-' }}</pre>
                </label>
                <label>
                  <span>Guard</span>
                  <pre>{{ selectedRun.guardType ? `${selectedRun.guardType}: ${selectedRun.guardReason || ''}` : 'No guard triggered' }}</pre>
                </label>
                <label>
                  <span>Dedupe key</span>
                  <pre>{{ selectedRun.dedupeKey || '-' }}</pre>
                </label>
                <label>
                  <span>Request summary</span>
                  <pre>{{ formatJson(selectedRun.requestSummary || {}) }}</pre>
                </label>
                <label>
                  <span>Rendered prompt preview</span>
                  <pre>{{ selectedRun.renderedPromptPreview || '-' }}</pre>
                </label>
                <label>
                  <span>Response body</span>
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
  font-family: var(--font-sans);
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
  font-family: var(--font-sans);
  font-weight: 650;
  line-height: 1.2;
}

.webhooks-header h1 {
  font-size: 30px;
}

.detail-header h2 {
  font-size: 22px;
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
  border: 0.5px solid var(--border-default);
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 13px;
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
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-lg);
  box-shadow: var(--shadow-sm);
}

.address-card,
.panel,
.sources-column,
.detail-column {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
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
  font-size: 12px;
  font-weight: 650;
  text-transform: uppercase;
  margin-bottom: var(--space-sm);
}

code {
  font-family: var(--font-mono);
  word-break: break-all;
  font-size: 12px;
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
  border-bottom: 0.5px solid var(--border-default);
}

.column-header h2,
.panel h3 {
  margin: 0;
  font-size: 15px;
  font-family: var(--font-sans);
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
  font-size: 12px;
}

.detail-header p,
.muted-text,
.hint,
.runtime-list span,
.mcp-group span,
.summary-line {
  color: var(--text-muted);
  font-size: 13px;
}

.detail-header {
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-md);
  border-bottom: 0.5px solid var(--border-default);
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
  font-size: 13px;
  line-height: 1.45;
}

.preview-heading {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin: var(--space-md) 0 var(--space-sm);
  color: var(--text-muted);
  font-size: 12px;
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
  z-index: 20;
  left: 50%;
  bottom: calc(100% + 8px);
  width: 260px;
  transform: translateX(-50%);
  padding: 8px 10px;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
  color: var(--text-secondary);
  font-size: 12px;
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
  border-right: 0.5px solid var(--border-default);
  border-bottom: 0.5px solid var(--border-default);
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
  font-size: 12px;
  font-weight: 650;
}

label span,
.section-title {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 650;
}

input,
select,
textarea,
.endpoint-row {
  width: 100%;
  min-width: 0;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
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
  border: 0.5px solid var(--border-default);
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
  font-size: 14px;
}

.setting-help {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
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
  border: 0.5px solid var(--border-default);
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
  border: 0.5px solid var(--border-default);
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
  font-size: 13px;
  font-weight: 650;
  color: var(--text-primary);
}

.mode-option small {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.35;
}

.mcp-group.current {
  padding: var(--space-sm);
  border: 0.5px solid var(--border-default);
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
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 12px;
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
  border-bottom: 0.5px solid var(--border-default);
  font-size: 13px;
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
  font-size: 12px;
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
  border: 0.5px solid var(--border-default);
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

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
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
