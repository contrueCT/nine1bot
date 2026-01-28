<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useSession } from './composables/useSession'
import { useFiles } from './composables/useFiles'
import Header from './components/Header.vue'
import FileTree from './components/FileTree.vue'
import ChatPanel from './components/ChatPanel.vue'
import InputBox from './components/InputBox.vue'

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

const showSidebar = ref(true)

onMounted(async () => {
  // 订阅事件流以获取实时更新
  subscribeToEvents()

  // 默认加载当前目录的会话
  const defaultDir = '.'
  await loadSessions(defaultDir)
  await loadFiles(defaultDir)

  // 如果有会话，选择最新的一个
  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0])
  } else {
    // 创建新会话
    await createSession(defaultDir)
  }
})

onUnmounted(() => {
  unsubscribe()
})

watch(currentDirectory, async (newDir) => {
  if (newDir) {
    await loadFiles(newDir)
  }
})

async function handleSend(content: string) {
  if (!currentSession.value) {
    await createSession(currentDirectory.value || '.')
  }
  await sendMessage(content)
}

function handleNewSession() {
  createSession(currentDirectory.value || '.')
}

function toggleSidebar() {
  showSidebar.value = !showSidebar.value
}
</script>

<template>
  <div class="app">
    <Header
      :session="currentSession"
      :directory="currentDirectory"
      :isStreaming="isStreaming"
      @toggle-sidebar="toggleSidebar"
      @new-session="handleNewSession"
      @abort="abortCurrentSession"
    />

    <main class="main-content">
      <aside v-show="showSidebar" class="sidebar">
        <div class="sidebar-header">
          <span>文件</span>
        </div>
        <FileTree
          :files="files"
          :isLoading="filesLoading"
          @toggle="toggleDirectory"
        />
      </aside>

      <section class="chat-section">
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
      </section>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.sidebar {
  width: 260px;
  min-width: 200px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 12px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border-color);
}

.chat-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
