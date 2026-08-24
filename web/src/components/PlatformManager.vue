<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { GITLAB_REVIEW_PROJECT_CONTEXT_MAX_LENGTH } from '@nine1bot/platform-gitlab/review/limits'
import { CheckCircle2, CircleAlert, CircleSlash, Copy, Play, RefreshCw, Save, Trash2 } from 'lucide-vue-next'
import { gitLabReviewApi, platformApi, webhookApi, type GitLabReviewRun, type WebhookStatus } from '../api/client'
import type {
  PlatformActionDescriptor,
  PlatformConfigField,
  PlatformDetail,
  PlatformSummary,
  PlatformActionResult,
  Nine1BotProjectOption,
  Provider,
} from '../api/client'
import { copyText } from '../utils/clipboard'
import {
  createGitLabProjectProfile,
  gitLabProjectIdentityKey,
  optionalGitLabProfileNumber as optionalProfileNumber,
  positiveGitLabProfileNumber as positiveProfileNumber,
  validateGitLabProjectBindings,
  type GitLabProjectProfile,
  type GitLabProjectRef,
} from '../lib/gitlab-project-profiles'
import {
  appendGitLabProjectProfileDocument,
  gitLabProjectProfileDiagnosticKey,
  gitLabProjectProfileDiagnosticLabel,
  parseGitLabProjectProfileDocument,
  removeGitLabProjectProfileDocument,
  renderGitLabProjectProfileDocument,
  serializeGitLabProjectProfileDocument,
  updateGitLabProjectProfileDocument,
  validateGitLabProjectProfileDocument,
} from '../lib/gitlab-project-profile-document'
import {
  canRetryGitLabReviewRun as canRetryGitLabReviewRunPolicy,
  isIgnoredGitLabReviewRun,
  isOperationalGitLabReviewRun,
  reviewRunStatusLabel,
} from '../lib/gitlab-review-runs'
import { gitLabCliGuide } from '../lib/gitlab-cli-guide'

const props = defineProps<{
  platforms: PlatformSummary[]
  selectedPlatform: PlatformDetail | null
  selectedPlatformId: string
  loading: boolean
  saving: boolean
  actionRunning: string
  error: string
  actionResult: PlatformActionResult | null
  providers: Provider[]
  projects: Nine1BotProjectOption[]
}>()

const emit = defineEmits<{
  select: [id: string]
  update: [id: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }]
  refresh: [id: string]
  action: [id: string, actionId: string, input?: unknown, confirm?: boolean]
}>()

const enabledDraft = ref(true)
const formValues = reactive<Record<string, string | number | boolean>>({})
const secretClears = reactive<Record<string, boolean>>({})
const jsonErrors = reactive<Record<string, string>>({})
const gitLabReviewRuns = ref<GitLabReviewRun[]>([])
const webhookStatus = ref<WebhookStatus | null>(null)
const loadingGitLabRuns = ref(false)
const gitLabRunsError = ref('')
const gitLabWebhookUrlMessage = ref('')
const gitLabProjectSearchQuery = ref('')
const gitLabProjectSearchResults = ref<GitLabProjectRef[]>([])
const gitLabProjectSearchError = ref('')
const searchingGitLabProjects = ref(false)
const gitLabGroupSearchQuery = ref('')
const gitLabGroupSearchResults = ref<GitLabGroupRef[]>([])
const gitLabGroupSearchError = ref('')
const searchingGitLabGroups = ref(false)
const gitLabAdvancedConfig = ref(false)
const retryingGitLabRunIds = ref<Set<string>>(new Set())
const actionFormValues = reactive<Record<string, Record<string, string | number | boolean>>>({})
const actionJsonErrors = reactive<Record<string, Record<string, string>>>({})

const configFields = computed(() => {
  return props.selectedPlatform?.config?.sections.flatMap((section) => section.fields) ?? []
})
const configFormSections = computed(() => {
  if (!isGitLabPlatform.value) return props.selectedPlatform?.config?.sections ?? []
  const fieldsByKey = new Map(configFields.value.map((field) => [field.key, field]))
  const usedKeys = new Set<string>()
  const groups = [
    {
      id: 'gitlab-connection',
      title: '连接与密钥',
      description: '配置 GitLab 实例地址、API token 和专用 webhook secret。',
      keys: ['review.baseUrl', 'review.tokenSecretRef', 'review.webhookSecretRef'],
    },
    {
      id: 'gitlab-trigger',
      title: '触发入口',
      description: '配置评论触发词、自动审查开关和允许触发 review 的项目范围。',
      keys: ['review.botMention', 'review.webhookAutoReview', 'review.scopeMode', 'review.includedProjects', 'review.excludedProjects', 'review.hookGroups'],
    },
    {
      id: 'gitlab-review-policy',
      title: '审查策略',
      description: '控制是否启用 review、发布方式、行内评论和专用模型。',
      keys: ['review.enabled', 'review.dryRun', 'review.inlineComments', 'review.modelProviderId', 'review.modelId'],
    },
    {
      id: 'gitlab-page-context',
      title: '页面与 CLI 访问',
      description: '控制浏览器插件页面上下文和 CLI wrapper 允许访问的 GitLab 实例。',
      keys: ['allowedHosts', 'apiEnrichment'],
    },
  ].map((group) => {
    const fields = group.keys
      .map((key) => fieldsByKey.get(key))
      .filter((field): field is PlatformConfigField => Boolean(field))
    fields.forEach((field) => usedKeys.add(field.key))
    return {
      id: group.id,
      title: group.title,
      description: group.description,
      fields,
    }
  }).filter((group) => group.fields.length > 0)

  const otherFields = configFields.value.filter((field) => !usedKeys.has(field.key))
  if (otherFields.length > 0) {
    groups.push({
      id: 'gitlab-other',
      title: '其他配置',
      description: '平台插件暴露的其他高级配置。',
      fields: otherFields,
    })
  }
  return groups
})
const gitLabFieldMap = computed(() => new Map(configFields.value.map((field) => [field.key, field])))
const gitLabMvpFields = computed(() => [
  'review.baseUrl',
  'review.webhookSecretRef',
  'review.tokenSecretRef',
  'review.enabled',
  'review.dryRun',
  'review.modelId',
].map((key) => gitLabFieldMap.value.get(key)).filter((field): field is PlatformConfigField => Boolean(field)))
const operationLocked = computed(() => props.saving || Boolean(props.actionRunning))
const healthRefreshing = computed(() => props.actionRunning === 'health')
const isGitLabPlatform = computed(() => props.selectedPlatform?.id === 'gitlab')
const visibleGitLabRuns = computed(() => gitLabReviewRuns.value.filter(isOperationalGitLabReviewRun).slice(0, 8))
const visibleGitLabIgnoredEvents = computed(() => gitLabReviewRuns.value.filter(isIgnoredGitLabReviewRun).slice(0, 8))
const gitLabWebhookPath = '/webhooks/gitlab/{webhookSecret}'
const gitLabWebhookSecretFieldKey = 'review.webhookSecretRef'
const gitLabReviewModelProviderFieldKey = 'review.modelProviderId'
const gitLabReviewModelFieldKey = 'review.modelId'
const gitLabMvpFieldKeys = new Set([
  'review.baseUrl',
  'review.webhookSecretRef',
  'review.tokenSecretRef',
  'review.enabled',
  'review.dryRun',
  'review.modelProviderId',
  'review.modelId',
])
const gitLabIncludedProjectsFieldKey = 'review.includedProjects'
const gitLabExcludedProjectsFieldKey = 'review.excludedProjects'
const gitLabScopeModeFieldKey = 'review.scopeMode'
const gitLabHookGroupsFieldKey = 'review.hookGroups'
const gitLabProjectProfilesFieldKey = 'review.projects'
type GitLabGroupRef = {
  id: string | number
  fullPath?: string
  webUrl?: string
}
const authenticatedModelCount = computed(() => {
  return props.providers.filter((provider) => provider.authenticated).reduce((total, provider) => total + provider.models.length, 0)
})
const gitLabIncludedProjects = computed(() => parseGitLabProjectRefs(textValue(gitLabIncludedProjectsFieldKey)))
const gitLabExcludedProjects = computed(() => parseGitLabProjectRefs(textValue(gitLabExcludedProjectsFieldKey)))
const gitLabHookGroups = computed(() => parseGitLabGroupRefs(textValue(gitLabHookGroupsFieldKey)))
const gitLabProjectProfileDocument = computed(() => parseGitLabProjectProfileDocument(textValue(gitLabProjectProfilesFieldKey)))
const gitLabProjectProfileDiagnostics = computed(() => validateGitLabProjectProfileDocument(gitLabProjectProfileDocument.value))
const gitLabProjectProfiles = computed(() => gitLabProjectProfileDocument.value.editable.map((entry) => entry.profile))
const gitLabProjectProfileFormError = computed(() => gitLabProjectProfilesValidationError())
const gitLabDeactivationSave = computed(() => {
  const platform = props.selectedPlatform
  if (!isGitLabPlatform.value || !platform) return false
  const disablesPlatform = platform.enabled && !enabledDraft.value
  const disablesReview = platform.settings['review.enabled'] === true && formValues['review.enabled'] === false
  return disablesPlatform || disablesReview
})
const gitLabProfileValidationRequired = computed(() => isGitLabPlatform.value && !gitLabDeactivationSave.value)
const gitLabProfileSaveBlocked = computed(() => (
  gitLabProfileValidationRequired.value && Boolean(gitLabProjectProfileFormError.value)
))
const gitLabSaveError = computed(() => {
  if (!isGitLabPlatform.value) return ''
  const fieldError = Object.entries(jsonErrors).find(([key]) => (
    key !== gitLabProjectProfilesFieldKey || gitLabProfileValidationRequired.value
  ))?.[1]
  if (fieldError) return fieldError
  return gitLabProfileValidationRequired.value ? gitLabProjectProfileFormError.value : ''
})
const gitLabScopeMode = computed(() => textValue(gitLabScopeModeFieldKey) || 'all-received')
const gitLabRuntimeWebhookUrl = computed(() => {
  const actionWebhookUrl = props.actionResult?.data?.webhookUrl
  if (typeof actionWebhookUrl === 'string' && actionWebhookUrl.startsWith('http')) return actionWebhookUrl
  const cardValue = props.selectedPlatform?.runtimeStatus.cards?.find((card) => card.id === 'webhook-url')?.value
  return typeof cardValue === 'string' && cardValue.startsWith('http') ? cardValue : ''
})
const gitLabReviewWebhookUrl = computed(() => {
  if (gitLabRuntimeWebhookUrl.value) return gitLabRuntimeWebhookUrl.value
  const baseUrl = gitLabWebhookBaseUrl()
  const secret = textValue(gitLabWebhookSecretFieldKey).trim() || '{webhookSecret}'
  return `${baseUrl}/webhooks/gitlab/${encodeURIComponent(secret)}`
})
const gitLabCliGuideState = computed(() => gitLabCliGuide(
  props.selectedPlatform?.runtimeStatus.cards?.find((card) => card.id === 'cli'),
))

