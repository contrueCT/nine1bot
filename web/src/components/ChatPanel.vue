<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { Message } from '../api/client'
import MessageItem from './MessageItem.vue'

const props = defineProps<{
  messages: Message[]
  isLoading: boolean
  isStreaming: boolean
}>()

const scrollContainer = ref<HTMLDivElement>()

// 自动滚动到底部
watch(() => props.messages, async () => {
  await nextTick()
  if (scrollContainer.value) {
    scrollContainer.value.scrollTo({
      top: scrollContainer.value.scrollHeight,
      behavior: 'smooth'
    })
  }
}, { deep: true })

// 流式消息更新时也滚动
watch(() => props.isStreaming, async (streaming) => {
  if (streaming) {
    await nextTick()
    if (scrollContainer.value) {
      scrollContainer.value.scrollTo({
        top: scrollContainer.value.scrollHeight,
        behavior: 'smooth'
      })
    }
  }
})
</script>

<template>
  <div class="chat-panel" ref="scrollContainer">
    <div v-if="messages.length === 0 && !isLoading" class="empty-state">
      <div class="empty-icon">💬</div>
      <div class="empty-text">开始一个新对话</div>
      <div class="empty-hint">输入消息与 Nine1Bot 交互</div>
    </div>

    <div v-else class="messages">
      <MessageItem
        v-for="message in messages"
        :key="message.id"
        :message="message"
      />

      <div v-if="isStreaming" class="streaming-placeholder">
        <div class="typing-indicator">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.empty-hint {
  font-size: 14px;
  color: var(--text-muted);
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.streaming-placeholder {
  display: flex;
  align-items: center;
  padding: 12px 16px;
}

.typing-indicator {
  display: flex;
  gap: 4px;
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: bounce 1.4s infinite ease-in-out both;
}

.typing-indicator span:nth-child(1) {
  animation-delay: -0.32s;
}

.typing-indicator span:nth-child(2) {
  animation-delay: -0.16s;
}

@keyframes bounce {
  0%, 80%, 100% {
    transform: scale(0);
  }
  40% {
    transform: scale(1);
  }
}
</style>
