<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AuthImportResult } from '../api/client'
import { useSettings } from '../composables/useSettings'

defineProps<{
  loading: boolean
  importing: boolean
  importResult: AuthImportResult | null
}>()

const emit = defineEmits<{
  oauth: [providerId: string]
  'set-api-key': [providerId: string, apiKey: string]
  remove: [providerId: string]
  'import-opencode': []
}>()

const { filteredProviders, providerSearchQuery, customProviders, upsertCustomProvider, removeCustomProvider } = useSettings()

const apiKeyInputs = ref<Record<string, string>>({})
const showApiKeyInput = ref<Record<string, boolean>>({})
const customProviderForm = ref({
  id: '',
  name: '',
  protocol: 'openai' as 'openai' | 'anthropic',
  baseURL: '',
  models: [{ id: '', name: '' }],
})
const editingCustomId = ref<string>('')
const customProviderError = ref('')
const savingCustomProvider = ref(false)
const showCustomProviderForm = ref(false)

const customProviderEntries = computed(() => {
  return Object.entries(customProviders.value).sort((a, b) => a[0].localeCompare(b[0]))
})

function toggleApiKeyInput(providerId: string) {
  showApiKeyInput.value[providerId] = !showApiKeyInput.value[providerId]
}

function submitApiKey(providerId: string) {
  const apiKey = apiKeyInputs.value[providerId]
  if (apiKey) {
    emit('set-api-key', providerId, apiKey)
    apiKeyInputs.value[providerId] = ''
    showApiKeyInput.value[providerId] = false
  }
}

function clearSearch() {
  providerSearchQuery.value = ''
}

function resetCustomProviderForm() {
  editingCustomId.value = ''
  customProviderError.value = ''
  customProviderForm.value = {
    id: '',
    name: '',
    protocol: 'openai',
    baseURL: '',
    models: [{ id: '', name: '' }],
  }
  showCustomProviderForm.value = false
}

function toggleCustomProviderForm() {
  showCustomProviderForm.value = !showCustomProviderForm.value
  customProviderError.value = ''
  if (!showCustomProviderForm.value && !editingCustomId.value) {
    customProviderForm.value = {
      id: '',
      name: '',
      protocol: 'openai',
      baseURL: '',
      models: [{ id: '', name: '' }],
    }
  }
}

function beginEditCustomProvider(providerId: string) {
  const provider = customProviders.value[providerId]
  if (!provider) return
  editingCustomId.value = providerId
  customProviderError.value = ''
  customProviderForm.value = {
    id: providerId,
    name: provider.name,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
    models: provider.models.length > 0
      ? provider.models.map(model => ({ id: model.id, name: model.name || '' }))
      : [{ id: '', name: '' }],
  }
  showCustomProviderForm.value = true
}

function addModelRow() {
  customProviderForm.value.models.push({ id: '', name: '' })
}

function removeModelRow(index: number) {
  if (customProviderForm.value.models.length === 1) {
    customProviderForm.value.models[0] = { id: '', name: '' }
    return
  }
  customProviderForm.value.models.splice(index, 1)
}

async function submitCustomProvider() {
  customProviderError.value = ''
  const providerId = customProviderForm.value.id.trim()
  const name = customProviderForm.value.name.trim()
  const baseURL = customProviderForm.value.baseURL.trim()
  const models = customProviderForm.value.models
    .map(model => ({ id: model.id.trim(), name: model.name.trim() }))
    .filter(model => model.id)
    .map(model => ({ id: model.id, ...(model.name ? { name: model.name } : {}) }))

  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(providerId)) {
    customProviderError.value = 'ID 格式不正确，仅支持小写字母、数字、-、_，长度 2-64。'
    return
  }
  if (!name) {
    customProviderError.value = '请输入来源名称。'
    return
  }
  try {
    const url = new URL(baseURL)
    if (!['http:', 'https:'].includes(url.protocol)) {
      customProviderError.value = 'baseURL 必须是 http 或 https。'
      return
    }
  } catch {
    customProviderError.value = 'baseURL 格式不正确。'
    return
  }
  if (models.length === 0) {
    customProviderError.value = '至少需要一个模型，格式：modelId 或 modelId,显示名。'
    return
  }

  savingCustomProvider.value = true
  try {
    await upsertCustomProvider(providerId, {
      name,
      protocol: customProviderForm.value.protocol,
      baseURL,
      models,
    })
    resetCustomProviderForm()
  } catch (e: any) {
    customProviderError.value = e?.message || '保存失败'
  } finally {
    savingCustomProvider.value = false
  }
}

