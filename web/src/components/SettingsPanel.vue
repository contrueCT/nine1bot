<script setup lang="ts">
import { computed, ref, watch, defineAsyncComponent } from 'vue'
import { useModalFocus } from '../composables/useModalFocus'
import { Sun, Moon, Monitor, Upload, X, User, Info, ExternalLink } from 'lucide-vue-next'
import { useSettings } from '../composables/useSettings'
import { useTheme } from '../composables/useTheme'
import { useUserProfile } from '../composables/useUserProfile'
import { NINE1BOT_WEB_PROVENANCE } from '../provenance'
import type { Nine1BotProjectOption } from '../api/client'
const McpManager = defineAsyncComponent(() => import('./McpManager.vue'))
const SkillsList = defineAsyncComponent(() => import('./SkillsList.vue'))
import ModelSelector from './ModelSelector.vue'
const AuthManager = defineAsyncComponent(() => import('./AuthManager.vue'))
const PreferencesPanel = defineAsyncComponent(() => import('./PreferencesPanel.vue'))
const PlatformManager = defineAsyncComponent(() => import('./PlatformManager.vue'))

const { projects } = defineProps<{
  projects: Nine1BotProjectOption[]
}>()

const emit = defineEmits<{
  close: []
}>()

const {
  settingsError,
  savingModel,
  loadSettingsTab,
  activeTab,
  modelProviders,
  providers,
  currentProvider,
  currentModel,
  defaultProvider,
  defaultModel,
  loadingProviders,
  importingAuth,
  authImportResult,
  mcpServers,
  loadingMcp,
  skills,
  loadingSkills,
  platforms,
  selectedPlatformId,
  selectedPlatform,
  loadingPlatforms,
  savingPlatform,
  platformActionRunning,
  platformError,
  platformActionResult,
  selectModel,
  setDefaultModel,
  connectMcp,
  authenticateMcp,
  disconnectMcp,
  addMcp,
  removeMcp,
  startOAuth,
  setApiKey,
  removeAuth,
  importAuthFromOpencode,
  loadPlatformDetail,
  updatePlatform,
  refreshPlatformStatus,
  executePlatformAction,
} = useSettings()

const { preference: themePreference, setTheme } = useTheme()
const themeOptions = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const
const { profile, brandLogo, botAvatar, setName, setAvatar, setLogo, setBotAvatar, clearAvatar, clearLogo, clearBotAvatar } = useUserProfile()

const editingName = ref(profile.value.name || '')
const avatarInputRef = ref<HTMLInputElement>()
const logoInputRef = ref<HTMLInputElement>()
const botAvatarInputRef = ref<HTMLInputElement>()
const provenance = NINE1BOT_WEB_PROVENANCE

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

