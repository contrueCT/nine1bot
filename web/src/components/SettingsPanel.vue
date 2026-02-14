<script setup lang="ts">
import { ref } from 'vue'
import { Sun, Moon, Upload, X, User } from 'lucide-vue-next'
import { useSettings } from '../composables/useSettings'
import { useTheme } from '../composables/useTheme'
import { useUserProfile } from '../composables/useUserProfile'
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
  filteredProviders,
  currentProvider,
  currentModel,
  defaultProvider,
  defaultModel,
  loadingProviders,
  mcpServers,
  loadingMcp,
  skills,
  loadingSkills,
  selectModel,
  setDefaultModel,
  connectMcp,
  disconnectMcp,
  addMcp,
  removeMcp,
  startOAuth,
  setApiKey,
  removeAuth
} = useSettings()

const { theme, toggleTheme } = useTheme()
const { profile, brandLogo, botAvatar, setName, setAvatar, setLogo, setBotAvatar, clearAvatar, clearLogo, clearBotAvatar } = useUserProfile()

const editingName = ref(profile.value.name || '')
const avatarInputRef = ref<HTMLInputElement>()
const logoInputRef = ref<HTMLInputElement>()
const botAvatarInputRef = ref<HTMLInputElement>()

function saveName() {
  setName(editingName.value.trim())
}

function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    setAvatar(reader.result as string)
  }
  reader.readAsDataURL(file)
  input.value = ''
}

function handleLogoUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    setLogo(reader.result as string)
  }
  reader.readAsDataURL(file)
  input.value = ''
}

function handleBotAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    setBotAvatar(reader.result as string)
  }
  reader.readAsDataURL(file)
  input.value = ''
}

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
          <button
            class="tab"
            :class="{ active: activeTab === 'profile' }"
            @click="activeTab = 'profile'"
          >
            个人
          </button>
        </div>
      </div>

      <div class="modal-body">
        <!-- Models Tab -->
        <ModelSelector
          v-if="activeTab === 'models'"
          :providers="filteredProviders"
          :currentProvider="currentProvider"
          :currentModel="currentModel"
          :defaultProvider="defaultProvider"
          :defaultModel="defaultModel"
          :loading="loadingProviders"
          @select="selectModel"
          @set-default="setDefaultModel"
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
          :loading="loadingProviders"
          @oauth="startOAuth"
          @set-api-key="setApiKey"
          @remove="removeAuth"
        />

        <!-- Preferences Tab -->
        <PreferencesPanel
          v-if="activeTab === 'preferences'"
        />

        <!-- Profile Tab -->
        <div v-if="activeTab === 'profile'" class="profile-tab">
          <!-- Avatar -->
          <div class="profile-section">
            <h3 class="profile-section-title">头像</h3>
            <div class="avatar-section">
              <div class="avatar-preview">
                <img v-if="profile.avatarUrl" :src="profile.avatarUrl" alt="Avatar" class="avatar-preview-img" />
                <User v-else :size="32" />
              </div>
              <div class="avatar-actions">
                <input ref="avatarInputRef" type="file" accept="image/*" style="display: none" @change="handleAvatarUpload" />
                <button class="btn btn-ghost btn-sm" @click="avatarInputRef?.click()">
                  <Upload :size="14" />
                  <span>上传头像</span>
                </button>
                <button v-if="profile.avatarUrl" class="btn btn-ghost btn-sm" @click="clearAvatar">
                  <X :size="14" />
                  <span>移除</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Bot Avatar -->
          <div class="profile-section">
            <h3 class="profile-section-title">Bot 头像</h3>
            <p class="profile-section-desc">自定义对话中 AI 助手的头像</p>
            <div class="avatar-section">
              <div class="avatar-preview bot-avatar-preview">
                <img v-if="botAvatar.botAvatarUrl" :src="botAvatar.botAvatarUrl" alt="Bot Avatar" class="avatar-preview-img" />
                <svg v-else width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 8V4H8"/>
                  <rect width="16" height="12" x="4" y="8" rx="2"/>
                  <path d="m2 14 2-2-2-2"/>
                  <path d="m22 14-2-2 2-2"/>
                  <path d="M15 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>
                  <path d="M9 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>
                </svg>
              </div>
              <div class="avatar-actions">
                <input ref="botAvatarInputRef" type="file" accept="image/*" style="display: none" @change="handleBotAvatarUpload" />
                <button class="btn btn-ghost btn-sm" @click="botAvatarInputRef?.click()">
                  <Upload :size="14" />
                  <span>上传头像</span>
                </button>
                <button v-if="botAvatar.botAvatarUrl" class="btn btn-ghost btn-sm" @click="clearBotAvatar">
                  <X :size="14" />
                  <span>移除</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Name -->
          <div class="profile-section">
            <h3 class="profile-section-title">用户名</h3>
            <div class="name-input-row">
              <input
                v-model="editingName"
                type="text"
                class="profile-input"
                placeholder="输入你的名称"
                @blur="saveName"
                @keyup.enter="saveName"
              />
            </div>
          </div>

          <!-- Theme / Dark Mode -->
          <div class="profile-section">
            <h3 class="profile-section-title">外观</h3>
            <div class="theme-toggle-row">
              <span class="theme-label">{{ theme === 'dark' ? '暗色模式' : '亮色模式' }}</span>
              <button class="theme-toggle-btn" @click="toggleTheme">
                <Sun v-if="theme === 'dark'" :size="16" />
                <Moon v-else :size="16" />
                <span>{{ theme === 'dark' ? '切换到亮色' : '切换到暗色' }}</span>
              </button>
            </div>
          </div>

          <!-- Brand Logo -->
          <div class="profile-section">
            <h3 class="profile-section-title">品牌 Logo</h3>
            <p class="profile-section-desc">自定义侧边栏顶部的 Nine1Bot logo</p>
            <div class="avatar-section">
              <div class="logo-preview">
                <img v-if="brandLogo.logoUrl" :src="brandLogo.logoUrl" alt="Logo" class="logo-preview-img" />
                <span v-else class="logo-preview-text">N</span>
              </div>
              <div class="avatar-actions">
                <input ref="logoInputRef" type="file" accept="image/*" style="display: none" @change="handleLogoUpload" />
                <button class="btn btn-ghost btn-sm" @click="logoInputRef?.click()">
                  <Upload :size="14" />
                  <span>上传 Logo</span>
                </button>
                <button v-if="brandLogo.logoUrl" class="btn btn-ghost btn-sm" @click="clearLogo">
                  <X :size="14" />
                  <span>移除</span>
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
.settings-modal {
  width: 90%;
  max-width: 700px;
  max-height: 80vh;
}