async function handleDeleteCustomProvider(providerId: string) {
  try {
    await removeCustomProvider(providerId)
    if (editingCustomId.value === providerId) {
      resetCustomProviderForm()
    }
  } catch (e: any) {
    customProviderError.value = e?.message || '删除失败'
  }
}
</script>

<template>
  <div class="auth-manager">
    <div class="section-header">
      <h3 class="section-title">认证管理</h3>
      <p class="section-desc text-muted text-sm">管理 AI 提供者的认证信息</p>
      <div class="auth-hint">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <span>API Key 安全存储在本地，不会上传到任何服务器</span>
      </div>
    </div>

    <div class="import-auth-panel">
      <div class="import-auth-copy">
        <div class="import-auth-title">Import from OpenCode</div>
        <div class="import-auth-desc">Imports OpenCode auth once. Nine1Bot only uses local auth after import.</div>
      </div>
      <button class="btn btn-secondary" :disabled="importing" @click="emit('import-opencode')">
        {{ importing ? 'Importing...' : 'Import Auth' }}
      </button>
    </div>

    <div v-if="importResult" class="import-auth-result">
      <p v-if="!importResult.sourceFound" class="text-muted text-sm">No OpenCode auth file was found.</p>
      <template v-else>
        <p class="text-sm">
          Imported {{ importResult.imported.length }} item<span v-if="importResult.imported.length !== 1">s</span>
          from {{ importResult.totalSource }} source record<span v-if="importResult.totalSource !== 1">s</span>.
        </p>
        <p v-if="importResult.skippedExisting.length > 0" class="text-muted text-sm">
          Skipped existing: {{ importResult.skippedExisting.join(', ') }}
        </p>
        <p v-if="importResult.skippedInvalid.length > 0" class="text-muted text-sm">
          Skipped invalid: {{ importResult.skippedInvalid.join(', ') }}
        </p>
      </template>
    </div>

    <div class="custom-provider-card">
      <div class="custom-provider-header">
        <h4>自定义来源</h4>
        <div class="custom-provider-header-actions">
          <span class="text-muted text-sm">支持 OpenAI-compatible 与 Anthropic-compatible</span>
          <button class="btn btn-secondary" @click="toggleCustomProviderForm">
            {{ showCustomProviderForm ? '收起表单' : '新增来源' }}
          </button>
        </div>
      </div>

      <div class="custom-provider-list" v-if="customProviderEntries.length > 0">
        <div class="custom-provider-item" v-for="[providerId, customProvider] in customProviderEntries" :key="providerId">
          <div class="custom-provider-item-main">
            <div class="custom-provider-title">{{ customProvider.name }} <span class="text-muted">({{ providerId }})</span></div>
            <div class="custom-provider-meta text-muted text-sm">{{ customProvider.protocol }} · {{ customProvider.baseURL }}</div>
            <div class="custom-provider-models text-muted text-sm">模型：{{ customProvider.models.map(m => m.id).join(', ') }}</div>
          </div>
          <div class="custom-provider-actions">
            <button class="btn btn-secondary" @click="beginEditCustomProvider(providerId)">编辑</button>
            <button class="btn btn-ghost" @click="handleDeleteCustomProvider(providerId)">删除</button>
          </div>
        </div>
      </div>

      <div class="custom-provider-form" v-if="showCustomProviderForm">
        <div class="input-group">
          <label class="label">来源 ID</label>
          <input class="input" v-model="customProviderForm.id" :disabled="!!editingCustomId" placeholder="例如: my-openai" />
        </div>
        <div class="input-group">
          <label class="label">显示名称</label>
          <input class="input" v-model="customProviderForm.name" placeholder="例如: My OpenAI" />
        </div>
        <div class="input-group">
          <label class="label">协议</label>
          <select class="input" v-model="customProviderForm.protocol">
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>
        <div class="input-group">
          <label class="label">Base URL</label>
          <input class="input" v-model="customProviderForm.baseURL" placeholder="https://example.com/v1" />
        </div>
        <div class="input-group">
          <label class="label">模型列表</label>
          <div class="models-editor">
            <div class="model-row" v-for="(model, index) in customProviderForm.models" :key="index">
              <input class="input" v-model="model.id" placeholder="模型 ID（必填）" />
              <input class="input" v-model="model.name" placeholder="显示名称（选填）" />
              <button class="btn btn-ghost" @click="removeModelRow(index)">删除</button>
            </div>
            <button class="btn btn-secondary" @click="addModelRow">添加模型</button>
          </div>
        </div>
        <p v-if="customProviderError" class="error-text">{{ customProviderError }}</p>
        <div class="form-actions">
          <button class="btn btn-secondary" @click="resetCustomProviderForm">重置</button>
          <button class="btn btn-primary" :disabled="savingCustomProvider" @click="submitCustomProvider">
            {{ editingCustomId ? '保存修改' : '新增来源' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 搜索框 -->
    <div class="search-box">
      <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <path d="M21 21l-4.35-4.35"/>
      </svg>
      <input
        v-model="providerSearchQuery"
        type="text"
        placeholder="搜索供应商..."
        class="search-input"
      />
      <button v-if="providerSearchQuery" class="clear-btn" @click="clearSearch">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="filteredProviders.length === 0" class="empty-state">
      <div class="empty-state-icon">
        <svg v-if="providerSearchQuery" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/>
          <path d="M21 21l-4.35-4.35"/>
        </svg>
        <svg v-else width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <p class="empty-state-title">{{ providerSearchQuery ? '未找到匹配的供应商' : '暂无可用提供者' }}</p>
      <p class="empty-state-description">{{ providerSearchQuery ? '尝试其他关键词' : '配置将在这里显示' }}</p>
    </div>

    <div v-else class="list">
      <div v-for="provider in filteredProviders" :key="provider.id" class="list-item auth-item">
        <div class="list-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div class="list-item-content">
          <div class="list-item-title">{{ provider.name }}</div>
          <div class="auth-status">
            <span class="badge" :class="provider.authenticated ? 'badge-success' : 'badge-default'">
              {{ provider.authenticated ? '已认证' : '未认证' }}
            </span>
          </div>

          <!-- API Key Input -->
          <div v-if="showApiKeyInput[provider.id]" class="api-key-form">
            <div class="input-group">
              <input
                type="password"
                class="input"
                v-model="apiKeyInputs[provider.id]"
                placeholder="输入 API Key"
                @keyup.enter="submitApiKey(provider.id)"
              />
            </div>
            <div class="form-actions">
              <button class="btn btn-secondary" @click="toggleApiKeyInput(provider.id)">
                取消
              </button>
              <button class="btn btn-primary" @click="submitApiKey(provider.id)">
                保存
              </button>
            </div>
          </div>
        </div>
        <div class="list-item-actions">
          <template v-if="!provider.authenticated">
            <!-- OAuth Button -->
            <button
              v-if="provider.authMethods?.some(m => m.type === 'oauth')"
              class="btn btn-primary"
              @click="emit('oauth', provider.id)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.8 12H3"/>
              </svg>
              登录
            </button>
            <!-- API Key Button -->
            <button
              v-if="provider.authMethods?.some(m => m.type === 'api')"
              class="btn btn-secondary"
              @click="toggleApiKeyInput(provider.id)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
              </svg>
              API Key
            </button>
          </template>
          <template v-else>
            <button class="btn btn-ghost" @click="emit('remove', provider.id)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
              </svg>
              登出
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-manager {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.section-header {
  margin-bottom: var(--space-sm);
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.section-desc {
  margin: 0;
}

.auth-hint {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.auth-hint svg {
  flex-shrink: 0;
  color: var(--success);
}

.import-auth-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-md);
  margin-top: var(--space-md);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.import-auth-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.import-auth-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
}

.import-auth-desc {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.import-auth-result {
  padding: var(--space-md);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
}

.import-auth-result p {
  margin: 0;
}

.import-auth-result p + p {
  margin-top: var(--space-xs);
}

.search-box {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.search-box:focus-within {
  border-color: var(--accent);
}

.search-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 0.875rem;
  color: var(--text-primary);
  outline: none;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.clear-btn:hover {
  color: var(--text-primary);
  background: var(--bg-elevated);
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-xl);
}

.auth-item {
  flex-wrap: wrap;
}

.custom-provider-card {
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  background: var(--bg-tertiary);
}

.custom-provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-sm);
}

.custom-provider-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.custom-provider-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.custom-provider-item {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-sm);
  background: var(--bg-primary);
}

.custom-provider-title {
  font-size: 0.9rem;
  font-weight: 600;
}

.custom-provider-models,
.custom-provider-meta {
  margin-top: 2px;
}

.custom-provider-actions {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
}

.custom-provider-form {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-sm);
}

.label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.models-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.model-row {
  display: grid;
  grid-template-columns: 1.3fr 1fr auto;
  gap: var(--space-sm);
  align-items: center;
}

.error-text {
  color: var(--danger);
  font-size: 0.85rem;
}

.auth-status {
  margin-top: var(--space-xs);
}

.api-key-form {
  width: 100%;
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 0.5px solid var(--border-subtle);
}

.form-actions {
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
  justify-content: flex-end;
}
</style>