type SettingsTab = typeof activeTab.value
const navigation: { id: SettingsTab; label: string; description: string }[] = [
  { id: 'models', label: '模型与供应商', description: '选择模型、管理连接' },
  { id: 'mcp', label: '工具与 MCP', description: '连接外部工具' },
  { id: 'skills', label: '技能', description: '扩展助手能力' },
  { id: 'platforms', label: '平台集成', description: '飞书、GitLab 等' },
  { id: 'preferences', label: '偏好', description: '回复与工作习惯' },
  { id: 'profile', label: '外观与个人', description: '主题、头像与名称' },
  { id: 'about', label: '关于', description: '版本与项目信息' },
]
const activeSection = computed(() => activeTab.value === 'auth' ? 'models' : activeTab.value)
const activeLabel = computed(() => navigation.find(item => item.id === activeSection.value)?.label)
const mobileDetail = ref(false)
const visited = ref(new Set<SettingsTab>([activeTab.value]))
const modalRef = ref<HTMLElement>()
const authRef = ref<{ hasUnsavedChanges: boolean; isSaving: boolean }>()
const mcpRef = ref<{ hasUnsavedChanges: boolean; isSaving: boolean }>()
const platformRef = ref<{ hasUnsavedChanges: boolean }>()
const settingsNotice = ref('')
const hasUnsavedChanges = computed(() => Boolean(authRef.value?.hasUnsavedChanges || mcpRef.value?.hasUnsavedChanges || platformRef.value?.hasUnsavedChanges || editingName.value.trim() !== (profile.value.name || '')))
watch(activeTab, tab => {
  visited.value.add(tab)
  settingsNotice.value = ''
  const dirty = tab === 'platforms' ? platformRef.value?.hasUnsavedChanges : tab === 'mcp' ? mcpRef.value?.hasUnsavedChanges : (tab === 'auth' || tab === 'models') ? authRef.value?.hasUnsavedChanges : false
  if (!dirty) void loadSettingsTab(tab)
}, { immediate: true })
function chooseSection(tab: SettingsTab) { activeTab.value = tab; mobileDetail.value = true }
function requestClose() {
  if (savingModel.value || savingPlatform.value || authRef.value?.isSaving || mcpRef.value?.isSaving) { settingsNotice.value = '正在保存，请稍候…'; return }
  if (hasUnsavedChanges.value && !window.confirm('有未保存的修改，确定关闭并丢弃吗？')) return
  emit('close')
}
useModalFocus(modalRef, requestClose)
async function runAction(action: () => Promise<unknown>, notice = '已保存') {
  settingsNotice.value = ''
  settingsError.value = ''
  try {
    if (await action() !== false) settingsNotice.value = notice
  } catch (error) { settingsError.value = error instanceof Error ? error.message : '操作失败，请重试' }
}
async function saveKey(id: string, key: string) {
  const success = await setApiKey(id, key)
  if (success) settingsNotice.value = '认证已保存'
  return success
}
async function saveServer(name: string, config: Parameters<typeof addMcp>[1]) {
  await addMcp(name, config)
  settingsNotice.value = 'MCP 服务器已保存'
}
function handleOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
    requestClose()
  }
}
</script>

