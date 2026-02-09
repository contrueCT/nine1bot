<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { Send, Square, Paperclip, X, FileText, ClipboardList } from 'lucide-vue-next'
import { useFileUpload } from '../composables/useFileUpload'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string, files: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode: boolean]
  abort: []
}>()

// Plan Mode 状态
const isPlanMode = ref(false)

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const isDragging = ref(false)

const { attachments, addFiles, removeFile, clearAll, toMessageParts } = useFileUpload()

// Can send if has text or has ready attachments
const canSend = computed(() => {
  const hasText = input.value.trim().length > 0
  const hasFiles = attachments.value.some(a => a.status === 'ready')
  return (hasText || hasFiles) && !props.disabled
})

function handleSend() {
  if (!canSend.value) return

  const content = input.value.trim()
  const fileParts = toMessageParts()

  emit('send', content, fileParts, isPlanMode.value)
  input.value = ''
  clearAll()
  // 发送后关闭规划模式
  isPlanMode.value = false

  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

function togglePlanMode() {
  isPlanMode.value = !isPlanMode.value
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

// File upload handlers
function handleFileSelect() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files) {
    addFiles(target.files)
    target.value = ''  // Reset for same file selection
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  if (e.dataTransfer?.files) {
    addFiles(e.dataTransfer.files)
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}

function handleDragLeave(e: DragEvent) {
  // Only set to false if leaving the container entirely
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX
  const y = e.clientY
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    isDragging.value = false
  }
}

// Paste handler for images
function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return

  const imageFiles: File[] = []
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        imageFiles.push(file)
      }
    }
  }

  if (imageFiles.length > 0) {
    e.preventDefault()
    addFiles(imageFiles)
  }
}

// Format file size
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
</script>

<template>
  <div
    class="input-container"
    @drop="handleDrop"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
  >
    <!-- Drag overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-content">
        <Paperclip :size="32" />
        <span>Drop files here</span>
      </div>
    </div>

    <!-- File attachments preview -->
    <div v-if="attachments.length > 0" class="attachments-container">
      <div class="attachments-list">
        <div
          v-for="file in attachments"
          :key="file.id"
          class="attachment-chip"
          :class="{ 'error': file.status === 'error' }"
        >
          <!-- Image thumbnail or document icon -->
          <img
            v-if="file.preview"
            :src="file.preview"
            :alt="file.filename"
            class="attachment-thumb"
          />
          <div v-else class="attachment-icon">
            <FileText :size="16" />
          </div>

          <div class="attachment-info">
            <span class="attachment-name">{{ file.filename }}</span>
            <span class="attachment-size">{{ formatSize(file.size) }}</span>
          </div>

          <!-- Status indicator -->
          <span v-if="file.status === 'processing'" class="attachment-status processing">
            ...
          </span>
          <span v-else-if="file.status === 'error'" class="attachment-status error">
            !
          </span>

          <!-- Remove button -->
          <button
            @click.stop="removeFile(file.id)"
            class="attachment-remove"
            title="Remove"
          >
            <X :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- Plan Mode 指示器 -->
    <div v-if="isPlanMode" class="plan-mode-indicator">
      <ClipboardList :size="14" />
      <span>规划模式已启用 - AI 将先制定计划再执行</span>
      <button class="plan-mode-close" @click="isPlanMode = false" title="关闭规划模式">
        <X :size="14" />
      </button>
    </div>

    <div class="input-glass-wrapper" :class="{ 'plan-mode-active': isPlanMode }">
      <div class="input-box glass-input">
        <!-- Hidden file input -->
        <input
          ref="fileInputRef"
          type="file"
          multiple
          accept="image/*,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.txt,.md,.csv,.json,.xml"
          style="display: none"
          @change="handleFileChange"
        />

        <!-- Plan Mode 切换按钮 -->
        <button
          class="action-btn plan-btn"
          :class="{ active: isPlanMode }"
          @click="togglePlanMode"
          :disabled="disabled && !isStreaming"
          title="切换规划模式 - 让 AI 先制定计划再执行"
        >
          <ClipboardList :size="18" />
        </button>

        <!-- File upload button -->
        <button
          class="action-btn attach-btn"
          @click="handleFileSelect"
          :disabled="disabled && !isStreaming"
          title="Attach file (images, PDF, Word, PPT, Excel, etc.)"
        >
          <Paperclip :size="18" />
        </button>

        <textarea
          ref="textareaRef"
          v-model="input"
          :disabled="disabled && !isStreaming"
          :placeholder="isStreaming ? '按 Enter 停止响应...' : 'Message Nine1Bot...'"
          rows="1"
          @keydown="handleKeydown"
          @paste="handlePaste"
          class="custom-textarea"
        ></textarea>
        <div class="input-actions">
          <button
            class="action-btn"
            :class="isStreaming ? 'abort-btn' : 'send-btn'"
            :disabled="(!canSend && !isStreaming) || (disabled && !isStreaming)"
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
  max-width: 800px;
  margin: 0 auto;
  position: relative;
  padding: 0 var(--space-md);
}