.settings-tabs {
  padding: 0 var(--space-lg);
  border-bottom: 0.5px solid var(--border-subtle);
}

.settings-tabs .tabs {
  background: var(--bg-tertiary);
  padding: 4px;
  gap: 4px;
  border-radius: var(--radius-md);
  border-bottom: none;
}

.settings-tabs .tab {
  flex: 1;
  background: transparent;
  padding: 6px 16px;
  border-radius: var(--radius-sm);
  border: none;
  margin: 0;
  text-align: center;
  color: var(--text-secondary);
  font-weight: var(--font-weight-normal);
  transition: all var(--transition-fast);
}

.settings-tabs .tab:hover {
  color: var(--text-primary);
  background: rgba(0, 0, 0, 0.04);
}

.settings-tabs .tab.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-weight: 500;
}

/* Profile Tab */
.profile-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.profile-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.profile-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.profile-section-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
}

.avatar-section {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.avatar-preview {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: 50%;
  color: var(--text-muted);
  overflow: hidden;
  flex-shrink: 0;
}

.avatar-preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bot-avatar-preview {
  background: var(--accent);
  color: white;
  border-radius: var(--radius-sm);
}

.avatar-actions {
  display: flex;
  gap: var(--space-xs);
}

.avatar-actions .btn {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name-input-row {
  max-width: 300px;
}

.profile-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.profile-input:focus {
  border-color: var(--accent);
}

.theme-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
}

.theme-label {
  font-size: 14px;
  color: var(--text-secondary);
}

.theme-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.theme-toggle-btn:hover {
  background: var(--accent-subtle);
  color: var(--accent);
}

.logo-preview {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
}

.logo-preview-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.logo-preview-text {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-muted);
}
</style>
