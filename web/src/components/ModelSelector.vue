<script setup lang="ts">
import type { Provider } from '../api/client'

const props = defineProps<{
  providers: Provider[]
  currentProvider: string
  currentModel: string
  defaultProvider: string
  defaultModel: string
  loading: boolean
}>()

const emit = defineEmits<{
  select: [providerId: string, modelId: string]
  'set-default': [providerId: string, modelId: string]
}>()

function isDefault(providerId: string, modelId: string) {
  return props.defaultProvider === providerId && props.defaultModel === modelId
}
</script>

<template>
  <div class="model-selector">
    <div class="section-header">
      <h3 class="section-title">AI 模型</h3>
      <p class="section-desc text-muted text-sm">选择要使用的 AI 提供者和模型</p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="providers.length === 0" class="empty-state">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
      </div>
      <p class="empty-state-title">暂无可用模型</p>
      <p class="empty-state-description">请先配置 AI 提供者认证</p>
    </div>

    <div v-else class="providers-list">
      <div v-for="provider in providers" :key="provider.id" class="provider-section">
        <div class="provider-header">
          <div class="provider-info">
            <div class="provider-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <span class="provider-name">{{ provider.name }}</span>
          </div>
          <span class="badge" :class="provider.authenticated ? 'badge-success' : 'badge-warning'">
            {{ provider.authenticated ? '已认证' : '未认证' }}
          </span>
        </div>

        <div class="models-grid">
          <div
            v-for="model in provider.models"
            :key="model.id"
            class="model-card"
            :class="{ active: currentModel === model.id, disabled: !provider.authenticated }"
            @click="provider.authenticated && emit('select', provider.id, model.id)"
          >
            <div class="model-radio">
              <div class="radio-outer">
                <div v-if="currentModel === model.id" class="radio-inner"></div>
              </div>
            </div>
            <div class="model-info">
              <div class="model-name-row">
                <span class="model-name">{{ model.name || model.id }}</span>
                <span v-if="isDefault(provider.id, model.id)" class="badge-default">默认</span>
              </div>
              <div class="model-meta text-xs text-muted">
                <span v-if="model.contextWindow">{{ (model.contextWindow / 1000).toFixed(0) }}K context</span>
                <button
                  v-if="provider.authenticated && !isDefault(provider.id, model.id)"
                  class="set-default-btn"
                  @click.stop="emit('set-default', provider.id, model.id)"
                >
                  设为默认
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-selector {
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

.providers-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xl);
}

.provider-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.provider-info {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.provider-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  color: var(--text-muted);
}

.provider-name {
  font-weight: 500;
}

.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-sm);
}

.model-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: var(--space-md);
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.model-card:hover:not(.disabled) {
  background: var(--bg-elevated);
  border-color: var(--border-default);
}

.model-card.active {
  background: var(--accent-subtle);
  border-color: var(--accent);
}

.model-card.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-radio {
  flex-shrink: 0;
  padding-top: 2px;
}

.radio-outer {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--transition-fast);
}

.model-card.active .radio-outer {
  border-color: var(--accent);
}

.radio-inner {
  width: 8px;
  height: 8px;
  background: var(--accent);
  border-radius: 50%;
}

.model-info {
  flex: 1;
  min-width: 0;
}

.model-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.model-name {
  font-weight: 500;
}

.badge-default {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--accent);
  color: white;
  border-radius: var(--radius-sm);
  font-weight: 500;
  line-height: 1.4;
  flex-shrink: 0;
}

.model-meta {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.set-default-btn {
  font-size: 11px;
  padding: 0 4px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-family: var(--font-sans);
  transition: color var(--transition-fast);
}

.set-default-btn:hover {
  color: var(--accent);
}
</style>