watch(
  () => props.selectedPlatform,
  (platform) => {
    resetForm(platform)
    if (platform?.id === 'gitlab') {
      loadGitLabReviewRuns()
      loadWebhookStatus()
    } else {
      gitLabReviewRuns.value = []
      gitLabRunsError.value = ''
      webhookStatus.value = null
      gitLabWebhookUrlMessage.value = ''
      gitLabProjectSearchQuery.value = ''
      gitLabProjectSearchResults.value = []
      gitLabProjectSearchError.value = ''
      gitLabGroupSearchQuery.value = ''
      gitLabGroupSearchResults.value = []
      gitLabGroupSearchError.value = ''
    }
  },
  { immediate: true },
)

function resetForm(platform: PlatformDetail | null) {
  enabledDraft.value = platform?.enabled ?? true
  for (const key of Object.keys(formValues)) delete formValues[key]
  for (const key of Object.keys(secretClears)) delete secretClears[key]
  for (const key of Object.keys(jsonErrors)) delete jsonErrors[key]
  for (const key of Object.keys(actionFormValues)) delete actionFormValues[key]
  for (const key of Object.keys(actionJsonErrors)) delete actionJsonErrors[key]
  if (!platform) return

  for (const field of configFields.value) {
    const value = platform.settings[field.key]
    secretClears[field.key] = false
    formValues[field.key] = fieldFormValue(field, value)
  }

  for (const action of platform.actions) {
    if (action.kind !== 'form' || !action.inputSchema) continue
    actionFormValues[action.id] = {}
    for (const field of actionFields(action)) {
      const value = platform.settings[field.key]
      actionFormValues[action.id][field.key] = fieldFormValue(field, value)
    }
  }
}

function selectPlatform(id: string) {
  emit('select', id)
}

function statusClass(status: string) {
  if (status === 'available') return 'platform-status-ok'
  if (status === 'disabled' || status === 'missing') return 'platform-status-muted'
  if (status === 'degraded' || status === 'auth-required') return 'platform-status-warning'
  return 'platform-status-error'
}

function statusText(status: string) {
  switch (status) {
    case 'available': return '可用'
    case 'disabled': return '已禁用'
    case 'missing': return '未安装'
    case 'auth-required': return '需要认证'
    case 'degraded': return '部分可用'
    case 'error': return '错误'
    default: return status
  }
}

function statusIcon(status: string) {
  if (status === 'available') return CheckCircle2
  if (status === 'disabled' || status === 'missing') return CircleSlash
  return CircleAlert
}

function toolVisibilityLabel(value: 'declared-only' | 'user-selectable') {
  return value === 'user-selectable' ? '用户可选' : '仅由平台声明'
}

function runtimeToolStatusLabel(status: string) {
  if (status === 'registered') return '已注册'
  if (status === 'disabled') return '已停用'
  if (status === 'error') return '注册失败'
  return statusText(status)
}

function runtimeToolStatusClass(status: string) {
  if (status === 'registered') return statusClass('available')
  if (status === 'disabled') return statusClass('disabled')
  return statusClass('error')
}

function eventLevelLabel(level: string) {
  const labels: Record<string, string> = {
    info: '信息',
    success: '成功',
    warning: '警告',
    warn: '警告',
    error: '错误',
    debug: '调试',
  }
  return labels[level] || level
}

function actionResultStatusLabel(status: string) {
  const labels: Record<string, string> = {
    ok: '成功',
    failed: '失败',
    pending: '处理中',
    'requires-user-action': '需要用户操作',
  }
  return labels[status] || status
}

function capabilityLabels(platform: PlatformDetail) {
  const caps = platform.capabilities
  const labels: string[] = []
  if (caps.pageContext) labels.push('页面上下文')
  if (caps.resources) labels.push('资源贡献')
  if (caps.browserExtension) labels.push('浏览器插件')
  if (caps.settingsPage) labels.push('配置页')
  if (caps.statusPage) labels.push('状态页')
  if (caps.auth && caps.auth !== 'none') labels.push(`认证: ${caps.auth}`)
  if (caps.templates?.length) labels.push(`模板: ${caps.templates.length}`)
  return labels
}

function defaultCards(platform: PlatformDetail) {
  return [
    { id: 'status', label: '状态', value: statusText(platform.runtimeStatus.status), tone: toneForStatus(platform.runtimeStatus.status) },
    { id: 'lifecycle', label: '生命周期', value: platform.lifecycleStatus, tone: 'neutral' as const },
    { id: 'registered', label: 'Runtime', value: platform.registered ? '已注册' : '未注册', tone: platform.registered ? 'success' as const : 'neutral' as const },
  ]
}

function toneForStatus(status: string) {
  if (status === 'available') return 'success' as const
  if (status === 'degraded' || status === 'auth-required') return 'warning' as const
  if (status === 'error') return 'danger' as const
  return 'neutral' as const
}

function isSecretField(field: PlatformConfigField) {
  return field.secret || field.type === 'password'
}

function isRedactedSecret(value: unknown): value is { redacted: true; hasValue: boolean; provider?: string } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as any).redacted === true)
}

function descriptorValue(field: PlatformConfigField, savedValue: unknown) {
  return savedValue === undefined ? field.defaultValue : savedValue
}

function fieldFormValue(field: PlatformConfigField, savedValue: unknown): string | number | boolean {
  if (isSecretField(field)) return ''
  const value = descriptorValue(field, savedValue)
  if (field.type === 'string-list') return Array.isArray(value) ? value.join('\n') : ''
  if (field.type === 'json') return value === undefined ? '' : JSON.stringify(value, null, 2) ?? ''
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : false
  if (field.type === 'number') return typeof value === 'number' ? value : ''
  return typeof value === 'string' ? value : ''
}

function secretStatus(field: PlatformConfigField) {
  const value = props.selectedPlatform?.settings[field.key]
  if (!isRedactedSecret(value)) return ''
  if (secretClears[field.key]) return '保存后清除'
  return value.hasValue ? `已保存${value.provider ? ` · ${value.provider}` : ''}` : '未设置'
}

function fieldPlaceholder(field: PlatformConfigField) {
  if (isSecretField(field)) return secretStatus(field) || field.placeholder || '输入新值'
  if (field.placeholder) return field.placeholder
  if (field.type === 'string-list') return '每行一个值'
  if (field.type === 'json') return '{}'
  return ''
}

function fieldInputType(field: PlatformConfigField) {
  if (field.type === 'password') return 'password'
  if (field.type === 'number') return 'number'
  return 'text'
}

function textValue(key: string) {
  const value = formValues[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function setTextValue(field: PlatformConfigField, event: Event) {
  formValues[field.key] = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
  if (isSecretField(field)) {
    secretClears[field.key] = false
  }
}

function isGitLabReviewModelProviderField(field: PlatformConfigField) {
  return isGitLabPlatform.value && field.key === gitLabReviewModelProviderFieldKey
}

function isGitLabReviewModelField(field: PlatformConfigField) {
  return isGitLabPlatform.value && field.key === gitLabReviewModelFieldKey
}

function isGitLabProjectScopeJsonField(field: PlatformConfigField) {
  return isGitLabPlatform.value && (
    field.key === gitLabIncludedProjectsFieldKey ||
    field.key === gitLabExcludedProjectsFieldKey ||
    field.key === gitLabHookGroupsFieldKey
  )
}

function isGitLabProjectProfilesJsonField(field: PlatformConfigField) {
  return isGitLabPlatform.value && field.key === gitLabProjectProfilesFieldKey
}

function shouldShowGitLabGenericField(field: PlatformConfigField) {
  if (!isGitLabPlatform.value) return true
  if (!gitLabAdvancedConfig.value) return false
  if (gitLabMvpFieldKeys.has(field.key)) return false
  return !isGitLabReviewModelProviderField(field) && !isGitLabProjectScopeJsonField(field) && !isGitLabProjectProfilesJsonField(field)
}

function gitLabMvpFieldClass(field: PlatformConfigField) {
  return {
    wide: field.key === 'review.baseUrl' ||
      field.key === 'review.webhookSecretRef' ||
      field.key === 'review.tokenSecretRef' ||
      field.key === 'review.modelId',
  }
}

function gitLabReviewModelValue() {
  const providerId = textValue(gitLabReviewModelProviderFieldKey)
  const modelId = textValue(gitLabReviewModelFieldKey)
  return providerId && modelId ? `${providerId}\t${modelId}` : ''
}

function setGitLabReviewModel(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (!value) {
    formValues[gitLabReviewModelProviderFieldKey] = ''
    formValues[gitLabReviewModelFieldKey] = ''
    return
  }
  const [providerId, ...modelParts] = value.split('\t')
  formValues[gitLabReviewModelProviderFieldKey] = providerId || ''
  formValues[gitLabReviewModelFieldKey] = modelParts.join('\t')
}

function gitLabWebhookBaseUrl() {
  const status = webhookStatus.value
  const base = status?.publicUrl || status?.localUrl || window.location.origin
  return base.replace(/\/$/, '')
}

async function copyGitLabWebhookUrl() {
  gitLabWebhookUrlMessage.value = ''
  try {
    if (!await copyText(gitLabReviewWebhookUrl.value)) throw new Error('copy failed')
    gitLabWebhookUrlMessage.value = 'Webhook URL 已复制。'
  } catch {
    gitLabWebhookUrlMessage.value = '复制失败，请手动选中 URL 复制。'
  }
}

function parseGitLabProjectRefs(input: string): GitLabProjectRef[] {
  if (!input.trim()) return []
  try {
    const parsed = JSON.parse(input)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item === 'string' || typeof item === 'number') return { id: item }
        if (!item || typeof item !== 'object') return undefined
        const id = (item as any).id
        if (typeof id !== 'string' && typeof id !== 'number') return undefined
        return {
          id,
          pathWithNamespace: typeof (item as any).pathWithNamespace === 'string'
            ? (item as any).pathWithNamespace
            : typeof (item as any).path_with_namespace === 'string'
              ? (item as any).path_with_namespace
              : undefined,
          webUrl: typeof (item as any).webUrl === 'string'
            ? (item as any).webUrl
            : typeof (item as any).web_url === 'string'
              ? (item as any).web_url
              : undefined,
        }
      })
      .filter((item): item is GitLabProjectRef => Boolean(item))
  } catch {
    return []
  }
}

function setGitLabProjectRefs(key: string, projects: GitLabProjectRef[]) {
  formValues[key] = JSON.stringify(projects, null, 2)
}

function setGitLabProjectProfileDocument(document: ReturnType<typeof parseGitLabProjectProfileDocument>) {
  formValues[gitLabProjectProfilesFieldKey] = renderGitLabProjectProfileDocument(document)
}

function addGitLabProjectProfile(project: GitLabProjectRef) {
  const document = gitLabProjectProfileDocument.value
  const profiles = document.editable.map((entry) => entry.profile)
  const profile = createGitLabProjectProfile(project, textValue('review.baseUrl'))
  const identity = gitLabProjectIdentityKey(profile.host, profile.projectId)
  if (profiles.some((candidate) => gitLabProjectIdentityKey(candidate.host, candidate.projectId) === identity)) return
  setGitLabProjectProfileDocument(appendGitLabProjectProfileDocument(document, profile))
}

