<script setup lang="ts">
import { ref } from 'vue'
import type { Provider } from '../api/client'

defineProps<{
  providers: Provider[]
  loading: boolean
}>()

const emit = defineEmits<{
  oauth: [providerId: string]
  'set-api-key': [providerId: string, apiKey: string]
  remove: [providerId: string]
}>()

const apiKeyInputs = ref<Record<string, string>>({})
const showApiKeyInput = ref<Record<string, boolean>>({})

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
</script>

<template>
  <div class="auth-manager">
    <div class="section-header">
      <h3 class="section-title">认证管理</h3>
      <p class="section-desc text-muted text-sm">管理 AI 提供者的认证信息</p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="providers.length === 0" class="empty-state">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <p class="empty-state-title">暂无可用提供者</p>
      <p class="empty-state-description">配置将在这里显示</p>
    </div>

    <div v-else class="list">
      <div v-for="provider in providers" :key="provider.id" class="list-item auth-item">
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
              v-if="provider.authMethods?.some(m => m.type === 'apiKey')"
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

.auth-status {
  margin-top: var(--space-xs);
}

.api-key-form {
  width: 100%;
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
}

.form-actions {
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
  justify-content: flex-end;
}
</style>
