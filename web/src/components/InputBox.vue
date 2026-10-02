<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { Send, Square, Paperclip, X, FileText, ClipboardList, Plus, ChevronDown, Check, Server, Zap, Minimize2, ListTodo, ScrollText } from 'lucide-vue-next'
import { getComposerDraft, beginSend, finishSend, restoreAttempt, type ComposerDraft, type SendAttempt } from '../composables/composer-drafts'
import type { Provider } from '../api/client'

const props = defineProps<{
  disabled: boolean
  draftKey?: string
  modelError?: string
  savingModel?: boolean
  isStreaming: boolean
  centered?: boolean
  ensureSession?: () => Promise<string | null>
  providers?: Provider[]
  currentProvider?: string
  currentModel?: string
}>()

const emit = defineEmits<{
  send: [content: string, files: Array<{ type: 'file'; mime: string; filename: string; url: string }>, planMode: boolean, onResult?: (success: boolean) => void, attempt?: SendAttempt]
  abort: []
  'select-model': [providerId: string, modelId: string]
  'open-mcp': []
  'open-model-settings': []
  'toggle-mcp-panel': []
  'open-skills': []
  'compress-session': []
  'toggle-todo': []
  'toggle-plan': []
}>()

// Plan Mode 状态
const draft = computed(() => getComposerDraft(props.draftKey || 'default', async () => await props.ensureSession?.() ?? null))
const isPlanMode = computed({ get: () => draft.value.planMode, set: value => { draft.value.planMode = value } })
const input = computed({ get: () => draft.value.text, set: value => { draft.value.text = value } })
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const isDragging = ref(false)

// "+" Menu state
const showPlusMenu = ref(false)
const plusMenuRef = ref<HTMLElement>()

// Model selector state
const showModelDropdown = ref(false)
const modelDropdownRef = ref<HTMLElement>()

const attachments = computed(() => draft.value.uploads.attachments.value)
const uploadError = computed(() => draft.value.uploads.uploadError.value)
const addFiles = (files: FileList | File[]) => draft.value.uploads.addFiles(files)
const removeFile = (id: string) => draft.value.uploads.removeFile(id)
const clearError = () => draft.value.uploads.clearError()
const isSending = computed(() => draft.value.attempts.some(attempt => attempt.status === 'sending'))

// Can send if there is content and every attachment is ready
const canSend = computed(() => {
  const hasText = input.value.trim().length > 0
  const hasAttachments = attachments.value.length > 0
  const allAttachmentsReady = attachments.value.every(a => a.status === 'ready')
  return (hasText || hasAttachments) && allAttachmentsReady && !props.disabled && !props.isStreaming && !isSending.value
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

function selectModel(providerId: string, modelId: string) {
  emit('select-model', providerId, modelId)
  showModelDropdown.value = false
}

function handleSend() {
  if (!canSend.value) return
  const owner = draft.value
  performSend(owner, beginSend(owner), true)
}

function performSend(owner: ComposerDraft, attempt: SendAttempt, initial = false) {
  if ((!initial && attempt.status === 'sending') || owner.attempts.some(item => item !== attempt && item.status === 'sending')) return
  attempt.status = 'sending'
  const generation = ++attempt.generation
  const complete = (success: boolean) => finishSend(owner, attempt, success, generation)
  attempt.onCancel = () => complete(false)
  const files = attempt.attachments.filter(file => file.url).map(file => ({ type: 'file' as const, mime: file.mime, filename: file.filename, url: file.url! }))
  emit('send', attempt.text, files, attempt.planMode, complete, attempt)
}

function togglePlanMode() {
  isPlanMode.value = !isPlanMode.value
  showPlusMenu.value = false
}

/* 起手任务只填进输入框、不直接发送：用户通常还要补一句具体要求 */
function fillDraft(text: string) {
  input.value = text
  void nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

defineExpose({ fillDraft })

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    if (!props.isStreaming) handleSend()
  }
}

function adjustHeight() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  // 空输入不量 scrollHeight：挂载瞬间布局很窄时占位文字会折成很多行，
  // 框被撑到 200px 后，直到下次输入都回不来
  if (!el.value) return
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

// 宽度变化（折叠侧栏、打开右侧面板、窗口缩放）会改变折行，需要重新量高
let textareaResizeObserver: ResizeObserver | undefined
let lastTextareaWidth = 0
watch(textareaRef, (el) => {
  textareaResizeObserver?.disconnect()
  if (!el || typeof ResizeObserver === 'undefined') return
  textareaResizeObserver = new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width)
    if (width === lastTextareaWidth) return
    lastTextareaWidth = width
    adjustHeight()
  })
  textareaResizeObserver.observe(el)
}, { flush: 'post' })

watch(input, () => nextTick(adjustHeight), { flush: 'post' })
watch(() => props.draftKey, () => {
  showPlusMenu.value = false
  showModelDropdown.value = false
  void nextTick(adjustHeight)
})