/* Drag overlay */
.drag-overlay {
  position: absolute;
  inset: 0;
  background: var(--accent-subtle);
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
}

.drag-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  font-weight: 500;
}

/* Attachments */
.attachments-container {
  margin-bottom: 8px;
}

.attachments-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachment-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: 12px;
  max-width: 200px;
}

.attachment-chip.error {
  border-color: var(--error);
  background: var(--error-subtle);
}

.attachment-thumb {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: var(--radius-sm);
}

.attachment-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.attachment-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.attachment-size {
  color: var(--text-muted);
  font-size: 10px;
}

.attachment-status {
  font-size: 14px;
  font-weight: bold;
}

.attachment-status.processing {
  color: var(--text-muted);
}

.attachment-status.error {
  color: var(--error);
}

.attachment-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all var(--transition-fast);
}

.attachment-remove:hover {
  background: var(--bg-tertiary);
  color: var(--error);
}

.input-glass-wrapper {
  position: relative;
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  transition: border-color var(--transition-fast);
  border: 0.5px solid var(--border-default);
}

.input-glass-wrapper:focus-within {
  border-color: var(--accent);
}

.glass-input {
  display: flex;
  align-items: flex-end;
  padding: 10px 14px;
  gap: 10px;
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
  font-weight: var(--font-weight-normal);
  line-height: 1.5;
  max-height: 200px;
  min-height: 32px;
  padding: 4px 0;
}

.custom-textarea::placeholder {
  color: var(--text-muted);
}

.input-actions {
  display: flex;
  gap: 8px;
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
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.attach-btn {
  background: transparent;
  color: var(--text-muted);
}

.attach-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.attach-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Plan Mode Button */
.plan-btn {
  background: transparent;
  color: var(--text-muted);
}

.plan-btn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-subtle);
}

.plan-btn.active {
  color: var(--accent);
  background: var(--accent-subtle);
}

.plan-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Plan Mode Indicator */
.plan-mode-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  margin-bottom: 8px;
  background: var(--accent-subtle);
  border: 0.5px solid var(--accent);
  border-radius: var(--radius-md);
  font-size: 12px;
  color: var(--accent);
}

.plan-mode-indicator span {
  flex: 1;
}

.plan-mode-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  border-radius: 4px;
  transition: all var(--transition-fast);
}

.plan-mode-close:hover {
  background: var(--accent-glow);
}

/* Plan Mode Active State */
.input-glass-wrapper.plan-mode-active {
  border-color: var(--accent);
}

.send-btn {
  background: var(--accent);
  color: white;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.send-btn:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: not-allowed;
}

.abort-btn {
  background: transparent;
  border: 0.5px solid var(--error);
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
  color: var(--text-muted);
  opacity: 0.7;
}
</style>
