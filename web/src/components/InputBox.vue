<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { Send, Square, Paperclip, X, FileText, ClipboardList, Plus, ChevronDown, Check, Server, Zap, Minimize2, ListTodo } from 'lucide-vue-next'
import { useFileUpload } from '../composables/useFileUpload'
import type { Provider, Message } from '../api/client'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
  centered?: boolean
  providers?: Provider[]
  currentProvider?: string
  currentModel?: string
  mode?: 'chat' | 'agent'
  messages?: Message[]
}>()

const emit = defineEmits<{
  send: [content: string, files: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode: boolean]
  abort: []
  'select-model': [providerId: string, modelId: string]
  'open-mcp': []
  'toggle-mcp-panel': []
  'open-skills': []
  'compress-session': []
  'toggle-todo': []
  'toggle-plan': []
}>()

// Plan Mode 状态
const isPlanMode = ref(false)

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const isDragging = ref(false)

// "+" Menu state
const showPlusMenu = ref(false)
const plusMenuRef = ref<HTMLElement>()

// Model selector state
const showModelDropdown = ref(false)
const modelDropdownRef = ref<HTMLElement>()

const { attachments, addFiles, removeFile, clearAll, toMessageParts } = useFileUpload()

// Can send if has text or has ready attachments
const canSend = computed(() => {
  const hasText = input.value.trim().length > 0
  const hasFiles = attachments.value.some(a => a.status === 'ready')
  return (hasText || hasFiles) && !props.disabled
})

function getCurrentModelName(): string {
  if (props.currentProvider && props.providers) {
    const provider = props.providers.find(p => p.id === props.currentProvider)
    if (provider) {
      const model = provider.models.find(m => m.id === props.currentModel)
      if (model) return model.name || model.id
    }
  }
  if (props.providers) {
    for (const provider of props.providers) {
      const model = provider.models.find(m => m.id === props.currentModel)
      if (model) return model.name || model.id
    }
  }
  return props.currentModel || '选择模型'
}

// Detect model used in current session (from messages)
const sessionModel = computed(() => {
  if (!props.messages?.length) return null
  // Check last assistant message for model info
  const lastAssistant = [...props.messages].reverse().find(m => m.info.role === 'assistant')
  if (lastAssistant?.info.providerID && lastAssistant?.info.modelID) {
    return { providerID: lastAssistant.info.providerID, modelID: lastAssistant.info.modelID }
  }
  // Fallback: check user messages
  const lastUser = [...props.messages].reverse().find(m => m.info.role === 'user' && m.info.model)
  if (lastUser?.info.model) return lastUser.info.model
  return null
})

const isReadonlyModel = computed(() => !!sessionModel.value)

function getModelNameById(providerId: string, modelId: string): string {
  if (props.providers) {
    const provider = props.providers.find(p => p.id === providerId)
    if (provider) {
      const model = provider.models.find(m => m.id === modelId)
      if (model) return model.name || model.id
    }
  }
  return modelId || '未知模型'
}

function selectModel(providerId: string, modelId: string) {
  emit('select-model', providerId, modelId)
  showModelDropdown.value = false
}