// File upload handlers
function handleFileSelect() {
  showPlusMenu.value = false
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files) {
    clearError()
    void addFiles(target.files)
    target.value = ''
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  if (e.dataTransfer?.files) {
    clearError()
    void addFiles(e.dataTransfer.files)
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
    clearError()
    void addFiles(imageFiles)
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
  textareaResizeObserver?.disconnect()
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
    <div v-for="attempt in draft.attempts" :key="attempt.id" class="send-attempt" :class="attempt.status" role="status">
      <div class="attempt-text">{{ attempt.text || attempt.attachments.map(file => file.filename).join('、') }}</div>
      <div class="attempt-actions">
        <span>{{ attempt.status === 'sending' ? '正在发送…' : (attempt.submitted ? '发送结果待确认，重试不会重复执行' : '发送未完成，内容已保留') }}</span>
        <template v-if="attempt.status === 'failed'">
          <button class="btn btn-sm btn-ghost" :disabled="disabled || (isStreaming && !attempt.submitted) || isSending" @click="performSend(draft, attempt)">重试</button>
          <button v-if="!attempt.submitted && !input && !attachments.length" class="btn btn-sm btn-ghost" @click="restoreAttempt(draft, attempt)">编辑</button>
        </template>
      </div>
    </div>
    <!-- Drag overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-content">
        <Paperclip :size="32" />
        <span>将文件拖放到此处</span>
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
          <span v-if="file.status === 'selected'" class="attachment-status processing">队列中</span>
          <span v-else-if="file.status === 'uploading'" class="attachment-status processing">{{ file.progress }}%</span>
          <span v-else-if="file.status === 'error'" class="attachment-status error">上传失败</span>
          <button @click.stop="removeFile(file.id)" class="attachment-remove" title="移除">
            <X :size="14" />
          </button>
        </div>
      </div>
    </div>

    <div v-if="uploadError" class="upload-error">
      {{ uploadError }}
    </div>
    <div v-if="modelError" class="upload-error" role="alert">{{ modelError }}</div>

    <!-- Plan Mode 指示器 -->
    <div v-if="isPlanMode" class="plan-mode-indicator">
      <ClipboardList :size="14" />
      <span>已请求先列计划。当前为提示词引导，并非只读执行模式</span>
      <button class="plan-mode-close" @click="isPlanMode = false" title="关闭规划模式">
        <X :size="14" />
      </button>
    </div>

    <!-- Input Box -->
    <div class="input-glass-wrapper">
      <!-- Hidden file input -->
      <input
        ref="fileInputRef"
        type="file"
        multiple
        style="display: none"
        @change="handleFileChange"
      />

      <!-- Textarea area -->
      <div class="input-textarea-area">
        <textarea
          ref="textareaRef"
          v-model="input"
          :disabled="disabled && !isStreaming"
          :placeholder="isStreaming ? '可以继续输入，回复结束后发送…' : '描述要做的事，可以拖入文件或粘贴图片'"
          rows="1"
          aria-label="消息内容"
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
              title="添加文件和更多功能"
              aria-label="添加文件和更多功能"
              :aria-expanded="showPlusMenu"
            >
              <Plus :size="18" />
            </button>
            <!-- Plus Menu Dropdown -->
            <div v-if="showPlusMenu" class="plus-dropdown">
              <button class="plus-menu-item" @click="handleFileSelect">
                <Paperclip :size="16" />
                <span>添加文件或图片</span>
              </button>
              <div class="plus-menu-divider"></div>
              <button class="plus-menu-item" @click="showPlusMenu = false; emit('toggle-mcp-panel')">
                <Server :size="16" />
                <span>MCP 服务器</span>
              </button>
              <button class="plus-menu-item" @click="showPlusMenu = false; emit('open-skills')">
                <Zap :size="16" />
                <span>技能</span>
              </button>
              <div class="plus-menu-divider"></div>
              <button class="plus-menu-item" @click="showPlusMenu = false; emit('compress-session')">
                <Minimize2 :size="16" />
                <span>压缩会话</span>
              </button>
            </div>
          </div>

          <!-- 规划开关：原来藏在 + 菜单里，打开后只能靠输入框变色猜状态 -->
          <button
            type="button"
            class="plan-toggle"
            :class="{ active: isPlanMode }"
            :aria-pressed="isPlanMode"
            :disabled="disabled && !isStreaming"
            title="请求先列计划（提示词引导，不是只读执行模式）"
            @click="togglePlanMode"
          >
            <ClipboardList :size="15" />
            <span>先规划</span>
          </button>

          <span class="toolbar-divider" aria-hidden="true"></span>

          <button
            class="toolbar-btn icon-btn"
            @click="emit('toggle-plan')"
            title="查看计划"
            aria-label="查看计划"
          >
            <ScrollText :size="17" />
          </button>

          <button
            class="toolbar-btn icon-btn"
            @click="emit('toggle-todo')"
            title="待办列表"
            aria-label="待办列表"
          >
            <ListTodo :size="17" />
          </button>
        </div>

        <!-- Right: Model selector + Send -->
        <div class="toolbar-right">
          <!-- Model Selector -->
          <div class="model-selector-inline" ref="modelDropdownRef" v-if="providers?.some(provider => provider.authenticated)">
            <button
              class="model-trigger-inline"
              @click.stop="showModelDropdown = !showModelDropdown"
            >
              <span class="model-name-inline">{{ savingModel ? '保存模型中…' : getCurrentModelName() }}</span>
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
          <!-- 无可用 provider 时保留一个禁用入口，避免模型选择能力静默消失 -->
          <div v-else class="model-selector-inline">
            <button
              class="model-trigger-inline"
              @click="emit('open-model-settings')"
              title="连接模型供应商"
            >
              <span class="model-name-inline">连接模型</span>
            </button>
          </div>

          <!-- Send/Abort Button -->
          <button
            class="toolbar-btn"
            :class="isStreaming ? 'abort-btn' : 'send-btn'"
            :disabled="(!canSend && !isStreaming) || (disabled && !isStreaming)"
            @click="isStreaming ? emit('abort') : handleSend()"
            :title="isStreaming ? '停止' : '发送'"
            :aria-label="isStreaming ? '停止生成' : '发送'"
          >
            <Square v-if="isStreaming" :size="16" fill="currentColor" />
            <Send v-else :size="18" />
          </button>
        </div>
      </div>
    </div>

    <div class="input-footer">
      <div class="input-hint">
        <kbd>Enter</kbd> 发送，<kbd>Shift</kbd> + <kbd>Enter</kbd> 换行。改动文件前请核对结果。
      </div>
    </div>
  </div>
</template>

<style scoped>
.send-attempt { border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: 12px 16px; margin-bottom: 10px; background: var(--bg-elevated); }
.send-attempt.failed { border-color: var(--error); }
.attempt-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto; font-size: var(--text-13); }
.attempt-actions { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--text-sm); margin-top: 8px; }

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
  z-index: var(--z-sticky);
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