function updateGitLabProjectProfile(profile: GitLabProjectProfile, patch: Partial<GitLabProjectProfile>) {
  const document = gitLabProjectProfileDocument.value
  const entry = document.editable.find((candidate) => candidate.profile === profile)
  if (!entry) return
  setGitLabProjectProfileDocument(updateGitLabProjectProfileDocument(document, entry.index, {
    ...profile,
    ...patch,
    ci: { ...profile.ci, ...patch.ci },
  }))
}

function removeGitLabProjectProfile(profile: GitLabProjectProfile) {
  const document = gitLabProjectProfileDocument.value
  const entry = document.editable.find((candidate) => candidate.profile === profile)
  if (!entry) return
  setGitLabProjectProfileDocument(removeGitLabProjectProfileDocument(document, entry.index))
}

function hasNine1BotProject(projectID: string) {
  return props.projects.some((project) => project.id === projectID)
}

function nine1botProjectLabel(project: Nine1BotProjectOption) {
  return project.name || project.rootDirectory || project.worktree || project.id
}

function gitLabProfileBindingError(profile: GitLabProjectProfile) {
  if (!profile.nine1botProjectID) return '请选择一个 Nine1Bot 项目。'
  if (!hasNine1BotProject(profile.nine1botProjectID)) return '绑定的 Nine1Bot 项目已不存在，请重新选择。'
  return ''
}

function profileLines(value: string[]) {
  return value.join('\n')
}

function parseProfileLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function parseGitLabGroupRefs(input: string): GitLabGroupRef[] {
  if (!input.trim()) return []
  try {
    const parsed = JSON.parse(input)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item === 'string' || typeof item === 'number') return { id: item }
        if (!item || typeof item !== 'object') return undefined
        const id = (item as any).id
        if (typeof id !== 'string' && typeof id !== 'number') return undefined
        return {
          id,
          fullPath: typeof (item as any).fullPath === 'string'
            ? (item as any).fullPath
            : typeof (item as any).full_path === 'string'
              ? (item as any).full_path
              : undefined,
          webUrl: typeof (item as any).webUrl === 'string'
            ? (item as any).webUrl
            : typeof (item as any).web_url === 'string'
              ? (item as any).web_url
              : undefined,
        }
      })
      .filter((item): item is GitLabGroupRef => Boolean(item))
  } catch {
    return []
  }
}

function setGitLabGroupRefs(key: string, groups: GitLabGroupRef[]) {
  formValues[key] = JSON.stringify(groups, null, 2)
}

function gitLabProjectLabel(project: GitLabProjectRef) {
  return project.pathWithNamespace || String(project.id)
}

function gitLabGroupLabel(group: GitLabGroupRef) {
  return group.fullPath || String(group.id)
}

function hasGitLabProject(projects: GitLabProjectRef[], project: GitLabProjectRef) {
  return projects.some((item) => String(item.id) === String(project.id))
}

function hasGitLabGroup(groups: GitLabGroupRef[], group: GitLabGroupRef) {
  return groups.some((item) => String(item.id) === String(group.id))
}

async function searchGitLabProjects() {
  const platform = props.selectedPlatform
  if (!platform || searchingGitLabProjects.value) return
  searchingGitLabProjects.value = true
  gitLabProjectSearchError.value = ''
  try {
    const result = await platformApi.action(platform.id, 'projects.search', {
      input: { query: gitLabProjectSearchQuery.value },
    })
    const projects = Array.isArray(result.data?.projects) ? result.data.projects : []
    gitLabProjectSearchResults.value = projects
      .map((item: any) => ({
        id: item.id,
        pathWithNamespace: item.pathWithNamespace,
        webUrl: item.webUrl,
      }))
      .filter((item: GitLabProjectRef) => typeof item.id === 'string' || typeof item.id === 'number')
  } catch (error: any) {
    gitLabProjectSearchError.value = error?.message || 'GitLab 项目搜索失败'
  } finally {
    searchingGitLabProjects.value = false
  }
}

async function searchGitLabGroups() {
  const platform = props.selectedPlatform
  if (!platform || searchingGitLabGroups.value) return
  searchingGitLabGroups.value = true
  gitLabGroupSearchError.value = ''
  try {
    const result = await platformApi.action(platform.id, 'groups.search', {
      input: { query: gitLabGroupSearchQuery.value },
    })
    const groups = Array.isArray(result.data?.groups) ? result.data.groups : []
    gitLabGroupSearchResults.value = groups
      .map((item: any) => ({
        id: item.id,
        fullPath: item.fullPath,
        webUrl: item.webUrl,
      }))
      .filter((item: GitLabGroupRef) => typeof item.id === 'string' || typeof item.id === 'number')
  } catch (error: any) {
    gitLabGroupSearchError.value = error?.message || 'GitLab 群组搜索失败'
  } finally {
    searchingGitLabGroups.value = false
  }
}

function addGitLabProject(key: string, project: GitLabProjectRef) {
  const current = parseGitLabProjectRefs(textValue(key))
  if (hasGitLabProject(current, project)) return
  setGitLabProjectRefs(key, [...current, project])
}

function addGitLabGroup(key: string, group: GitLabGroupRef) {
  const current = parseGitLabGroupRefs(textValue(key))
  if (hasGitLabGroup(current, group)) return
  setGitLabGroupRefs(key, [...current, group])
}

function removeGitLabGroup(key: string, group: GitLabGroupRef) {
  setGitLabGroupRefs(key, parseGitLabGroupRefs(textValue(key)).filter((item) => String(item.id) !== String(group.id)))
}

function removeGitLabProject(key: string, project: GitLabProjectRef) {
  setGitLabProjectRefs(key, parseGitLabProjectRefs(textValue(key)).filter((item) => String(item.id) !== String(project.id)))
}

function runGitLabAction(actionId: string) {
  const action = props.selectedPlatform?.actions.find((item) => item.id === actionId)
  if (action) runAction(action)
}

function clearSecretField(field: PlatformConfigField) {
  secretClears[field.key] = true
  formValues[field.key] = ''
}

function parseField(field: PlatformConfigField): { include: boolean; value?: unknown; error?: string } {
  const value = formValues[field.key]
  if (isSecretField(field)) {
    if (secretClears[field.key]) return { include: true, value: null }
    if (typeof value === 'string' && value.trim()) return { include: true, value: value.trim() }
    return { include: false }
  }

  if (field.type === 'string-list') {
    const values = typeof value === 'string'
      ? value.split('\n').map((item) => item.trim()).filter(Boolean)
      : []
    return { include: true, value: values }
  }

  if (field.type === 'json') {
    if (typeof value !== 'string' || !value.trim()) return { include: true, value: null }
    try {
      return { include: true, value: JSON.parse(value) }
    } catch {
      return { include: false, error: 'JSON 格式不正确' }
    }
  }

  if (field.type === 'select') {
    return { include: true, value: typeof value === 'string' && value.trim() ? value.trim() : null }
  }

  if (field.type === 'number') {
    if (value === '') return { include: true, value: null }
    const numberValue = Number(value)
    if (!Number.isFinite(numberValue)) return { include: false, error: '请输入有效数字' }
    return { include: true, value: numberValue }
  }

  if (field.type === 'boolean') return { include: true, value: Boolean(value) }
  if (typeof value === 'string') return { include: true, value: value.trim() }
  return { include: true, value }
}

function parsePlainField(
  field: PlatformConfigField,
  values: Record<string, string | number | boolean>,
): { include: boolean; value?: unknown; error?: string } {
  const value = values[field.key]
  if (field.type === 'string-list') {
    const values = typeof value === 'string'
      ? value.split('\n').map((item) => item.trim()).filter(Boolean)
      : []
    return { include: true, value: values }
  }

  if (field.type === 'json') {
    if (typeof value !== 'string' || !value.trim()) return { include: true, value: null }
    try {
      return { include: true, value: JSON.parse(value) }
    } catch {
      return { include: false, error: 'JSON 格式不正确' }
    }
  }

  if (field.type === 'select') {
    return { include: true, value: typeof value === 'string' && value.trim() ? value.trim() : null }
  }

  if (field.type === 'number') {
    if (value === '') return { include: true, value: null }
    const numberValue = Number(value)
    if (!Number.isFinite(numberValue)) return { include: false, error: '请输入有效数字' }
    return { include: true, value: numberValue }
  }

  if (field.type === 'boolean') return { include: true, value: Boolean(value) }
  if (typeof value === 'string') return { include: true, value: value.trim() }
  return { include: true, value }
}

function buildSettingsPatch() {
  const settings: Record<string, unknown> = {}
  for (const key of Object.keys(jsonErrors)) delete jsonErrors[key]

  for (const field of configFields.value) {
    if (isGitLabPlatform.value && gitLabDeactivationSave.value && field.key === gitLabProjectProfilesFieldKey) {
      continue
    }
    const parsed = parseField(field)
    if (parsed.error) {
      jsonErrors[field.key] = parsed.error
      continue
    }
    if (parsed.include) settings[field.key] = parsed.value
  }

  if (
    isGitLabPlatform.value
    && gitLabProfileValidationRequired.value
    && !jsonErrors[gitLabProjectProfilesFieldKey]
  ) {
    const serialized = serializeGitLabProjectProfileDocument(gitLabProjectProfileDocument.value)
    if (!serialized.ok) {
      jsonErrors[gitLabProjectProfilesFieldKey] = gitLabProjectProfileDiagnosticLabel(serialized.diagnostics[0])
    } else {
      settings[gitLabProjectProfilesFieldKey] = JSON.parse(serialized.value)
      const profileError = gitLabProjectProfilesValidationError()
      if (profileError) jsonErrors[gitLabProjectProfilesFieldKey] = profileError
    }
  }

  return Object.keys(jsonErrors).length > 0 ? undefined : settings
}

function gitLabProjectProfilesValidationError() {
  const diagnostic = gitLabProjectProfileDiagnostics.value[0]
  if (diagnostic) return gitLabProjectProfileDiagnosticLabel(diagnostic)
  const bindingError = validateGitLabProjectBindings(gitLabProjectProfiles.value, props.projects)
  if (bindingError) return bindingError
  if (Boolean(formValues['review.enabled']) && !gitLabProjectProfiles.value.some((profile) => profile.enabled)) {
    return '启用 GitLab Review 时，至少需要一个已启用并完成绑定的项目档案。'
  }
  return ''
}

function saveSettings() {
  const platform = props.selectedPlatform
  if (!platform) return
  const settings = buildSettingsPatch()
  if (!settings) return
  emit('update', platform.id, {
    enabled: enabledDraft.value,
    settings,
  })
}

function refreshStatus() {
  if (props.selectedPlatform) emit('refresh', props.selectedPlatform.id)
  if (isGitLabPlatform.value) {
    loadGitLabReviewRuns()
    loadWebhookStatus()
  }
}

async function loadWebhookStatus() {
  try {
    webhookStatus.value = await webhookApi.status()
  } catch {
    webhookStatus.value = null
  }
}

