<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { CheckCircle2, CircleAlert, CircleSlash, Play, RefreshCw, Save, Trash2 } from 'lucide-vue-next'
import type {
  PlatformActionDescriptor,
  PlatformConfigField,
  PlatformDetail,
  PlatformSummary,
  PlatformActionResult,
} from '../api/client'

const props = defineProps<{
  platforms: PlatformSummary[]
  selectedPlatform: PlatformDetail | null
  selectedPlatformId: string
  loading: boolean
  saving: boolean
  actionRunning: string
  error: string
  actionResult: PlatformActionResult | null
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
const actionFormValues = reactive<Record<string, Record<string, string | number | boolean>>>({})
const actionJsonErrors = reactive<Record<string, Record<string, string>>>({})

const configFields = computed(() => {
  return props.selectedPlatform?.config?.sections.flatMap((section) => section.fields) ?? []
})
const operationLocked = computed(() => props.saving || Boolean(props.actionRunning))
const healthRefreshing = computed(() => props.actionRunning === 'health')

watch(
  () => props.selectedPlatform,
  (platform) => {
    resetForm(platform)
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
    if (isSecretField(field) && isRedactedSecret(value)) {
      formValues[field.key] = ''
    } else if (field.type === 'string-list') {
      formValues[field.key] = Array.isArray(value) ? value.join('\n') : ''
    } else if (field.type === 'json') {
      formValues[field.key] = value === undefined ? '' : JSON.stringify(value, null, 2)
    } else if (field.type === 'boolean') {
      formValues[field.key] = typeof value === 'boolean' ? value : false
    } else if (field.type === 'number') {
      formValues[field.key] = typeof value === 'number' ? value : ''
    } else {
      formValues[field.key] = typeof value === 'string' ? value : ''
    }
  }

  for (const action of platform.actions) {
    if (action.kind !== 'form' || !action.inputSchema) continue
    actionFormValues[action.id] = {}
    for (const field of actionFields(action)) {
      const value = platform.settings[field.key]
      if (field.type === 'string-list') {
        actionFormValues[action.id][field.key] = Array.isArray(value) ? value.join('\n') : ''
      } else if (field.type === 'json') {
        actionFormValues[action.id][field.key] = value === undefined ? '' : JSON.stringify(value, null, 2)
      } else if (field.type === 'boolean') {
        actionFormValues[action.id][field.key] = typeof value === 'boolean' ? value : false
      } else if (field.type === 'number') {
        actionFormValues[action.id][field.key] = typeof value === 'number' ? value : ''
      } else {
        actionFormValues[action.id][field.key] = typeof value === 'string' ? value : ''
      }
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

function secretStatus(field: PlatformConfigField) {
  const value = props.selectedPlatform?.settings[field.key]
  if (!isRedactedSecret(value)) return ''
  if (secretClears[field.key]) return '保存后清除'
  return value.hasValue ? `已保存${value.provider ? ` · ${value.provider}` : ''}` : '未设置'
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
    const parsed = parseField(field)
    if (parsed.error) {
      jsonErrors[field.key] = parsed.error
      continue
    }
    if (parsed.include) settings[field.key] = parsed.value
  }

  return Object.keys(jsonErrors).length > 0 ? undefined : settings
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

          <div class="platform-section">
            <h5 class="platform-section-title">能力</h5>
            <div class="platform-chip-row">
              <span v-for="label in capabilityLabels(selectedPlatform)" :key="label" class="platform-chip">
                {{ label }}
              </span>
            </div>
          </div>

          <form v-if="selectedPlatform.config?.sections.length" class="platform-section" @submit.prevent="saveSettings">
            <h5 class="platform-section-title">配置</h5>
            <div v-for="section in selectedPlatform.config.sections" :key="section.id" class="platform-form-section">
              <div class="platform-form-section-header">
                <span class="platform-form-section-title">{{ section.title }}</span>
                <span v-if="section.description" class="text-muted text-sm">{{ section.description }}</span>
              </div>

              <label v-for="field in section.fields" :key="field.key" class="platform-field">
                <span class="platform-field-label">{{ field.label }}</span>
                <span v-if="field.description" class="platform-field-desc text-muted text-sm">{{ field.description }}</span>

                <select
                  v-if="field.type === 'select'"
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
                  :placeholder="field.type === 'string-list' ? '每行一个值' : '{}'"
                  @input="setTextValue(field, $event)"
                ></textarea>

                <input
                  v-else
                  :value="textValue(field.key)"
                  class="input platform-input"
                  :type="fieldInputType(field)"
                  :placeholder="isSecretField(field) ? secretStatus(field) || '输入新值' : ''"
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
              <button class="btn btn-primary btn-sm" type="submit" :disabled="operationLocked">
                <Save :size="14" />
                <span>{{ saving ? '保存中' : '保存配置' }}</span>
              </button>
            </div>
          </form>

          <div v-if="selectedPlatform.actions.length" class="platform-section">
            <h5 class="platform-section-title">操作</h5>
            <div class="platform-action-list">
              <form
                v-for="action in selectedPlatform.actions"
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
                        :placeholder="field.type === 'string-list' ? '每行一个值' : '{}'"
                        @input="setActionTextValue(action, field, $event)"
                      ></textarea>

                      <input
                        v-else
                        :id="actionFieldId(action, field)"
                        :value="actionTextValue(action, field.key)"
                        class="input platform-input"
                        :type="fieldInputType(field)"
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
              {{ actionResult.message || actionResult.status }}
            </div>
          </div>

          <div class="platform-section">
            <h5 class="platform-section-title">最近事件</h5>
            <div v-if="selectedPlatform.runtimeStatus.recentEvents?.length" class="platform-event-list">
              <div v-for="event in selectedPlatform.runtimeStatus.recentEvents" :key="event.id" class="platform-event">
                <span class="platform-event-level">{{ event.level }}</span>
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
  border-right: 0.5px solid var(--border-subtle);
  padding-right: var(--space-md);
}

.platform-list-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  width: 100%;
  min-height: 48px;
  padding: 8px 10px;
  border: 0.5px solid transparent;
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
  font-size: 14px;
  font-weight: 600;
}

.platform-list-meta {
  font-size: 12px;
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
  font-size: 18px;
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
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.platform-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.platform-section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.platform-status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
}

.platform-status-card {
  padding: 10px 12px;
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.platform-status-label,
.platform-status-value {
  display: block;
}

.platform-status-label {
  color: var(--text-muted);
  font-size: 12px;
}

.platform-status-value {
  color: var(--text-primary);
  font-size: 14px;
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
  font-size: 12px;
}

.platform-form-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: 12px;
  border: 0.5px solid var(--border-subtle);
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
  border: 0.5px solid var(--border-subtle);
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

.platform-form-section.compact {
  padding: 10px;
}

.platform-event {
  gap: var(--space-sm);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  font-size: 12px;
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
  font-size: 13px;
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
  font-size: 13px;
}

.platform-switch.inline {
  justify-content: flex-start;
}

.platform-field-error {
  color: var(--error);
  font-size: 12px;
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
    border-bottom: 0.5px solid var(--border-subtle);
    padding-right: 0;
    padding-bottom: var(--space-md);
  }

  .platform-status-grid {
    grid-template-columns: 1fr;
  }
}
</style>