.upload-error {
  margin-bottom: 8px;
  padding: 8px 12px;
  border: 1px solid var(--error);
  border-radius: var(--radius-md);
  background: var(--error-subtle);
  color: var(--error);
  font-size: var(--text-sm);
  line-height: 1.5;
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
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
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
  font-size: var(--text-xs);
}

.attachment-status {
  font-size: var(--text-base);
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

/* === Input Box === */
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
  border-color: rgba(var(--accent-rgb), 0.45);
  box-shadow: var(--input-shadow), 0 0 0 3px var(--accent-subtle);
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
  font-family: var(--font-sans);
  font-size: var(--text-md);
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

/* Plus (+) button - Attachment style */
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

.icon-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-dropdown);
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
  padding: 7px 10px;
  width: 100%;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--text-13);
  cursor: pointer;
  transition: background var(--transition-fast);
  text-align: left;
}

.plus-menu-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.plus-menu-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

/* 规划开关 */
.plan-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  margin-left: 2px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: var(--text-13);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.plan-toggle:hover:not(:disabled) {
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.plan-toggle.active,
.plan-toggle.active:hover:not(:disabled) {
  background: var(--accent-subtle);
  border-color: rgba(var(--accent-rgb), 0.35);
  color: var(--accent);
}

.plan-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toolbar-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border-default);
}

/* Plan Mode Indicator */
.plan-mode-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  margin-bottom: 8px;
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
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
  font-size: var(--text-13);
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

.model-trigger-disabled,
.model-trigger-disabled:hover {
  background: transparent;
  color: var(--text-muted);
  opacity: 0.6;
  cursor: not-allowed;
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
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-dropdown);
  padding: 6px;
  max-height: 400px;
  overflow-y: auto;
  animation: dropdownIn 0.15s var(--ease-smooth);
}

.model-dropdown-label {
  padding: 8px 12px 4px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
}

.model-dropdown-label:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid var(--border-subtle);
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
  font-size: var(--text-13);
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
  background: var(--hover-overlay);
  color: var(--text-primary);
  font-weight: 500;
}

.check-icon {
  color: var(--accent);
}

/* Send / Abort buttons */
.send-btn {
  background: var(--accent);
  color: var(--accent-fg);
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
  color: var(--solid-fg);
}

.abort-btn:active {
  transform: scale(0.98);
}

/* Footer */
.input-footer {
  margin-top: 8px;
  padding: 0 4px;
}

.input-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.input-hint kbd {
  display: inline-block;
  min-width: 18px;
  padding: 0 4px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  background: var(--bg-elevated);
  font-family: var(--font-sans);
  font-size: 0.95em;
  line-height: 16px;
  text-align: center;
}

@media (max-width: 640px) {
  .input-footer { display: none; }
  .plan-toggle span { display: none; }
  .plan-toggle { width: 32px; padding: 0; justify-content: center; }
}
</style>