async function loadGitLabReviewRuns() {
  loadingGitLabRuns.value = true
  gitLabRunsError.value = ''
  try {
    gitLabReviewRuns.value = await gitLabReviewApi.runs({ limit: 50 })
  } catch (error: any) {
    gitLabRunsError.value = error?.message || '加载 GitLab review 运行记录失败'
  } finally {
    loadingGitLabRuns.value = false
  }
}

function canRetryGitLabRun(run: GitLabReviewRun) {
  return canRetryGitLabReviewRunPolicy(run, gitLabReviewRuns.value)
}

async function retryGitLabReviewRun(run: GitLabReviewRun) {
  if (!canRetryGitLabRun(run) || retryingGitLabRunIds.value.has(run.id)) return
  retryingGitLabRunIds.value = new Set([...retryingGitLabRunIds.value, run.id])
  gitLabRunsError.value = ''
  try {
    await gitLabReviewApi.retry(run.id)
    await loadGitLabReviewRuns()
  } catch (error: any) {
    gitLabRunsError.value = error?.message || '重试 GitLab review 失败'
  } finally {
    const next = new Set(retryingGitLabRunIds.value)
    next.delete(run.id)
    retryingGitLabRunIds.value = next
  }
}

function formatRunTime(timestamp?: number) {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString()
}

function reviewRunObject(run: GitLabReviewRun) {
  const trigger = run.trigger || {}
  if (trigger.objectType === 'mr') return `MR ${String(trigger.objectIid ?? '')}`.trim()
  if (trigger.objectType === 'commit') return `提交 ${String(trigger.commitSha ?? '').slice(0, 8)}`
  return run.id
}

