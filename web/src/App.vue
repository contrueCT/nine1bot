<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useSession } from './composables/useSession'
import { useFiles } from './composables/useFiles'
import { useSettings } from './composables/useSettings'
import Header from './components/Header.vue'
import Sidebar from './components/Sidebar.vue'
import ChatPanel from './components/ChatPanel.vue'
import InputBox from './components/InputBox.vue'
import SettingsPanel from './components/SettingsPanel.vue'

const {
  sessions,
  currentSession,
  messages,
  isLoading,
  isStreaming,
  currentDirectory,
  loadSessions,
  createSession,
  selectSession,
  sendMessage,
  abortCurrentSession,
  subscribeToEvents,
  unsubscribe
} = useSession()

const {
  files,
  isLoading: filesLoading,
  loadFiles,
  toggleDirectory
} = useFiles()

const { showSettings, openSettings, closeSettings, currentProvider, currentModel } = useSettings()

const sidebarCollapsed = ref(false)
const sidebarTab = ref<'sessions' | 'files'>('sessions')

onMounted(async () => {
  subscribeToEvents()

  // 不传 directory 参数以加载所有会话
  await loadSessions()
  await loadFiles('.')

  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0])
  } else {
    // 创建新会话时使用当前工作目录
    await createSession('.')
  }
})

onUnmounted(() => {
  unsubscribe()
})

// 注意：currentDirectory 可能是绝对路径，但文件 API 只接受相对路径
// 所以这里不再监听 currentDirectory 的变化来重新加载文件
// 文件浏览始终显示项目根目录的内容

async function handleSend(content: string) {
  if (!currentSession.value) {
    await createSession(currentDirectory.value || '.')
  }
  // 如果选择了模型，传递给 sendMessage
  const model = currentProvider.value && currentModel.value
    ? { providerID: currentProvider.value, modelID: currentModel.value }
    : undefined
  await sendMessage(content, model)
}

function handleNewSession() {
  createSession(currentDirectory.value || '.')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <Sidebar
      :collapsed="sidebarCollapsed"
      :sessions="sessions"
      :currentSession="currentSession"
      :files="files"
      :filesLoading="filesLoading"
      :activeTab="sidebarTab"
      @toggle-collapse="toggleSidebar"
      @select-session="selectSession"
      @new-session="handleNewSession"
      @toggle-directory="toggleDirectory"
      @change-tab="(tab) => sidebarTab = tab"
    />

    <!-- Main Content -->
    <div class="main-content">
      <!-- Header -->
      <Header
        :session="currentSession"
        :directory="currentDirectory"
        :isStreaming="isStreaming"
        :sidebarCollapsed="sidebarCollapsed"
        @toggle-sidebar="toggleSidebar"
        @new-session="handleNewSession"
        @abort="abortCurrentSession"
        @open-settings="openSettings"
      />

      <!-- Chat Area -->
      <div class="chat-panel">
        <ChatPanel
          :messages="messages"
          :isLoading="isLoading"
          :isStreaming="isStreaming"
        />
        <InputBox
          :disabled="isLoading"
          :isStreaming="isStreaming"
          @send="handleSend"
          @abort="abortCurrentSession"
        />
      </div>
    </div>

    <!-- Settings Modal -->
    <SettingsPanel
      v-if="showSettings"
      @close="closeSettings"
    />
  </div>
</template>

<style scoped>
/* Layout uses global styles from style.css */
</style>