<template>
  <div class="modal-overlay" @click="handleOverlayClick">
    <div class="modal settings-modal" ref="modalRef" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1">
      <div class="modal-header">
        <div class="settings-heading"><button v-if="mobileDetail" class="settings-back btn btn-ghost btn-sm" @click="mobileDetail = false">← 返回</button><h2 id="settings-title" class="modal-title">{{ mobileDetail ? activeLabel : '设置' }}</h2></div>
        <button class="btn btn-ghost btn-icon sm" @click="requestClose" aria-label="关闭设置">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="settings-layout" :class="{ 'is-detail': mobileDetail }">
        <nav class="settings-nav" aria-label="设置分类">
          <button v-for="item in navigation" :key="item.id" class="settings-nav-item" :class="{ active: activeSection === item.id }" :aria-current="activeSection === item.id ? 'page' : undefined" @click="chooseSection(item.id)">
            <span>{{ item.label }}</span><small>{{ item.description }}</small>
          </button>
        </nav>
      <div class="modal-body settings-content" @input="settingsNotice = ''">
        <div class="settings-feedback" aria-live="polite">
          <span v-if="savingModel">正在保存模型…</span><span v-else-if="settingsNotice">{{ settingsNotice }}</span>
          <button class="btn btn-ghost btn-sm settings-refresh" :disabled="hasUnsavedChanges" @click="loadSettingsTab(activeTab, true)">刷新</button>
        </div>
        <div v-if="activeSection === 'models'" class="models-subnav" aria-label="模型与供应商">
          <button :class="{ active: activeTab === 'models' }" @click="activeTab = 'models'">可用模型</button>
          <button :class="{ active: activeTab === 'auth' }" @click="activeTab = 'auth'">供应商连接</button>
        </div>
        <div v-if="settingsError" class="settings-error" role="alert">{{ settingsError }}</div>
        <!-- Models Tab -->
        <ModelSelector
          v-if="visited.has('models')" v-show="activeTab === 'models'"
          :providers="modelProviders"
          :currentProvider="currentProvider"
          :currentModel="currentModel"
          :defaultProvider="defaultProvider"
          :defaultModel="defaultModel"
          :loading="loadingProviders"
          @select="(provider, model) => runAction(() => selectModel(provider, model))"
          @set-default="(provider, model) => runAction(() => setDefaultModel(provider, model))"
          @manage-providers="activeTab = 'auth'"
        />

        <!-- MCP Tab -->
        <McpManager ref="mcpRef" :saveServer="saveServer"
          v-if="visited.has('mcp')" v-show="activeTab === 'mcp'"
          :servers="mcpServers"
          :loading="loadingMcp"
          @connect="name => runAction(() => connectMcp(name), '连接状态已更新')"
          @authenticate="name => runAction(() => authenticateMcp(name), '认证已更新')"
          @disconnect="name => runAction(() => disconnectMcp(name), '连接状态已更新')"
          @add="addMcp"
          @remove="name => runAction(() => removeMcp(name), '服务器已移除')"
        />

        <!-- Skills Tab -->
        <SkillsList
          v-if="visited.has('skills')" v-show="activeTab === 'skills'"
          :skills="skills"
          :loading="loadingSkills"
        />

        <!-- Auth Tab -->
        <AuthManager ref="authRef" :saveApiKey="saveKey"
          v-if="visited.has('auth')" v-show="activeTab === 'auth'"
          :loading="loadingProviders"
          :importing="importingAuth"
          :importResult="authImportResult"
          @oauth="id => runAction(() => startOAuth(id), '已打开授权页面')"
          @set-api-key="setApiKey"
          @remove="removeAuth"
          @import-opencode="() => runAction(importAuthFromOpencode, '认证导入完成')"
        />

        <!-- Preferences Tab -->
        <PreferencesPanel
          v-if="visited.has('preferences')" v-show="activeTab === 'preferences'"
        />

        <!-- Platforms Tab -->
        <PlatformManager ref="platformRef"
          v-if="visited.has('platforms')" v-show="activeTab === 'platforms'"
          :platforms="platforms"
          :selected-platform-id="selectedPlatformId"
          :selected-platform="selectedPlatform"
          :loading="loadingPlatforms"
          :saving="savingPlatform"
          :action-running="platformActionRunning"
          :error="platformError"
          :action-result="platformActionResult"
          :providers="providers"
          :projects="projects"
          @select="loadPlatformDetail"
          @update="(id, patch) => runAction(() => updatePlatform(id, patch))"
          @refresh="id => runAction(() => refreshPlatformStatus(id), '状态已刷新')"
          @action="(id, action, input, confirm) => runAction(() => executePlatformAction(id, action, input, confirm), '操作已完成')"
        />

        <!-- About Tab -->
        <div v-if="activeTab === 'about'" class="about-tab">
          <div class="about-identity">
            <div class="about-mark" aria-hidden="true">
              <Info :size="24" />
            </div>
            <div class="about-title">
              <h3>{{ provenance.productName }}</h3>
              <p>{{ provenance.copyright }}</p>
            </div>
          </div>

          <div class="about-grid">
            <div class="about-row">
              <span>版本</span>
              <code>{{ provenance.version }}</code>
            </div>
            <div class="about-row">
              <span>原始仓库</span>
              <code>{{ provenance.sourceRepository }}</code>
            </div>
            <div class="about-row">
              <span>许可证</span>
              <code>{{ provenance.license }} / {{ provenance.spdxLicenseIdentifier }}</code>
            </div>
            <div class="about-row">
              <span>溯源 ID</span>
              <code>{{ provenance.provenanceId }}</code>
            </div>
            <div class="about-row">
              <span>构建提交</span>
              <code>{{ provenance.build.commit || '开发版' }}</code>
            </div>
            <div class="about-row">
              <span>构建时间</span>
              <code>{{ provenance.build.date || '开发版' }}</code>
            </div>
          </div>

          <div class="about-actions">
            <a
              class="btn btn-secondary btn-sm"
              :href="provenance.sourceRepository"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink :size="14" />
              <span>打开原始仓库</span>
            </a>
          </div>
        </div>

        <!-- Profile Tab -->
        <div v-if="activeTab === 'profile'" class="profile-tab">
          <!-- Avatar -->
          <div class="profile-section">
            <h3 class="profile-section-title">头像</h3>
            <div class="avatar-section">
              <div class="avatar-preview">
                <img v-if="profile.avatarUrl" :src="profile.avatarUrl" alt="头像" class="avatar-preview-img" />
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
                <img v-if="botAvatar.botAvatarUrl" :src="botAvatar.botAvatarUrl" alt="Bot 头像" class="avatar-preview-img" />
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
            <div class="theme-segmented" role="radiogroup" aria-label="界面主题">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                role="radio"
                class="theme-option"
                :class="{ active: themePreference === option.value }"
                :aria-checked="themePreference === option.value"
                @click="setTheme(option.value)"
              >
                <component :is="option.icon" :size="15" aria-hidden="true" />
                <span>{{ option.label }}</span>
              </button>
            </div>
          </div>

          <!-- Brand Logo -->
          <div class="profile-section">
            <h3 class="profile-section-title">品牌 Logo</h3>
            <p class="profile-section-desc">自定义侧边栏顶部的 Nine1Bot logo</p>
            <div class="avatar-section">
              <div class="logo-preview">
                <img v-if="brandLogo.logoUrl" :src="brandLogo.logoUrl" alt="品牌 Logo" class="logo-preview-img" />
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
  </div>
