<script setup lang="ts">
import { useSettings } from '../composables/useSettings'
import McpManager from './McpManager.vue'
import SkillsList from './SkillsList.vue'
import ModelSelector from './ModelSelector.vue'
import AuthManager from './AuthManager.vue'
import PreferencesPanel from './PreferencesPanel.vue'

const emit = defineEmits<{
  close: []
}>()

const {
  activeTab,
  providers,
  currentProvider,
  currentModel,
  loadingProviders,
  mcpServers,
  loadingMcp,
  skills,
  loadingSkills,
  selectModel,
  connectMcp,
  disconnectMcp,
  addMcp,
  removeMcp,
  startOAuth,
  setApiKey,
  removeAuth
} = useSettings()

function handleOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
    emit('close')
  }
}
</script>

<template>
  <div class="modal-overlay" @click="handleOverlayClick">
    <div class="modal settings-modal">
      <div class="modal-header">
        <h2 class="modal-title">设置</h2>
        <button class="btn btn-ghost btn-icon sm" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="settings-tabs">
        <div class="tabs">
          <button
            class="tab"
            :class="{ active: activeTab === 'models' }"
            @click="activeTab = 'models'"
          >
            模型
          </button>
          <button
            class="tab"
            :class="{ active: activeTab === 'mcp' }"
            @click="activeTab = 'mcp'"
          >
            MCP
          </button>
          <button
            class="tab"
            :class="{ active: activeTab === 'skills' }"
            @click="activeTab = 'skills'"
          >
            技能
          </button>
          <button
            class="tab"
            :class="{ active: activeTab === 'auth' }"
            @click="activeTab = 'auth'"
          >
            认证
          </button>
          <button
            class="tab"
            :class="{ active: activeTab === 'preferences' }"
            @click="activeTab = 'preferences'"
          >
            偏好
          </button>
        </div>
      </div>

      <div class="modal-body">
        <!-- Models Tab -->
        <ModelSelector
          v-if="activeTab === 'models'"
          :providers="providers"
          :currentProvider="currentProvider"
          :currentModel="currentModel"
          :loading="loadingProviders"
          @select="selectModel"
        />

        <!-- MCP Tab -->
        <McpManager
          v-if="activeTab === 'mcp'"
          :servers="mcpServers"
          :loading="loadingMcp"
          @connect="connectMcp"
          @disconnect="disconnectMcp"
          @add="addMcp"
          @remove="removeMcp"
        />

        <!-- Skills Tab -->
        <SkillsList
          v-if="activeTab === 'skills'"
          :skills="skills"
          :loading="loadingSkills"
        />

        <!-- Auth Tab -->
        <AuthManager
          v-if="activeTab === 'auth'"
          :providers="providers"
          :loading="loadingProviders"
          @oauth="startOAuth"
          @set-api-key="setApiKey"
          @remove="removeAuth"
        />

        <!-- Preferences Tab -->
        <PreferencesPanel
          v-if="activeTab === 'preferences'"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-modal {
  width: 90%;
  max-width: 700px;
  max-height: 80vh;
}

.settings-tabs {
  padding: 0 var(--space-lg);
  border-bottom: 1px solid var(--border-subtle);
}

.settings-tabs .tabs {
  background: var(--bg-tertiary);
  padding: 4px;
  gap: 4px;
  border-radius: var(--radius-md);
}

.settings-tabs .tab {
  flex: 1;
  background: transparent;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: none;
  margin: 0;
  text-align: center;
  color: var(--text-secondary);
  font-weight: 500;
  transition: all 0.2s ease;
}

.settings-tabs .tab:hover {
  color: var(--text-primary);
  background: rgba(125, 125, 125, 0.1);
}

.settings-tabs .tab.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}
</style>
