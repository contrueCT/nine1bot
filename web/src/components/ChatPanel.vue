<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { MessagesSquare } from 'lucide-vue-next'
import type { Message } from '../api/client'
import MessageItem from './MessageItem.vue'

const props = defineProps<{
  messages: Message[]
  isLoading: boolean
  isStreaming: boolean
}>()

const scrollContainer = ref<HTMLDivElement>()

watch(() => props.messages, async () => {
  await nextTick()
  scrollToBottom()
}, { deep: true })

watch(() => props.isStreaming, async (streaming) => {
  if (streaming) {
    await nextTick()
    scrollToBottom()
  }
})

function scrollToBottom() {
  if (scrollContainer.value) {
    // Check if user is already near bottom to avoid annoying auto-scroll if they are reading history
    const isNearBottom = scrollContainer.value.scrollHeight - scrollContainer.value.scrollTop - scrollContainer.value.clientHeight < 100
    
    if (isNearBottom || props.messages.length <= 1) { 
       // Always scroll on simple cases
       scrollContainer.value.scrollTo({
        top: scrollContainer.value.scrollHeight,
        behavior: 'smooth'
      })
    }
  }
}
</script>

<template>
  <div class="chat-messages custom-scrollbar" ref="scrollContainer">
    <!-- Empty State -->
    <div v-if="messages.length === 0 && !isLoading" class="chat-empty">
      <div class="empty-state-icon glass-icon">
        <MessagesSquare :size="48" stroke-width="1.5" />
      </div>
      <p class="empty-state-title">Hello, I'm Nine1Bot</p>
      <p class="empty-state-description">How can I help you today?</p>
    </div>

    <!-- Messages -->
    <div class="messages-container" v-else>
      <MessageItem
        v-for="message in messages"
        :key="message.info.id"
        :message="message"
      />

      <!-- Streaming Indicator is handled inside the last Agent message usually, or as a typing bubble -->
      <!-- Added extra space at bottom for scrolling past the input box -->
      <div class="bottom-spacer"></div>
    </div>
  </div>
</template>

<style scoped>
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  scroll-behavior: smooth;
}

.messages-container {
  padding: 24px 0;
  display: flex;
  flex-direction: column;
}

.chat-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  animation: fade-in 0.8s ease;
}

.glass-icon {
  width: 96px;
  height: 96px;
  background: var(--bg-tertiary);
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  color: var(--accent);
  box-shadow: var(--shadow-glow);
}

.empty-state-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--text-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.empty-state-description {
  color: var(--text-secondary);
  font-size: 16px;
}

.bottom-spacer {
  height: 48px;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>

