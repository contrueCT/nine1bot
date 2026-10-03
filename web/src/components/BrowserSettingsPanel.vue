<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { browserSettingsChanges } from '../utils/browser-settings'
import { nine1botConfigApi, type BrowserReadiness, type BrowserSettings } from '../api/client'
const emit = defineEmits<{ openModels: [] }>()
const readiness = ref<BrowserReadiness>()
const draft = ref<BrowserSettings>({ enabled: false, cdpPort: 9222, autoLaunch: true, headless: false })
const saved = ref('')
const loading = ref(false)
const isSaving = ref(false)
const error = ref('')
const notice = ref('')
const restartRequired = ref(false)
const hasUnsavedChanges = computed(() => saved.value !== '' && JSON.stringify(draft.value) !== saved.value)
defineExpose({ hasUnsavedChanges, isSaving })
async function refresh() {
  if (loading.value || isSaving.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await nine1botConfigApi.readiness()
    readiness.value = result
    restartRequired.value = result.restartRequired
    // Refreshing diagnostics must never erase edits in progress.
    if (!hasUnsavedChanges.value) {
      draft.value = { ...result.settings }
      saved.value = JSON.stringify(draft.value)
    }
  } catch (e) { error.value = e instanceof Error ? e.message : '检查失败，请重试' }
  finally { loading.value = false }
}
async function save() {
  if (isSaving.value || loading.value || !readiness.value?.writable) return
  isSaving.value = true
  error.value = ''; notice.value = ''
  try {
    const settings = { ...draft.value, executablePath: draft.value.executablePath?.trim() || null }
    const changes = browserSettingsChanges(JSON.parse(saved.value), draft.value)
    await nine1botConfigApi.updateBrowser(changes)
    draft.value = { ...draft.value, executablePath: settings.executablePath ?? undefined }
    saved.value = JSON.stringify(draft.value)
    restartRequired.value = true
    notice.value = '已保存。请重启 Nine1Bot 服务，让浏览器配置生效。'
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败，请重试' }
  finally { isSaving.value = false }
}
onMounted(refresh)
</script>

<template>
  <section class="browser-settings" aria-labelledby="browser-settings-title">
    <h3 id="browser-settings-title">首次使用就绪检查</h3>
    <p>仅检查配置与当前连接，不会启动 Chrome 或发送付费模型请求。</p>
    <button type="button" :disabled="loading || isSaving" @click="refresh">{{ loading ? '检查中…' : '刷新检查' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="readiness">
      <ul aria-label="就绪检查清单">
        <li>模型：{{ readiness.modelConfigured ? '已选择默认模型，尚未验证认证与实际调用' : '尚未选择默认模型' }} <button type="button" @click="emit('openModels')">配置模型与认证</button></li>
        <li>浏览器服务：{{ readiness.bridge === 'active' ? '当前进程已启用' : '当前进程未启用。启用后请重启服务' }}</li>
        <li>Chrome 文件：{{ readiness.chrome.message }}</li>
        <li>机器人浏览器：{{ readiness.bot === 'running' ? 'CDP 已响应' : readiness.bot === 'unknown' ? '检查超时或失败，请重试' : '尚未运行。需要浏览器操作时才会启动（须启用自动启动），或手动启动配置端口的 Chrome' }}</li>
        <li>用户浏览器扩展：{{ readiness.extension === 'connected' ? '已连接' : readiness.extension === 'unknown' ? '检查失败，请重试' : '未连接。请在扩展设置中连接当前 Nine1Bot 服务' }}</li>
      </ul>
      <p>机器人浏览器和用户浏览器扩展是可选的不同通道，只需准备你要使用的通道。</p>
      <ul v-if="readiness.issues.length"><li v-for="issue in readiness.issues" :key="issue.code">{{ issue.message }}</li></ul>
      <p v-if="restartRequired">保存后的配置需要重启；上方连接状态仍反映当前进程。</p>
      <h3>机器人 Chrome 配置</h3>
      <form @submit.prevent="save">
        <fieldset :disabled="isSaving || loading || !readiness.writable">
          <label><input v-model="draft.enabled" type="checkbox">启用浏览器服务</label>
          <label>Chrome 可执行文件路径<input v-model="draft.executablePath" type="text" placeholder="自动检测" autocomplete="off" spellcheck="false"></label>
          <p>填写运行 Nine1Bot 的服务器上的绝对路径，不是你正在浏览网页的电脑路径。不要填写引号、命令或参数。清空已填路径会明确启用自动检测，并覆盖全局配置中的路径。</p>
          <label>CDP 端口<input v-model.number="draft.cdpPort" type="number" min="1" max="65535" required></label>
          <label><input v-model="draft.autoLaunch" type="checkbox">需要时自动启动</label>
          <label><input v-model="draft.headless" type="checkbox">无头模式</label>
          <button type="submit" :disabled="!hasUnsavedChanges">{{ isSaving ? '保存中…' : '保存并在重启后生效' }}</button>
        </fieldset>
      </form>
      <p v-if="!readiness.writable">当前服务没有可写配置路径，请通过 Nine1Bot 启动器启动服务。</p>
    </template>
  </section>
</template>
<style scoped>
.browser-settings { display: grid; gap: 12px; }
p, li { line-height: 1.6; }
fieldset { border: 0; padding: 0; display: grid; gap: 14px; }
label { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
input[type="text"] { width: 100%; padding: 8px; }
button { width: fit-content; }
</style>
