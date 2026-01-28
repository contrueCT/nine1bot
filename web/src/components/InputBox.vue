<script setup lang="ts">
import { ref, watch } from 'vue'
import { Send, Square } from 'lucide-vue-next'

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

function adjustHeight() {
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px'
  }
}

watch(input, adjustHeight)
</script>

<template>
  <div class="input-container">
    <div class="input-glass-wrapper">
      <div class="input-box glass-input">
        <textarea
          ref="textareaRef"
          v-model="input"
          :disabled="disabled && !isStreaming"
          :placeholder="isStreaming ? '按 Enter 停止响应...' : 'Message Nine1Bot...'"
          rows="1"
          @keydown="handleKeydown"
          class="custom-textarea"
        ></textarea>
        <div class="input-actions">
          <button
            class="action-btn"
            :class="isStreaming ? 'abort-btn' : 'send-btn'"
            :disabled="(!input.trim() && !isStreaming) || (disabled && !isStreaming)"
            @click="isStreaming ? emit('abort') : handleSend()"
            :title="isStreaming ? '停止' : '发送'"
          >
            <Square v-if="isStreaming" :size="16" fill="currentColor" />
            <Send v-else :size="18" />
          </button>
        </div>
      </div>
    </div>
    <div class="input-footer">
      <div class="input-hint text-xs text-muted">
        Nine1Bot may display inaccurate info, including about people, so double-check its responses.
      </div>
    </div>
  </div>
</template>

<style scoped>
.input-container {
  width: 100%;
  max-width: 800px; /* Limit width for better readability on large screens */
  margin: 0 auto;
  position: relative;
  padding: 0 var(--space-md);
}

.input-glass-wrapper {
  position: relative;
  border-radius: 24px; /* More capsule-like */
  background: var(--bg-tertiary); /* Fallback */
  background: var(--bg-glass-strong);
  box-shadow: var(--shadow-lg);
  transition: all var(--transition-normal);
  border: 1px solid var(--border-default);
}

.input-glass-wrapper:focus-within {
  border-color: var(--accent-glow);
  box-shadow: 0 0 24px -4px var(--accent-subtle); /* Softer glow */
  transform: translateY(-2px);
}

.glass-input {
  display: flex;
  align-items: flex-end;
  padding: 12px 16px;
  gap: 12px;
}

.custom-textarea {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.5;
  max-height: 200px;
  min-height: 32px;
  padding: 4px 0;
}

.custom-textarea::placeholder {
  color: var(--text-muted);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.send-btn {
  background: var(--accent);
  color: white;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: scale(1.05);
}

.send-btn:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: not-allowed;
}

.abort-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--error);
  color: var(--error);
}

.abort-btn:hover {
  background: var(--error);
  color: white;
}

.input-footer {
  text-align: center;
  margin-top: 8px;
}

.input-hint {
  font-size: 11px;
  opacity: 0.6;
}
</style>