function handleSend() {
  if (!canSend.value) return

  const content = input.value.trim()
  const fileParts = toMessageParts()

  emit('send', content, fileParts, isPlanMode.value)
  input.value = ''
  clearAll()
  isPlanMode.value = false

  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

function togglePlanMode() {
  isPlanMode.value = !isPlanMode.value
  showPlusMenu.value = false
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
  showPlusMenu.value = false
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files) {
    addFiles(target.files)
    target.value = ''
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

// Click outside handlers
function handleClickOutside(e: MouseEvent) {
  if (plusMenuRef.value && !plusMenuRef.value.contains(e.target as Node)) {
    showPlusMenu.value = false
  }
  if (modelDropdownRef.value && !modelDropdownRef.value.contains(e.target as Node)) {
    showModelDropdown.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

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
    :class="{ centered }"
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
          <img v-if="file.preview" :src="file.preview" :alt="file.filename" class="attachment-thumb" />
          <div v-else class="attachment-icon">
            <FileText :size="16" />
          </div>
          <div class="attachment-info">
            <span class="attachment-name">{{ file.filename }}</span>
            <span class="attachment-size">{{ formatSize(file.size) }}</span>
          </div>
          <span v-if="file.status === 'processing'" class="attachment-status processing">...</span>
          <span v-else-if="file.status === 'error'" class="attachment-status error">!</span>
          <button @click.stop="removeFile(file.id)" class="attachment-remove" title="Remove">
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

    <!-- Input Box (Claude.ai style with 3-layer shadow) -->
    <div class="input-glass-wrapper" :class="{ 'plan-mode-active': isPlanMode }">
      <!-- Hidden file input -->
      <input
        ref="fileInputRef"
        type="file"
        multiple
        accept="image/*,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.txt,.md,.csv,.json,.xml"
        style="display: none"
        @change="handleFileChange"
      />

      <!-- Textarea area -->
      <div class="input-textarea-area">
        <textarea
          ref="textareaRef"
          v-model="input"
          :disabled="disabled && !isStreaming"
          :placeholder="isStreaming ? '按 Enter 停止响应...' : 'How can I help you today?'"
          rows="1"
          @keydown="handleKeydown"
          @paste="handlePaste"
          class="custom-textarea"
        ></textarea>
      </div>

      <!-- Toolbar (bottom of input box) -->
      <div class="input-toolbar">
        <!-- Left: "+" Menu + Plan + Todo buttons -->
        <div class="toolbar-left">
          <div class="plus-menu-container" ref="plusMenuRef">
            <button
              class="toolbar-btn plus-btn"
              @click.stop="showPlusMenu = !showPlusMenu"
              :disabled="disabled && !isStreaming"
              title="Add files, connectors, and more"
            >
              <Plus :size="18" />
            </button>
            <!-- Plus Menu Dropdown -->
            <div v-if="showPlusMenu" class="plus-dropdown">
              <button class="plus-menu-item" @click="handleFileSelect">
                <Paperclip :size="16" />
                <span>Add files or photos</span>
              </button>
              <div class="plus-menu-divider"></div>
              <button class="plus-menu-item" @click="showPlusMenu = false; emit('toggle-mcp-panel')">
                <Server :size="16" />
                <span>MCP Servers</span>
              </button>
              <button class="plus-menu-item" @click="showPlusMenu = false; emit('open-skills')">
                <Zap :size="16" />
                <span>Skills</span>
              </button>
              <div class="plus-menu-divider"></div>
              <button class="plus-menu-item" @click="showPlusMenu = false; emit('compress-session')">
                <Minimize2 :size="16" />
                <span>Compress session</span>
              </button>
              <template v-if="mode === 'agent'">
                <div class="plus-menu-divider"></div>
                <button class="plus-menu-item" :class="{ active: isPlanMode }" @click="togglePlanMode">
                  <ClipboardList :size="16" />
                  <span>Plan mode</span>
                  <span v-if="isPlanMode" class="plus-menu-check">
                    <Check :size="14" />
                  </span>
                </button>
              </template>
            </div>
          </div>

          <!-- Plan Button -->
          <button
            class="toolbar-btn icon-btn"
            @click="emit('toggle-plan')"
            title="View plan"
          >
            <ClipboardList :size="18" />
          </button>

          <!-- Todo Button -->
          <button
            class="toolbar-btn icon-btn"
            @click="emit('toggle-todo')"
            title="Todo list"
          >
            <ListTodo :size="18" />
          </button>
        </div>

        <!-- Right: Model selector + Send -->
        <div class="toolbar-right">
          <!-- Model Display: readonly for sessions with messages -->
          <div class="model-selector-inline" v-if="isReadonlyModel && sessionModel">
            <span class="model-display-readonly">
              {{ getModelNameById(sessionModel.providerID, sessionModel.modelID) }}
            </span>
          </div>
          <!-- Model Selector: interactive for new sessions -->
          <div class="model-selector-inline" ref="modelDropdownRef" v-else-if="providers && providers.length > 0">
            <button
              class="model-trigger-inline"
              @click.stop="showModelDropdown = !showModelDropdown"
            >
              <span class="model-name-inline">{{ getCurrentModelName() }}</span>
              <ChevronDown :size="12" class="model-chevron" :class="{ open: showModelDropdown }" />
            </button>
            <!-- Model Dropdown -->
            <div v-if="showModelDropdown" class="model-dropdown">
              <template v-for="provider in providers.filter(p => p.authenticated)" :key="provider.id">
                <div class="model-dropdown-label">{{ provider.name }}</div>
                <button
                  v-for="model in provider.models"
                  :key="model.id"
                  class="model-dropdown-item"
                  :class="{ active: currentProvider === provider.id && currentModel === model.id }"
                  @click="selectModel(provider.id, model.id)"
                >
                  <span>{{ model.name || model.id }}</span>
                  <Check v-if="currentProvider === provider.id && currentModel === model.id" :size="14" class="check-icon" />
                </button>
              </template>
            </div>
          </div>

          <!-- Send/Abort Button -->
          <button
            class="toolbar-btn"
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
  max-width: var(--input-max-width);
  margin: 0 auto;
  position: relative;
  padding: 0;
}

.input-container.centered {
  max-width: var(--input-max-width);
}

/* Drag overlay */
.drag-overlay {
  position: absolute;
  inset: 0;
  background: var(--accent-subtle);
  border: 2px dashed var(--accent);
  border-radius: var(--radius-2xl);
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
  background: var(--bg-primary);
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

/* === Claude.ai Input Box === */
.input-glass-wrapper {
  position: relative;
  border-radius: var(--radius-2xl);
  background: var(--bg-composer);
  border: 1px solid var(--input-border-color);
  box-shadow: var(--input-shadow);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  display: flex;
  flex-direction: column;
}

.input-glass-wrapper:hover {
  border-color: var(--input-border-color-hover);
}

.input-glass-wrapper:focus-within {
  border-color: var(--input-border-color-hover);
  box-shadow: var(--input-shadow), 0 0 0 1px var(--input-border-color-hover);
}

.input-glass-wrapper.plan-mode-active {
  border-color: var(--accent);
  box-shadow: var(--input-shadow), 0 0 0 1px var(--accent);
}

/* Textarea area */
.input-textarea-area {
  padding: 14px 16px 0;
}

.custom-textarea {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: var(--text-primary);
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 400;
  line-height: 1.5;
  max-height: 200px;
  min-height: 28px;
  padding: 0;
}

.custom-textarea::placeholder {
  color: var(--text-muted);
}

/* === Toolbar (bottom of input box) === */
.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-btn {
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

/* Plus (+) button - Claude.ai attachment style */
.plus-btn {
  background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-default);
}

.plus-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.plus-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.plus-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Icon buttons (Plan, Todo) */
.icon-btn {
  background: transparent;
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Plus Menu Dropdown */
.plus-menu-container {
  position: relative;
}

.plus-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 220px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 100;
  overflow: hidden;
  animation: dropdownIn 0.15s var(--ease-smooth);
}

@keyframes dropdownIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.plus-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 14px;
  cursor: pointer;
  transition: background var(--transition-fast);
  text-align: left;
}

.plus-menu-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.plus-menu-item.active {
  color: var(--accent);
}

.plus-menu-check {
  margin-left: auto;
  color: var(--accent);
}

.plus-menu-divider {
  height: 0.5px;
  background: var(--border-subtle);
  margin: 4px 0;
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

/* === Inline Model Selector === */
.model-selector-inline {
  position: relative;
}

.model-trigger-inline {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.model-trigger-inline:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.model-name-inline {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chevron {
  opacity: 0.5;
  transition: transform var(--transition-fast);
}

.model-chevron.open {
  transform: rotate(180deg);
}

/* Model Dropdown */
.model-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 100;
  padding: 6px;
  max-height: 400px;
  overflow-y: auto;
  animation: dropdownIn 0.15s var(--ease-smooth);
}

.model-dropdown-label {
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
}

.model-dropdown-label:not(:first-child) {
  margin-top: 4px;
  border-top: 0.5px solid var(--border-subtle);
  padding-top: 8px;
}

.model-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
  text-align: left;
}

.model-dropdown-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.model-dropdown-item.active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.check-icon {
  color: var(--accent);
}

.model-display-readonly {
  padding: 4px 10px;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  opacity: 0.6;
  cursor: default;
  white-space: nowrap;
}

/* Send / Abort buttons - Claude.ai style */
.send-btn {
  background: var(--accent);
  color: white;
  border-radius: var(--radius-lg);
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.send-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.send-btn:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: not-allowed;
}

.abort-btn {
  background: transparent;
  border: 1px solid var(--error);
  color: var(--error);
  border-radius: var(--radius-lg);
}

.abort-btn:hover {
  background: var(--error);
  color: white;
}

.abort-btn:active {
  transform: scale(0.98);
}

/* Footer */
.input-footer {
  text-align: center;
  margin-top: 10px;
}

.input-hint {
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.6;
}
</style>