function reviewRunDetail(run: GitLabReviewRun) {
  const parts = [
    `尝试 ${run.attempt}`,
    run.retryOf ? `重试自 ${run.retryOf}` : '',
    run.sessionId ? `会话 ${run.sessionId}` : '',
    run.turnSnapshotId ? `轮次 ${run.turnSnapshotId}` : '',
    run.retryCount ? `重试 ${run.retryCount} 次` : '',
    run.lastRetryAt ? `上次重试 ${formatRunTime(run.lastRetryAt)}` : '',
    run.failureNotifiedAt ? `失败通知 ${formatRunTime(run.failureNotifiedAt)}` : '',
    run.error ? `错误 ${run.error}` : '',
    run.warnings?.length ? `${run.warnings.length} 条警告` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : run.idempotencyKey || '暂无详情'
}

function gitLabIgnoredEventTitle(run: GitLabReviewRun) {
  const trigger = run.trigger || {}
  const project = trigger.projectPath || trigger.projectId || '未知项目'
  const event = trigger.eventName || '未知事件'
  const target = reviewRunObject(run)
  return `${String(project)} · ${String(event)} · ${target}`
}

function gitLabIgnoredEventDetail(run: GitLabReviewRun) {
  const trigger = run.trigger || {}
  const parts = [
    trigger.host ? `主机 ${String(trigger.host)}` : '',
    trigger.noteId ? `评论 ${String(trigger.noteId)}` : '',
    trigger.headSha ? `提交 ${String(trigger.headSha).slice(0, 8)}` : '',
    run.idempotencyKey ? `幂等键 ${run.idempotencyKey}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : run.id
}

function gitLabIgnoredReasonLabel(run: GitLabReviewRun) {
  const reason = run.error || String(run.trigger?.reason || 'ignored')
  const labels: Record<string, string> = {
    'ignored': '已忽略',
    'project-not-allowed': '项目不在 review 范围内',
    'webhook-auto-review-disabled': '自动审查已关闭',
    'manual-trigger-disabled': '手动 mention 已关闭',
    'mention-not-found': '未找到 bot mention',
    'mention-from-bot': '已忽略 bot 自己的评论',
    'mention-out-of-scope': 'mention 不是 review 请求',
    'mention-sensitive-request': '敏感请求已拒绝',
  }
  return labels[reason] || reason
}

function runAction(action: PlatformActionDescriptor) {
  const platform = props.selectedPlatform
  if (!platform) return
  const input = action.kind === 'form' ? buildActionInput(action) : undefined
  if (input === undefined && action.kind === 'form') return
  let confirmed = false
  if (action.danger) {
    confirmed = window.confirm(`确认执行「${action.label}」？`)
    if (!confirmed) return
  }
  emit('action', platform.id, action.id, input, action.danger ? confirmed : undefined)
}

function actionFields(action: PlatformActionDescriptor): PlatformConfigField[] {
  return action.inputSchema?.sections.flatMap((section) => section.fields) ?? []
}

function ensureActionValues(action: PlatformActionDescriptor) {
  if (!actionFormValues[action.id]) actionFormValues[action.id] = {}
  return actionFormValues[action.id]
}

function actionTextValue(action: PlatformActionDescriptor, key: string) {
  const value = ensureActionValues(action)[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function actionBooleanValue(action: PlatformActionDescriptor, key: string) {
  return Boolean(ensureActionValues(action)[key])
}

function setActionTextValue(action: PlatformActionDescriptor, field: PlatformConfigField, event: Event) {
  ensureActionValues(action)[field.key] = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
}

function setActionBooleanValue(action: PlatformActionDescriptor, field: PlatformConfigField, event: Event) {
  ensureActionValues(action)[field.key] = (event.target as HTMLInputElement).checked
}

function actionFieldError(action: PlatformActionDescriptor, key: string) {
  return actionJsonErrors[action.id]?.[key]
}

function actionFieldId(action: PlatformActionDescriptor, field: PlatformConfigField) {
  return `platform-action-${action.id.replace(/[^\w-]/g, '-')}-${field.key.replace(/[^\w-]/g, '-')}`
}

function buildActionInput(action: PlatformActionDescriptor) {
  const values = ensureActionValues(action)
  const errors: Record<string, string> = {}
  const input: Record<string, unknown> = {}
  for (const field of actionFields(action)) {
    const parsed = parsePlainField(field, values)
    if (parsed.error) {
      errors[field.key] = parsed.error
      continue
    }
    if (parsed.include) input[field.key] = parsed.value
  }

  if (Object.keys(errors).length > 0) {
    actionJsonErrors[action.id] = errors
    return undefined
  }
  delete actionJsonErrors[action.id]
  return input
}

function actionResultDetails(result: PlatformActionResult) {
  return result.data ? JSON.stringify(result.data, null, 2) : ''
}
</script>

<template>
  <div class="platform-manager">
    <div class="section-header">
      <h3 class="section-title">多平台适配</h3>
      <p class="section-desc text-muted text-sm">管理内置平台的上下文、资源与适配能力。</p>
    </div>

    <div v-if="loading && platforms.length === 0" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载平台适配...</span>
    </div>

    <div v-else class="platform-layout">
      <aside class="platform-list">
        <button
          v-for="platform in platforms"
          :key="platform.id"
          class="platform-list-item"
          :class="{ active: platform.id === selectedPlatformId }"
          @click="selectPlatform(platform.id)"
        >
          <component :is="statusIcon(platform.status)" :size="16" :class="statusClass(platform.status)" />
          <span class="platform-list-main">
            <span class="platform-list-title">{{ platform.name }}</span>
            <span class="platform-list-meta">{{ statusText(platform.status) }} · {{ platform.enabled ? '启用' : '停用' }}</span>
          </span>
        </button>

        <div v-if="platforms.length === 0" class="platform-empty text-muted text-sm">
          暂无平台适配
        </div>
      </aside>

      <section class="platform-detail">
        <div v-if="error" class="platform-alert error">
          {{ error }}
        </div>

        <div v-if="selectedPlatform" class="platform-detail-content">
          <div class="platform-title-row">
            <div>
              <h4 class="platform-title">{{ selectedPlatform.name }}</h4>
              <p class="platform-package text-muted text-sm">
                {{ selectedPlatform.packageName }}{{ selectedPlatform.version ? ` · ${selectedPlatform.version}` : '' }}
              </p>
            </div>
            <button class="btn btn-ghost btn-sm" :disabled="operationLocked" @click="refreshStatus">
              <RefreshCw :size="14" />
              <span>{{ healthRefreshing ? '刷新中' : '刷新状态' }}</span>
            </button>
          </div>

          <div class="platform-enable-row">
            <label class="platform-switch">
              <input v-model="enabledDraft" type="checkbox" />
              <span>{{ enabledDraft ? '已启用' : '已停用' }}</span>
            </label>
            <span class="platform-status-pill" :class="statusClass(selectedPlatform.status)">
              {{ statusText(selectedPlatform.status) }}
            </span>
          </div>

          <div v-if="isGitLabPlatform" class="platform-section gitlab-review-guide">
            <div class="platform-section-heading-row">
              <h5 class="platform-section-title">Webhook 触发入口</h5>
              <code class="gitlab-webhook-path">{{ gitLabWebhookPath }}</code>
            </div>
            <p class="gitlab-guide-intro text-muted text-sm">
              这个 URL 是 GitLab 平台 review 的专用入口，可以同时填到多个 Project、Group 或 System Hook。Nine1Bot 会根据 GitLab payload 里的 project id 和允许项目列表判断是否处理。
            </p>
            <div class="gitlab-mvp-callout">
              <strong>最小运行路径</strong>
              <span>填 GitLab base URL 和 API token，复制下方 webhook URL 到 GitLab Project/Group Hook，只勾选 Comments / Note events，然后在 MR 评论 `@Nine1bot review`。</span>
            </div>
            <div class="gitlab-mvp-callout" :class="`tone-${gitLabCliGuideState.tone}`">
              <strong>{{ gitLabCliGuideState.title }}</strong>
              <span>{{ gitLabCliGuideState.text }}</span>
              <span>CLI 交互使用受控 wrapper tools，不要求开启 webhook Review，也不会向模型暴露 token 或任意 CLI 命令。</span>
            </div>
            <div class="gitlab-webhook-url-box">
              <span class="gitlab-guide-label">专用 Webhook URL</span>
              <code class="gitlab-webhook-url">{{ gitLabReviewWebhookUrl }}</code>
              <div class="gitlab-webhook-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="copyGitLabWebhookUrl">
                  <Copy :size="13" />
                  <span>复制 URL</span>
                </button>
              </div>
              <div class="gitlab-webhook-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="operationLocked"
                  @click="runGitLabAction('webhook.sync-current-url')"
                >
                  <RefreshCw :size="13" />
                  <span>{{ actionRunning === 'webhook.sync-current-url' ? '同步中' : '同步到 GitLab' }}</span>
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="operationLocked"
                  @click="runGitLabAction('webhook.test')"
                >
                  <Play :size="13" />
                  <span>{{ actionRunning === 'webhook.test' ? '测试中' : '测试 Hook' }}</span>
                </button>
              </div>
              <span v-if="gitLabWebhookUrlMessage" class="gitlab-guide-text">{{ gitLabWebhookUrlMessage }}</span>
            </div>
            <form class="gitlab-mvp-form" @submit.prevent="saveSettings">
              <div class="platform-section-heading-row">
                <h5 class="platform-section-title">MVP 配置</h5>
                <span class="gitlab-guide-text">默认只启用 @Nine1bot 手动审查，自动 MR 审查放在高级配置里。</span>
              </div>
              <div class="gitlab-mvp-field-grid">
                <label
                  v-for="field in gitLabMvpFields"
                  :key="field.key"
                  class="platform-field gitlab-mvp-field"
                  :class="gitLabMvpFieldClass(field)"
                >
                  <span class="platform-field-label">{{ field.label }}</span>
                  <span v-if="field.description" class="platform-field-desc text-muted text-sm">{{ field.description }}</span>

                  <select
                    v-if="isGitLabReviewModelField(field)"
                    :value="gitLabReviewModelValue()"
                    class="input platform-input"
                    @change="setGitLabReviewModel"
                  >
                    <option value="">使用默认对话模型</option>
                    <optgroup
                      v-for="provider in providers.filter((item) => item.authenticated)"
                      :key="provider.id"
                      :label="provider.name"
                    >
                      <option
                        v-for="model in provider.models"
                        :key="`${provider.id}:${model.id}`"
                        :value="`${provider.id}\t${model.id}`"
                      >
                        {{ model.name || model.id }}
                      </option>
                    </optgroup>
                  </select>

                  <label v-else-if="field.type === 'boolean'" class="platform-switch inline">
                    <input v-model="formValues[field.key]" type="checkbox" />
                    <span>{{ formValues[field.key] ? '开启' : '关闭' }}</span>
                  </label>

                  <div v-else-if="isSecretField(field)" class="platform-secret-input">
                    <input
                      :type="fieldInputType(field)"
                      :value="textValue(field.key)"
                      class="input platform-input"
                      :placeholder="secretStatus(field)"
                      @input="setTextValue(field, $event)"
                    />
                    <button
                      v-if="isRedactedSecret(selectedPlatform.settings[field.key]) && !secretClears[field.key]"
                      type="button"
                      class="btn btn-ghost btn-sm"
                      @click="clearSecretField(field)"
                    >
                      <Trash2 :size="13" />
                      <span>清除</span>
                    </button>
                  </div>

                  <input
                    v-else
                    :type="fieldInputType(field)"
                    :value="textValue(field.key)"
                    class="input platform-input"
                    placeholder=""
                    @input="setTextValue(field, $event)"
                  />

                  <span v-if="isSecretField(field) && secretStatus(field)" class="platform-field-desc text-muted text-sm">
                    {{ secretStatus(field) }}
                  </span>
                  <span v-if="jsonErrors[field.key]" class="platform-field-error">{{ jsonErrors[field.key] }}</span>
                </label>
              </div>
              <div class="gitlab-webhook-actions">
                <button class="btn btn-primary btn-sm" type="submit" :disabled="operationLocked || gitLabProfileSaveBlocked">
                  <Save :size="13" />
                  <span>{{ saving ? '保存中' : '保存 MVP 配置' }}</span>
                </button>
                <span v-if="gitLabSaveError" class="platform-field-error gitlab-save-error" role="alert">
                  {{ gitLabSaveError }}
                </span>
                <button type="button" class="btn btn-ghost btn-sm" :disabled="operationLocked" @click="runGitLabAction('connection.test')">
                  <Play :size="13" />
                  <span>{{ actionRunning === 'connection.test' ? '测试中' : '测试 API token' }}</span>
                </button>
                <button type="button" class="btn btn-ghost btn-sm" :disabled="operationLocked" @click="runGitLabAction('webhook.test')">
                  <Play :size="13" />
                  <span>{{ actionRunning === 'webhook.test' ? '测试中' : '测试 Project Hook' }}</span>
                </button>
                <label class="platform-switch inline gitlab-advanced-toggle">
                  <input v-model="gitLabAdvancedConfig" type="checkbox" />
                  <span>高级配置</span>
                </label>
              </div>
            </form>
            <div v-if="gitLabAdvancedConfig" class="gitlab-hook-mode-grid">
              <div class="gitlab-hook-mode-card">
                <span class="gitlab-guide-label">项目 Hook</span>
                <span class="gitlab-guide-text">适合少量项目测试。每个项目单独配置，边界最清楚。</span>
              </div>
              <div class="gitlab-hook-mode-card recommended">
                <span class="gitlab-guide-label">群组 Hook</span>
                <span class="gitlab-guide-text">推荐团队使用。一个 group 配一次，组内项目共用同一个 URL。</span>
              </div>
              <div class="gitlab-hook-mode-card">
                <span class="gitlab-guide-label">系统 Hook</span>
                <span class="gitlab-guide-text">适合自托管管理员统一接入。事件范围最大，必须配合允许项目列表。</span>
              </div>
            </div>
            <div v-if="gitLabAdvancedConfig" class="gitlab-guide-grid">
              <div class="gitlab-guide-item">
                <span class="gitlab-guide-label">需要勾选的事件</span>
                <span class="gitlab-guide-text">勾选 Comments / Note events 用于 @Nine1bot review。需要自动审查时，再勾选 Merge request events。</span>
              </div>
              <div class="gitlab-guide-item">
                <span class="gitlab-guide-label">密钥 Token</span>
                <span class="gitlab-guide-text">使用上面的 path secret URL 时，GitLab 的密钥 Token 字段留空。若改用 /webhooks/gitlab，则密钥 Token 填同一个 webhook secret。</span>
              </div>
              <div class="gitlab-guide-item">
                <span class="gitlab-guide-label">项目范围</span>
                <span class="gitlab-guide-text">同一个 URL 可以给多个项目共用；用允许项目列表限制真正会触发 review 的 project id。</span>
              </div>
              <div class="gitlab-guide-item">
                <span class="gitlab-guide-label">Review 模型</span>
                <span class="gitlab-guide-text">模型来自已认证的 Chat providers。当前可选模型数：{{ authenticatedModelCount }}。</span>
              </div>
            </div>
            <div v-if="gitLabAdvancedConfig" class="gitlab-scope-picker">
              <div class="platform-section-heading-row">
                <h5 class="platform-section-title">Review 范围</h5>
                <span class="gitlab-guide-text">{{ gitLabScopeMode === 'selected-only' ? '仅处理选中的项目' : '处理 Hook 收到的项目，排除黑名单' }}</span>
              </div>
              <div class="gitlab-project-search-row">
                <input
                  v-model="gitLabProjectSearchQuery"
                  class="input platform-input"
                  placeholder="搜索 GitLab 项目，例如 root/uftest"
                  @keydown.enter.prevent="searchGitLabProjects"
                />
                <button type="button" class="btn btn-secondary btn-sm" :disabled="searchingGitLabProjects" @click="searchGitLabProjects">
                  <RefreshCw :size="13" />
                  <span>{{ searchingGitLabProjects ? '搜索中' : '搜索项目' }}</span>
                </button>
              </div>
              <div v-if="gitLabProjectSearchError" class="platform-alert warning">{{ gitLabProjectSearchError }}</div>
              <div v-if="gitLabProjectSearchResults.length" class="gitlab-project-result-list">
                <div v-for="project in gitLabProjectSearchResults" :key="String(project.id)" class="gitlab-project-row">
                  <div>
                    <strong>{{ gitLabProjectLabel(project) }}</strong>
                    <span class="text-muted text-sm">ID {{ project.id }}</span>
                  </div>
                  <div class="gitlab-project-actions">
                    <button type="button" class="btn btn-ghost btn-sm" @click="addGitLabProjectProfile(project)">
                      添加档案
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm" @click="addGitLabProject(gitLabIncludedProjectsFieldKey, project)">
                      加入包含
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm" @click="addGitLabProject(gitLabExcludedProjectsFieldKey, project)">
                      加入排除
                    </button>
                  </div>
                </div>
              </div>
              <div class="gitlab-selected-project-grid">
                <div class="gitlab-selected-project-box">
                  <span class="gitlab-guide-label">包含项目</span>
                  <p class="gitlab-guide-text">selected-only 模式下只处理这里的项目；all-received 模式下也用于 Project Hook 同步。</p>
                  <div v-if="gitLabIncludedProjects.length" class="gitlab-project-chip-list">
                    <button
                      v-for="project in gitLabIncludedProjects"
                      :key="String(project.id)"
                      type="button"
                      class="gitlab-project-chip"
                      @click="removeGitLabProject(gitLabIncludedProjectsFieldKey, project)"
                    >
                      {{ gitLabProjectLabel(project) }} ×
                    </button>
                  </div>
                  <span v-else class="text-muted text-sm">尚未选择项目</span>
                </div>
                <div class="gitlab-selected-project-box">
                  <span class="gitlab-guide-label">排除项目</span>
                  <p class="gitlab-guide-text">这些项目不会触发手动 mention 或自动 review。</p>
                  <div v-if="gitLabExcludedProjects.length" class="gitlab-project-chip-list">
                    <button
                      v-for="project in gitLabExcludedProjects"
                      :key="String(project.id)"
                      type="button"
                      class="gitlab-project-chip"
                      @click="removeGitLabProject(gitLabExcludedProjectsFieldKey, project)"
                    >
                      {{ gitLabProjectLabel(project) }} ×
                    </button>
                  </div>
                  <span v-else class="text-muted text-sm">没有排除项目</span>
                </div>
              </div>
            </div>
            <div v-if="gitLabAdvancedConfig" class="gitlab-scope-picker">
              <div class="platform-section-heading-row">
                <h5 class="platform-section-title">项目审查档案</h5>
                <span class="gitlab-guide-text">每个可审查仓库都必须建档并绑定已有的 Nine1Bot 项目；档案只补充 review 策略。</span>
              </div>
              <div v-if="props.projects.length === 0" class="platform-alert warning">
                当前没有可绑定的 Nine1Bot 项目，请先在项目页添加仓库。
              </div>
              <div v-if="jsonErrors[gitLabProjectProfilesFieldKey]" class="platform-alert error">
                {{ jsonErrors[gitLabProjectProfilesFieldKey] }}
              </div>
              <div v-if="gitLabProjectProfileFormError && !gitLabProjectProfileDiagnostics.length" class="platform-alert error">
                {{ gitLabProjectProfileFormError }}
              </div>
              <div v-if="gitLabProjectProfileDiagnostics.length" class="platform-alert error">
                <div
                  v-for="diagnostic in gitLabProjectProfileDiagnostics"
                  :key="gitLabProjectProfileDiagnosticKey(diagnostic)"
                >
                  {{ gitLabProjectProfileDiagnosticLabel(diagnostic) }}
                </div>
              </div>
              <label v-if="gitLabProjectProfileDiagnostics.length" class="platform-field">
                <span class="platform-field-label">项目档案原始 JSON</span>
                <textarea
                  :value="textValue(gitLabProjectProfilesFieldKey)"
                  class="input platform-input platform-textarea"
                  rows="10"
                  @input="formValues[gitLabProjectProfilesFieldKey] = ($event.target as HTMLTextAreaElement).value"
                />
              </label>
              <div v-if="gitLabProjectProfiles.length" class="gitlab-profile-list">
                <article v-for="(profile, profileIndex) in gitLabProjectProfiles" :key="`${profile.id}:${profileIndex}`" class="gitlab-profile-card">
                  <div class="gitlab-profile-heading">
                    <div>
                      <strong>{{ profile.displayName || profile.pathWithNamespace || profile.id }}</strong>
                      <span class="text-muted text-sm">项目 ID {{ profile.projectId }}</span>
                    </div>
                    <div class="gitlab-project-actions">
                      <label class="platform-switch inline">
                        <input
                          :checked="profile.enabled"
                          type="checkbox"
                          @change="updateGitLabProjectProfile(profile, { enabled: ($event.target as HTMLInputElement).checked })"
                        />
                        <span>启用</span>
                      </label>
                      <button type="button" class="btn btn-ghost btn-sm" @click="removeGitLabProjectProfile(profile)">
                        <Trash2 :size="13" />
                        <span>移除</span>
                      </button>
                    </div>
                  </div>
                  <div class="gitlab-profile-grid">
                    <label class="platform-field">
                      <span class="platform-field-label">显示名称</span>
                      <input
                        :value="profile.displayName || ''"
                        class="input platform-input"
                        @input="updateGitLabProjectProfile(profile, { displayName: ($event.target as HTMLInputElement).value || undefined })"
                      />
                    </label>
                    <label class="platform-field">
                      <span class="platform-field-label">Nine1Bot 项目</span>
                      <span class="platform-field-desc text-muted text-sm">Review runtime 使用该项目的工作目录和通用项目说明。</span>
                      <select
                        :value="profile.nine1botProjectID"
                        class="input platform-input"
                        required
                        @change="updateGitLabProjectProfile(profile, { nine1botProjectID: ($event.target as HTMLSelectElement).value })"
                      >
                        <option value="">请选择项目</option>
                        <option
                          v-if="profile.nine1botProjectID && !hasNine1BotProject(profile.nine1botProjectID)"
                          :value="profile.nine1botProjectID"
                        >
                          已失效 · {{ profile.nine1botProjectID }}
                        </option>
                        <option v-for="project in props.projects" :key="project.id" :value="project.id">
                          {{ nine1botProjectLabel(project) }}
                        </option>
                      </select>
                      <span v-if="gitLabProfileBindingError(profile)" class="platform-field-error">
                        {{ gitLabProfileBindingError(profile) }}
                      </span>
                    </label>
                    <label class="platform-field wide">
                      <span class="platform-field-label">审查关注点</span>
                      <textarea
                        :value="profileLines(profile.reviewFocus)"
                        class="input platform-input platform-textarea"
                        rows="3"
                        placeholder="每行一个关注点，例如：鉴权边界"
                        @input="updateGitLabProjectProfile(profile, { reviewFocus: parseProfileLines(($event.target as HTMLTextAreaElement).value) })"
                      />
                    </label>
                  </div>
                  <label class="platform-field">
                    <span class="platform-field-label">Review 补充上下文</span>
                    <span class="platform-field-desc text-muted text-sm">只补充该仓库的审查约束；通用项目说明在 Nine1Bot 项目页维护。</span>
                    <textarea
                      :value="profile.reviewContextMarkdown || ''"
                      class="input platform-input platform-textarea"
                      rows="5"
                      :maxlength="GITLAB_REVIEW_PROJECT_CONTEXT_MAX_LENGTH"
                      placeholder="例如：UF 的模块边界、关键约束、不可回归的兼容性要求"
                      @input="updateGitLabProjectProfile(profile, { reviewContextMarkdown: ($event.target as HTMLTextAreaElement).value || undefined })"
                    />
                  </label>
                  <div class="gitlab-profile-grid">
                    <label class="platform-field">
                      <span class="platform-field-label">优先审查路径</span>
                      <span class="platform-field-desc text-muted text-sm">每行一个目录前缀；留空时按普通优先级处理全部文件。</span>
                      <textarea
                        :value="profileLines(profile.includePathPrefixes)"
                        class="input platform-input platform-textarea"
                        rows="3"
                        placeholder="src/security/"
                        @input="updateGitLabProjectProfile(profile, { includePathPrefixes: parseProfileLines(($event.target as HTMLTextAreaElement).value) })"
                      />
                    </label>
                    <label class="platform-field">
                      <span class="platform-field-label">排除路径</span>
                      <span class="platform-field-desc text-muted text-sm">每行一个 glob；匹配文件不会进入审查证据。</span>
                      <textarea
                        :value="profileLines(profile.excludePathPatterns)"
                        class="input platform-input platform-textarea"
                        rows="3"
                        placeholder="**/*.generated.ts"
                        @input="updateGitLabProjectProfile(profile, { excludePathPatterns: parseProfileLines(($event.target as HTMLTextAreaElement).value) })"
                      />
                    </label>
                  </div>
                  <div class="gitlab-profile-limit-grid">
                    <label class="platform-field">
                      <span class="platform-field-label">上下文预算（字节）</span>
                      <input
                        :value="profile.maxContextBytes ?? ''"
                        type="number"
                        min="1"
                        step="1"
                        class="input platform-input"
                        placeholder="使用全局值"
                        @input="updateGitLabProjectProfile(profile, { maxContextBytes: optionalProfileNumber(Number(($event.target as HTMLInputElement).value)) })"
                      />
                    </label>
                    <label class="platform-field">
                      <span class="platform-field-label">文件上限</span>
                      <input
                        :value="profile.maxFiles ?? ''"
                        type="number"
                        min="1"
                        step="1"
                        class="input platform-input"
                        placeholder="使用全局值"
                        @input="updateGitLabProjectProfile(profile, { maxFiles: optionalProfileNumber(Number(($event.target as HTMLInputElement).value)) })"
                      />
                    </label>
                  </div>
                  <div class="gitlab-profile-ci">
                    <div class="gitlab-profile-limit-grid">
                      <label class="platform-field">
                        <span class="platform-field-label">单次审查最多读取日志数</span>
                        <input
                          :value="profile.ci.maxJobLogs"
                          type="number"
                          min="1"
                          step="1"
                          class="input platform-input"
                          @input="updateGitLabProjectProfile(profile, { ci: { ...profile.ci, maxJobLogs: positiveProfileNumber(Number(($event.target as HTMLInputElement).value), 3) } })"
                        />
                      </label>
                      <label class="platform-field">
                        <span class="platform-field-label">单个任务日志最大字节数</span>
                        <input
                          :value="profile.ci.maxJobLogBytes"
                          type="number"
                          min="1"
                          step="1"
                          class="input platform-input"
                          @input="updateGitLabProjectProfile(profile, { ci: { ...profile.ci, maxJobLogBytes: positiveProfileNumber(Number(($event.target as HTMLInputElement).value), 8000) } })"
                        />
                      </label>
                    </div>
                  </div>
                </article>
              </div>
              <p v-else class="text-muted text-sm">先从上面的 GitLab 项目搜索结果添加档案，再绑定 Nine1Bot 项目。项目范围控制是否接收，项目档案控制在哪里、如何审查。</p>
            </div>
            <div v-if="gitLabAdvancedConfig" class="gitlab-scope-picker">
              <div class="platform-section-heading-row">
                <h5 class="platform-section-title">Group Hook 管理</h5>
                <span class="gitlab-guide-text">Group Hook 决定能收到哪些项目事件；Review 范围继续决定实际处理哪些项目。</span>
              </div>
              <div class="gitlab-project-search-row">
                <input
                  v-model="gitLabGroupSearchQuery"
                  class="input platform-input"
                  placeholder="搜索 GitLab Group，例如 root 或 backend"
                  @keydown.enter.prevent="searchGitLabGroups"
                />
                <button type="button" class="btn btn-secondary btn-sm" :disabled="searchingGitLabGroups" @click="searchGitLabGroups">
                  <RefreshCw :size="13" />
                  <span>{{ searchingGitLabGroups ? '搜索中' : '搜索 Group' }}</span>
                </button>
              </div>
              <div class="gitlab-webhook-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="operationLocked"
                  @click="runGitLabAction('group-hooks.sync-current-url')"
                >
                  <RefreshCw :size="13" />
                  <span>{{ actionRunning === 'group-hooks.sync-current-url' ? '同步中' : '同步 Group Hooks' }}</span>
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="operationLocked"
                  @click="runGitLabAction('group-hooks.test')"
                >
                  <Play :size="13" />
                  <span>{{ actionRunning === 'group-hooks.test' ? '测试中' : '测试 Group Hooks' }}</span>
                </button>
              </div>
              <div v-if="gitLabGroupSearchError" class="platform-alert warning">{{ gitLabGroupSearchError }}</div>
              <div v-if="gitLabGroupSearchResults.length" class="gitlab-project-result-list">
                <div v-for="group in gitLabGroupSearchResults" :key="String(group.id)" class="gitlab-project-row">
                  <div>
                    <strong>{{ gitLabGroupLabel(group) }}</strong>
                    <span class="text-muted text-sm">ID {{ group.id }}</span>
                  </div>
                  <button type="button" class="btn btn-ghost btn-sm" @click="addGitLabGroup(gitLabHookGroupsFieldKey, group)">
                    加入 Hook 群组
                  </button>
                </div>
              </div>
              <div class="gitlab-selected-project-box">
                <span class="gitlab-guide-label">Hook 群组</span>
                <p class="gitlab-guide-text">Nine1Bot 会为这些 group 创建或更新 group hook；System Hook 仍需在 GitLab 管理后台手动配置。</p>
                <div v-if="gitLabHookGroups.length" class="gitlab-project-chip-list">
                  <button
                    v-for="group in gitLabHookGroups"
                    :key="String(group.id)"
                    type="button"
                    class="gitlab-project-chip"
                    @click="removeGitLabGroup(gitLabHookGroupsFieldKey, group)"
                  >
                    {{ gitLabGroupLabel(group) }} ×
                  </button>
                </div>
                <span v-else class="text-muted text-sm">尚未选择 Group</span>
              </div>
            </div>
          </div>

          <div class="platform-section">
            <h5 class="platform-section-title">状态</h5>
            <div class="platform-status-grid">
              <div
                v-for="card in selectedPlatform.runtimeStatus.cards || defaultCards(selectedPlatform)"
                :key="card.id"
                class="platform-status-card"
                :class="`tone-${card.tone || 'neutral'}`"
              >
                <span class="platform-status-label">{{ card.label }}</span>
                <span class="platform-status-value">{{ card.value }}</span>
              </div>
            </div>
            <p v-if="selectedPlatform.runtimeStatus.message" class="platform-message text-sm">
              {{ selectedPlatform.runtimeStatus.message }}
            </p>
          </div>

          <div
            v-if="selectedPlatform.desiredConfigRevision !== selectedPlatform.appliedConfigRevision"
            class="platform-alert warning"
          >
            最新配置修订 {{ selectedPlatform.desiredConfigRevision }} 尚未成功应用；当前仍使用修订
            {{ selectedPlatform.appliedConfigRevision ?? '未应用' }} 的运行时快照。
          </div>

          <div class="platform-section">
            <div class="platform-section-heading-row">
              <h5 class="platform-section-title">平台注册工具</h5>
              <span class="text-muted text-sm">
                应用修订 {{ selectedPlatform.appliedConfigRevision ?? '未应用' }}
              </span>
            </div>
            <div v-if="selectedPlatform.runtimeTools?.length" class="platform-tool-list">
              <div v-for="tool in selectedPlatform.runtimeTools" :key="tool.id" class="platform-tool-row">
                <div class="platform-tool-main">
                  <strong>{{ tool.id }}</strong>
                  <span class="text-muted text-sm">{{ tool.description }}</span>
                </div>
                <div class="platform-tool-meta">
                  <span class="platform-chip">{{ toolVisibilityLabel(tool.catalogVisibility) }}</span>
                  <span class="platform-chip">generation {{ tool.generation }}</span>
                  <span class="platform-status-pill" :class="runtimeToolStatusClass(tool.status)">
                    {{ runtimeToolStatusLabel(tool.status) }}
                  </span>
                </div>
              </div>
            </div>
            <p v-else class="text-muted text-sm">该平台当前没有注册工具。</p>
          </div>

          <div v-if="isGitLabPlatform" class="platform-section">
            <div class="platform-section-heading-row">
              <h5 class="platform-section-title">GitLab Review 运行记录</h5>
              <button class="btn btn-ghost btn-sm" :disabled="loadingGitLabRuns" @click="loadGitLabReviewRuns">
                <RefreshCw :size="13" />
                <span>{{ loadingGitLabRuns ? '加载中' : '刷新' }}</span>
              </button>
            </div>
            <p class="text-muted text-sm">
              最近 8 条 review run。修复项目绑定或 token 配置后，可重试最新的可恢复配置拒绝。
            </p>
            <div v-if="gitLabRunsError" class="platform-alert warning">
              {{ gitLabRunsError }}
            </div>
            <div v-else-if="visibleGitLabRuns.length" class="gitlab-run-list">
              <div v-for="run in visibleGitLabRuns" :key="run.id" class="gitlab-run-row">
                <div class="gitlab-run-main">
                  <span class="gitlab-run-title">{{ reviewRunObject(run) }}</span>
                  <span v-if="run.project" class="gitlab-run-meta">{{ run.project.displayName || run.project.pathWithNamespace || run.project.id }}</span>
                  <span class="gitlab-run-meta">{{ run.id }} · {{ formatRunTime(run.updatedAt) }}</span>
                  <span class="gitlab-run-meta">{{ reviewRunDetail(run) }}</span>
                </div>
                <details
                  v-if="run.error || run.warnings?.length || run.idempotencyKey || run.ci?.pipeline || run.ci?.diagnostics?.length"
                  class="gitlab-run-details"
                >
                  <summary>详情</summary>
                  <div class="gitlab-run-detail-body">
                    <div v-if="run.error" class="gitlab-run-detail-line">
                      <span>错误</span>
                      <code>{{ run.error }}</code>
                    </div>
                    <div v-if="run.idempotencyKey" class="gitlab-run-detail-line">
                      <span>幂等键</span>
                      <code>{{ run.idempotencyKey }}</code>
                    </div>
                    <div v-if="run.warnings?.length" class="gitlab-run-detail-line">
                      <span>警告</span>
                      <ul>
                        <li v-for="warning in run.warnings" :key="warning">{{ warning }}</li>
                      </ul>
                    </div>
                    <div v-if="run.ci?.pipeline" class="gitlab-run-detail-line">
                      <span>CI pipeline</span>
                      <a v-if="run.ci.pipeline.web_url" :href="run.ci.pipeline.web_url" target="_blank" rel="noreferrer">
                        #{{ run.ci.pipeline.id }} · {{ run.ci.pipeline.status || 'unknown' }}
                      </a>
                      <code v-else>#{{ run.ci.pipeline.id }} · {{ run.ci.pipeline.status || 'unknown' }}</code>
                    </div>
                    <div v-if="run.ci?.diagnostics?.length" class="gitlab-run-detail-line">
                      <span>CI diagnostics</span>
                      <ul>
                        <li v-for="diagnostic in run.ci.diagnostics" :key="diagnostic">{{ diagnostic }}</li>
                      </ul>
                    </div>
                  </div>
                </details>
                <div class="gitlab-run-side">
                  <button
                    v-if="canRetryGitLabRun(run)"
                    class="btn btn-ghost btn-sm"
                    :disabled="retryingGitLabRunIds.has(run.id)"
                    @click="retryGitLabReviewRun(run)"
                  >
                    <RefreshCw :size="13" />
                    <span>{{ retryingGitLabRunIds.has(run.id) ? '重试中' : '重试' }}</span>
                  </button>
                  <span class="platform-status-pill" :class="statusClass(run.status === 'succeeded' ? 'available' : run.status === 'failed' ? 'error' : 'degraded')">
                    {{ reviewRunStatusLabel(run) }}
                  </span>
                  <span v-if="run.publishedAt" class="gitlab-run-published">已发布</span>
                </div>
              </div>
            </div>
            <p v-else class="text-muted text-sm">
              暂无 GitLab review 运行记录。
            </p>
          </div>

          <div v-if="!isGitLabPlatform || gitLabAdvancedConfig" class="platform-section">
            <h5 class="platform-section-title">能力</h5>
            <div class="platform-chip-row">
              <span v-for="label in capabilityLabels(selectedPlatform)" :key="label" class="platform-chip">
                {{ label }}
              </span>
            </div>
          </div>

          <div v-if="isGitLabPlatform && gitLabAdvancedConfig" class="platform-section">
            <div class="platform-section-heading-row">
              <h5 class="platform-section-title">已忽略的 GitLab 事件</h5>
              <button class="btn btn-ghost btn-sm" :disabled="loadingGitLabRuns" @click="loadGitLabReviewRuns">
                <RefreshCw :size="13" />
                <span>{{ loadingGitLabRuns ? '加载中' : '刷新' }}</span>
              </button>
            </div>
            <p class="text-muted text-sm">
              最近被 Nine1Bot 收到但没有触发 review 的 webhook。这里主要用来排查 Project/Group/System Hook 范围、黑名单、mention 和自动审查开关。
            </p>
            <div v-if="visibleGitLabIgnoredEvents.length" class="gitlab-run-list">
              <div v-for="run in visibleGitLabIgnoredEvents" :key="run.id" class="gitlab-run-row ignored">
                <div class="gitlab-run-main">
                  <span class="gitlab-run-title">{{ gitLabIgnoredEventTitle(run) }}</span>
                  <span class="gitlab-run-meta">{{ formatRunTime(run.updatedAt) }}</span>
                  <span class="gitlab-run-meta">{{ gitLabIgnoredEventDetail(run) }}</span>
                </div>
                <div class="gitlab-run-side">
                  <span class="platform-status-pill tone-warning">{{ gitLabIgnoredReasonLabel(run) }}</span>
                </div>
              </div>
            </div>
            <p v-else class="text-muted text-sm">
              暂无被忽略的 GitLab 事件。
            </p>
          </div>

          <form v-if="configFormSections.length && (!isGitLabPlatform || gitLabAdvancedConfig)" class="platform-section" @submit.prevent="saveSettings">
            <h5 class="platform-section-title">{{ isGitLabPlatform ? 'GitLab Review 配置' : '配置' }}</h5>
            <div v-for="section in configFormSections" :key="section.id" class="platform-form-section">
              <div class="platform-form-section-header">
                <span class="platform-form-section-title">{{ section.title }}</span>
                <span v-if="section.description" class="text-muted text-sm">{{ section.description }}</span>
              </div>

              <label
                v-for="field in section.fields"
                v-show="shouldShowGitLabGenericField(field)"
                :key="field.key"
                class="platform-field"
              >
                <span class="platform-field-label">{{ field.label }}</span>
                <span v-if="field.description" class="platform-field-desc text-muted text-sm">{{ field.description }}</span>

                <select
                  v-if="isGitLabReviewModelField(field)"
                  :value="gitLabReviewModelValue()"
                  class="input platform-input"
                  @change="setGitLabReviewModel"
                >
                  <option value="">使用默认对话模型</option>
                  <optgroup
                    v-for="provider in providers.filter((item) => item.authenticated)"
                    :key="provider.id"
                    :label="provider.name"
                  >
                    <option
                      v-for="model in provider.models"
                      :key="`${provider.id}:${model.id}`"
                      :value="`${provider.id}\t${model.id}`"
                    >
                      {{ model.name || model.id }}
                    </option>
                  </optgroup>
                </select>
                <span v-else-if="isGitLabReviewModelField(field)" class="platform-field-desc text-muted text-sm">
                  模型来自与对话共用的已配置服务商。
                </span>

                <select
                  v-else-if="field.type === 'select'"
                  :value="textValue(field.key)"
                  class="input platform-input"
                  @change="setTextValue(field, $event)"
                >
                  <option v-for="option in field.options || []" :key="option" :value="option">{{ option }}</option>
                </select>

                <label v-else-if="field.type === 'boolean'" class="platform-switch inline">
                  <input v-model="formValues[field.key]" type="checkbox" />
                  <span>{{ formValues[field.key] ? '开启' : '关闭' }}</span>
                </label>

                <textarea
                  v-else-if="field.type === 'string-list' || field.type === 'json'"
                  :value="textValue(field.key)"
                  class="input platform-textarea"
                  :placeholder="fieldPlaceholder(field)"
                  @input="setTextValue(field, $event)"
                ></textarea>

                <input
                  v-else
                  :value="textValue(field.key)"
                  class="input platform-input"
                  :type="fieldInputType(field)"
                  :placeholder="fieldPlaceholder(field)"
                  @input="setTextValue(field, $event)"
                />

                <div v-if="isSecretField(field)" class="platform-secret-row">
                  <span class="text-muted text-sm">{{ secretStatus(field) }}</span>
                  <button type="button" class="btn btn-ghost btn-sm" @click="clearSecretField(field)">
                    <Trash2 :size="13" />
                    <span>清除</span>
                  </button>
                </div>
                <span v-if="jsonErrors[field.key]" class="platform-field-error">{{ jsonErrors[field.key] }}</span>
              </label>
            </div>

            <div class="platform-actions-row">
              <button class="btn btn-primary btn-sm" type="submit" :disabled="operationLocked || gitLabProfileSaveBlocked">
                <Save :size="14" />
                <span>{{ saving ? '保存中' : '保存配置' }}</span>
              </button>
              <span v-if="gitLabSaveError" class="platform-field-error gitlab-save-error" role="alert">
                {{ gitLabSaveError }}
              </span>
            </div>
          </form>

          <div v-if="selectedPlatform.actions.length" class="platform-section">
            <h5 class="platform-section-title">操作</h5>
            <div class="platform-action-list">
              <form
                v-for="action in selectedPlatform.actions"
                v-show="!(isGitLabPlatform && (action.id === 'projects.search' || action.id === 'groups.search'))"
                :key="action.id"
                class="platform-action-item"
                @submit.prevent="runAction(action)"
              >
                <div class="platform-action-header">
                  <div>
                    <div class="platform-action-title">{{ action.label }}</div>
                    <div class="platform-action-desc text-muted text-sm">{{ action.description || action.id }}</div>
                  </div>
                  <button
                    class="btn btn-secondary btn-sm"
                    :class="{ danger: action.danger }"
                    :disabled="operationLocked"
                    type="submit"
                  >
                    <Play :size="13" />
                    <span>{{ actionRunning === action.id ? '执行中' : '执行' }}</span>
                  </button>
                </div>

                <div v-if="action.kind === 'form' && action.inputSchema" class="platform-action-form">
                  <div v-for="section in action.inputSchema.sections" :key="section.id" class="platform-form-section compact">
                    <div v-if="section.title || section.description" class="platform-form-section-header">
                      <span v-if="section.title" class="platform-form-section-title">{{ section.title }}</span>
                      <span v-if="section.description" class="text-muted text-sm">{{ section.description }}</span>
                    </div>

                    <div v-for="field in section.fields" :key="field.key" class="platform-field">
                      <label class="platform-field-label" :for="actionFieldId(action, field)">{{ field.label }}</label>
                      <span v-if="field.description" class="platform-field-desc text-muted text-sm">{{ field.description }}</span>

                      <select
                        v-if="field.type === 'select'"
                        :id="actionFieldId(action, field)"
                        :value="actionTextValue(action, field.key)"
                        class="input platform-input"
                        @change="setActionTextValue(action, field, $event)"
                      >
                        <option v-for="option in field.options || []" :key="option" :value="option">{{ option }}</option>
                      </select>

                      <label v-else-if="field.type === 'boolean'" class="platform-switch inline">
                        <input
                          :id="actionFieldId(action, field)"
                          :checked="actionBooleanValue(action, field.key)"
                          type="checkbox"
                          @change="setActionBooleanValue(action, field, $event)"
                        />
                        <span>{{ actionBooleanValue(action, field.key) ? '开启' : '关闭' }}</span>
                      </label>

                      <textarea
                        v-else-if="field.type === 'string-list' || field.type === 'json'"
                        :id="actionFieldId(action, field)"
                        :value="actionTextValue(action, field.key)"
                        class="input platform-textarea"
                        :placeholder="fieldPlaceholder(field)"
                        @input="setActionTextValue(action, field, $event)"
                      ></textarea>

                      <input
                        v-else
                        :id="actionFieldId(action, field)"
                        :value="actionTextValue(action, field.key)"
                        class="input platform-input"
                        :type="fieldInputType(field)"
                        :placeholder="fieldPlaceholder(field)"
                        @input="setActionTextValue(action, field, $event)"
                      />

                      <span v-if="actionFieldError(action, field.key)" class="platform-field-error">
                        {{ actionFieldError(action, field.key) }}
                      </span>
                    </div>
                  </div>
                </div>
              </form>
            </div>
            <div v-if="actionResult" class="platform-alert" :class="actionResult.status === 'ok' ? 'success' : 'warning'">
              {{ actionResult.message || actionResultStatusLabel(actionResult.status) }}
              <pre v-if="actionResultDetails(actionResult)" class="platform-action-result-data">{{ actionResultDetails(actionResult) }}</pre>
            </div>
          </div>

          <div class="platform-section">
            <h5 class="platform-section-title">最近事件</h5>
            <div v-if="selectedPlatform.runtimeStatus.recentEvents?.length" class="platform-event-list">
              <div v-for="event in selectedPlatform.runtimeStatus.recentEvents" :key="event.id" class="platform-event">
                <span class="platform-event-level">{{ eventLevelLabel(event.level) }}</span>
                <span class="platform-event-message">{{ event.message }}</span>
                <span class="platform-event-time text-muted">{{ event.at }}</span>
              </div>
            </div>
            <p v-else class="text-muted text-sm">暂无事件</p>
          </div>
        </div>

        <div v-else class="platform-empty-detail text-muted">
          选择一个平台查看详情
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.platform-manager {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  padding: var(--space-lg);
  overflow: auto;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.section-desc {
  margin: 0;
}

.platform-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: var(--space-lg);
  min-height: 440px;
}

.platform-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  border-right: 1px solid var(--border-subtle);
  padding-right: var(--space-md);
}

.platform-list-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  width: 100%;
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.platform-list-item:hover,
.platform-list-item.active {
  background: var(--bg-tertiary);
  border-color: var(--border-default);
}

.platform-list-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.platform-list-title {
  font-size: var(--text-base);
  font-weight: 600;
}

.platform-list-meta {
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.platform-detail {
  min-width: 0;
}

.platform-detail-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.platform-title-row,
.platform-enable-row,
.platform-actions-row,
.platform-secret-row,
.platform-action-item,
.platform-event {
  display: flex;
  align-items: center;
}

.platform-title-row,
.platform-action-item {
  justify-content: space-between;
  gap: var(--space-md);
}

.platform-title {
  font-size: var(--text-lg);
  line-height: 1.2;
  margin: 0 0 2px;
}

.platform-package {
  margin: 0;
}

.platform-enable-row {
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.platform-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.platform-section-title {
  font-size: var(--text-base);
  font-weight: 600;
  margin: 0;
}

.platform-section-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

.platform-status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
}

.gitlab-review-guide {
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}

.gitlab-webhook-path {
  padding: 2px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.gitlab-guide-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
}

.gitlab-guide-intro {
  margin: 0;
}

.gitlab-webhook-url-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.gitlab-webhook-url {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.gitlab-webhook-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.gitlab-scope-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.gitlab-mvp-callout {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-subtle));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-primary));
  color: var(--text-secondary);
  font-size: var(--text-13);
}

.gitlab-mvp-callout strong {
  color: var(--text-primary);
  font-size: var(--text-base);
}

.gitlab-mvp-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.gitlab-mvp-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
}

.gitlab-mvp-field.wide {
  grid-column: 1 / -1;
}

.gitlab-advanced-toggle {
  margin-left: auto;
}

.gitlab-project-search-row,
.gitlab-project-row,
.gitlab-project-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.gitlab-project-search-row .platform-input {
  flex: 1;
}

.gitlab-project-result-list,
.gitlab-project-chip-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.gitlab-profile-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.gitlab-profile-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-md);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-primary);
}

.gitlab-profile-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.gitlab-profile-heading > div:first-child {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.gitlab-profile-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.gitlab-profile-grid .wide {
  grid-column: 1 / -1;
}

.gitlab-profile-ci {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-sm);
  padding-top: var(--space-xs);
}

.gitlab-profile-limit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.gitlab-project-row {
  justify-content: space-between;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}

.gitlab-selected-project-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.gitlab-selected-project-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.gitlab-project-chip {
  text-align: left;
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
}

.gitlab-hook-mode-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
}

.gitlab-hook-mode-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 76px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.gitlab-hook-mode-card.recommended {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
  background: color-mix(in srgb, var(--accent) 7%, var(--bg-primary));
}

.gitlab-guide-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gitlab-guide-label {
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: 600;
}

.gitlab-guide-text {
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: 1.4;
}

.platform-status-card {
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.platform-tool-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.platform-tool-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.platform-tool-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.platform-tool-main strong,
.platform-tool-main span {
  overflow-wrap: anywhere;
}

.platform-tool-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-xs);
  flex-wrap: wrap;
}

.platform-status-label,
.platform-status-value {
  display: block;
}

.platform-status-label {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.platform-status-value {
  color: var(--text-primary);
  font-size: var(--text-base);
  font-weight: 600;
  margin-top: 2px;
}

.platform-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.platform-chip,
.platform-status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.gitlab-run-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.gitlab-run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.gitlab-run-row.ignored {
  background: color-mix(in srgb, var(--warning) 8%, var(--bg-primary));
  border-color: color-mix(in srgb, var(--warning) 30%, var(--border-subtle));
}

.gitlab-run-row:has(.gitlab-run-details[open]) {
  align-items: flex-start;
  flex-wrap: wrap;
}

.gitlab-run-main,
.gitlab-run-side {
  display: flex;
  min-width: 0;
}

.gitlab-run-main {
  flex-direction: column;
}

.gitlab-run-side {
  align-items: center;
  gap: var(--space-xs);
  flex-shrink: 0;
}

.gitlab-run-title {
  font-size: var(--text-13);
  font-weight: 600;
}

.gitlab-run-meta,
.gitlab-run-published {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.gitlab-run-details {
  flex-basis: 100%;
  order: 3;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.gitlab-run-details summary {
  cursor: pointer;
}

.gitlab-run-detail-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.gitlab-run-detail-line {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: var(--space-sm);
}

.gitlab-run-detail-line code,
.gitlab-run-detail-line ul {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.gitlab-run-detail-line ul {
  padding-left: 16px;
}

.platform-form-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.platform-form-section-header,
.platform-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.platform-form-section-title,
.platform-field-label,
.platform-action-title {
  font-weight: 600;
}

.platform-field-desc {
  margin-bottom: 2px;
}

.platform-input,
.platform-textarea {
  width: 100%;
}

.platform-textarea {
  min-height: 84px;
  resize: vertical;
}

.platform-secret-row {
  justify-content: space-between;
  gap: var(--space-sm);
}

.platform-action-list,
.platform-event-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.platform-action-item {
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  align-items: stretch;
  flex-direction: column;
}

.platform-action-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

.platform-action-form {
  margin-top: var(--space-sm);
}

.platform-action-result-data {
  margin-top: var(--space-xs);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: var(--text-sm);
}

.platform-form-section.compact {
  padding: 10px;
}

.platform-event {
  gap: var(--space-sm);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  font-size: var(--text-sm);
}

.platform-event-level {
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.platform-event-message {
  flex: 1;
  min-width: 0;
}

.platform-alert {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--warning-subtle);
  color: var(--warning);
  font-size: var(--text-13);
}

.platform-alert.error {
  background: var(--error-subtle);
  color: var(--error);
}

.platform-alert.success {
  background: var(--success-subtle);
  color: var(--success);
}

.platform-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  color: var(--text-secondary);
  font-size: var(--text-13);
}

.platform-switch.inline {
  justify-content: flex-start;
}

.platform-field-error {
  color: var(--error);
  font-size: var(--text-sm);
}

.platform-status-ok,
.tone-success {
  color: var(--success);
}

.platform-status-warning,
.tone-warning {
  color: var(--warning);
}

.platform-status-error,
.tone-danger {
  color: var(--error);
}

.platform-status-muted,
.tone-neutral {
  color: var(--text-muted);
}

.btn.danger {
  color: var(--error);
}

.platform-empty,
.platform-empty-detail {
  padding: var(--space-md);
}

@media (max-width: 760px) {
  .platform-layout {
    grid-template-columns: 1fr;
  }

  .platform-list {
    border-right: none;
    border-bottom: 1px solid var(--border-subtle);
    padding-right: 0;
    padding-bottom: var(--space-md);
  }

  .platform-status-grid {
    grid-template-columns: 1fr;
  }

  .platform-tool-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .platform-tool-meta {
    justify-content: flex-start;
  }

  .gitlab-guide-grid,
  .gitlab-hook-mode-grid,
  .gitlab-profile-grid,
  .gitlab-profile-limit-grid,
  .gitlab-selected-project-grid {
    grid-template-columns: 1fr;
  }

  .gitlab-profile-heading {
    align-items: flex-start;
  }
}
</style>