</template>

<style scoped>
.settings-error { padding: 12px; margin-bottom: 16px; color: var(--error); background: var(--error-subtle); border-radius: var(--radius-md); }
.settings-modal { width: min(1040px, calc(100vw - 64px)); height: min(760px, calc(100dvh - 80px)); max-width: none; max-height: none; overflow: hidden; }
.settings-heading { display: flex; align-items: center; gap: 8px; }
.settings-layout { display: flex; flex: 1; min-height: 0; }
.settings-nav { width: 204px; flex-shrink: 0; padding: 12px; background: var(--bg-secondary); border-right: 1px solid var(--border-subtle); overflow-y: auto; }
.settings-nav-item { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; padding: 12px; margin-bottom: 4px; background: transparent; border: 1px solid transparent; border-radius: 9px; color: var(--text-secondary); cursor: pointer; }
.settings-nav-item > span { font-size: var(--text-13); font-weight: 500; white-space: nowrap; }
.settings-nav-item small { color: var(--text-muted); font-size: var(--text-xs); }
.settings-nav-item:hover { background: var(--hover-overlay); }
.settings-nav-item.active { background: var(--bg-elevated); border-color: var(--border-default); color: var(--text-primary); box-shadow: var(--shadow-sm); }
.settings-content { min-width: 0; flex: 1; overflow: auto; padding: 20px 28px 32px; }
.settings-feedback { display: flex; min-height: 30px; align-items: center; color: var(--success); font-size: var(--text-sm); margin-bottom: 8px; }
.settings-refresh { margin-left: auto; }
.models-subnav { display: flex; gap: 20px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 24px; }
.models-subnav button { border: 0; border-bottom: 2px solid transparent; padding: 8px 0 12px; background: transparent; color: var(--text-muted); cursor: pointer; }
.models-subnav button.active { color: var(--text-primary); border-bottom-color: var(--accent); }
.settings-back { display: none; }
@media (max-width: 640px) {
  .modal-overlay { padding: 0; }
  .settings-modal { width: 100%; height: 100dvh; border-radius: 0; }
  .settings-nav { width: 100%; border: 0; }
  .settings-nav-item { padding: 16px; border-bottom: 1px solid var(--border-subtle); }
  .settings-content { display: none; padding: 12px 18px 24px; }
  .settings-layout.is-detail .settings-nav { display: none; }
  .settings-layout.is-detail .settings-content { display: block; }
  .settings-back { display: inline-flex; }
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
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.profile-section-desc {
  font-size: var(--text-13);
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
  color: var(--accent-fg);
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
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  outline: none;
  transition: border-color 0.2s;
}

.profile-input:focus {
  border-color: var(--accent);
}

.theme-segmented {
  display: inline-flex;
  align-self: flex-start;
  width: fit-content;
  gap: 2px;
  padding: 3px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.theme-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: var(--text-13);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.theme-option:hover {
  color: var(--text-primary);
}

.theme-option.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
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
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--text-muted);
}

.about-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.about-identity {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.about-mark {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
}

.about-title {
  min-width: 0;
}

.about-title h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.about-title p {
  margin: 4px 0 0;
  font-size: var(--text-13);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.about-grid {
  display: grid;
  gap: 0;
}

.about-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: var(--space-md);
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.about-row span {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.about-row code {
  min-width: 0;
  padding: 3px 6px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}

.about-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

@media (max-width: 640px) {
  .about-row {
    grid-template-columns: 1fr;
    gap: var(--space-xs);
  }
}
</style>
