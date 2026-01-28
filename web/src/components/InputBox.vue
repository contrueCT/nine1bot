<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
  abort: []
}>()

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement>()

function handleSend() {
  const content = input.value.trim()
  if (!content || props.disabled) return

  emit('send', content)
  input.value = ''

  // 重置高度
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (props.isStreaming) {
      emit('abort')
    } else {
      handleSend()
    }
  }
}

// 自动调整高度
function adjustHeight() {
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px'
  }
}

watch(input, adjustHeight)
</script>

<template>
  <div class="input-box">
    <div class="input-container">
      <textarea
        ref="textareaRef"
        v-model="input"
        :disabled="disabled && !isStreaming"
        :placeholder="isStreaming ? '按 Enter 停止...' : '输入消息... (Shift+Enter 换行)'"
        rows="1"
        @keydown="handleKeydown"
      ></textarea>
      <button
        class="send-btn"
        :class="{ abort: isStreaming }"
        :disabled="disabled && !isStreaming"
        @click="isStreaming ? emit('abort') : handleSend()"
      >
        <template v-if="isStreaming">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </template>
        <template v-else>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </template>
      </button>
    </div>
    <div class="input-hint">
      <span v-if="isStreaming" class="streaming-hint">Agent 正在响应...</span>
      <span v-else class="shortcut-hint">Enter 发送 · Shift+Enter 换行</span>
    </div>
  </div>
</template>

<style scoped>
.input-box {
  padding: 16px 20px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

.input-container {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 12px;
  transition: border-color 0.15s;
}

.input-container:focus-within {
  border-color: var(--accent-blue);
}

textarea {
  flex: 1;
  background: transparent;
  border: none;
  resize: none;
  font-size: 14px;
  line-height: 1.5;
  max-height: 200px;
  padding: 4px 0;
}

textarea::placeholder {
  color: var(--text-muted);
}

textarea:focus {
  outline: none;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: var(--accent-blue);
  color: white;
  border-radius: 6px;
  flex-shrink: 0;
  transition: all 0.15s;
}

.send-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: scale(1.02);
}

.send-btn:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.send-btn.abort {
  background: var(--accent-red);
}

.input-hint {
  display: flex;
  justify-content: center;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.streaming-hint {
  color: var(--accent-blue);
}
</style>
