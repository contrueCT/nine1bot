<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Bot, User, Brain, ChevronDown, Pencil, Trash2, X, Check } from 'lucide-vue-next'
import type { Message, MessagePart } from '../api/client'
import ToolCall from './ToolCall.vue'

const props = defineProps<{
  message: Message
}>()

const emit = defineEmits<{
  'delete-part': [messageId: string, partId: string]
  'update-part': [messageId: string, partId: string, updates: { text?: string }]
}>()

// 编辑状态
const editingPartId = ref<string | null>(null)
const editText = ref('')
const deleteConfirmPartId = ref<string | null>(null)

function startEdit(part: MessagePart) {
  if (part.type !== 'text' || !part.text) return
  editingPartId.value = part.id
  editText.value = part.text
}

function cancelEdit() {
  editingPartId.value = null
  editText.value = ''
}

function confirmEdit(partId: string) {
  if (editText.value.trim()) {
    emit('update-part', props.message.info.id, partId, { text: editText.value.trim() })
  }
  cancelEdit()
}

function startDelete(part: MessagePart) {
  deleteConfirmPartId.value = part.id
}

function cancelDelete() {
  deleteConfirmPartId.value = null
}

function confirmDelete(partId: string) {
  emit('delete-part', props.message.info.id, partId)
  cancelDelete()
}

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
})

// Get all parts to display
const displayParts = computed(() => {
  const result: Array<{ type: string; part: MessagePart; index: number }> = []
  props.message.parts.forEach((part, index) => {
    if (part.type === 'text' && part.text) {
      result.push({ type: 'text', part, index })
    } else if (part.type === 'tool') {
      result.push({ type: 'tool', part, index })
    } else if (part.type === 'reasoning') {
      result.push({ type: 'reasoning', part, index })
    }
  })
  return result
})

// Thinking block state
const thinkingExpanded = ref(false)

// Format text with marked and sanitize with DOMPurify
function formatText(text: string): string {
  try {
    const html = marked.parse(text) as string
    return DOMPurify.sanitize(html)
  } catch (e) {
    console.error('Markdown parse error:', e)
    return DOMPurify.sanitize(text)
  }
}
</script>

<template>
  <div class="message-row" :class="{ 'user-row': message.info.role === 'user', 'agent-row': message.info.role !== 'user' }">
    <div class="avatar shadow-sm">
      <User v-if="message.info.role === 'user'" :size="18" />
      <Bot v-else :size="18" />
    </div>
    
    <!-- 用户消息的操作按钮（在气泡外部左侧） -->
    <div class="message-actions" v-if="message.info.role === 'user' && !editingPartId">
      <button class="action-btn" @click="startEdit(message.parts.find(p => p.type === 'text')!)" title="编辑">
        <Pencil :size="14" />
      </button>
      <button class="action-btn danger" @click="startDelete(message.parts.find(p => p.type === 'text')!)" title="删除">
        <Trash2 :size="14" />
      </button>
    </div>

    <div class="message-bubble" :class="{ 'user-bubble': message.info.role === 'user', 'agent-bubble glass': message.info.role !== 'user' }">

      <div class="message-sender-name" v-if="message.info.role !== 'user'">
        {{ message.info.model?.modelID || 'Nine1Bot' }}
      </div>

      <div class="message-content">
        <template v-for="item in displayParts" :key="item.part.id || item.index">
          <!-- Thinking/Reasoning -->
          <div v-if="item.type === 'reasoning'" class="thinking-block">
            <div class="thinking-header" @click="thinkingExpanded = !thinkingExpanded">
              <Brain :size="14" class="thinking-icon" />
              <span class="thinking-label">Reasoning Process</span>
              <ChevronDown
                :size="14"
                class="thinking-chevron"
                :class="{ expanded: thinkingExpanded }"
              />
            </div>
            <div v-if="thinkingExpanded || !item.part.text" class="thinking-body">
              <div v-if="item.part.text" class="thinking-text">{{ item.part.text }}</div>
              <div v-else class="loading-wave">
                <span>.</span><span>.</span><span>.</span>
              </div>
            </div>
          </div>

          <!-- Tool Call -->
          <ToolCall
            v-else-if="item.type === 'tool'"
            :tool="item.part"
          />

          <!-- Text Content with Markdown -->
          <div
            v-else-if="item.type === 'text'"
            class="text-part"
            :class="{ 'editing': editingPartId === item.part.id }"
          >
            <!-- 编辑模式 -->
            <div v-if="editingPartId === item.part.id" class="edit-mode">
              <textarea
                v-model="editText"
                class="edit-textarea"
                rows="4"
                @keyup.escape="cancelEdit"
              ></textarea>
              <div class="edit-actions">
                <button class="btn btn-ghost btn-sm" @click="cancelEdit">
                  <X :size="14" /> 取消
                </button>
                <button class="btn btn-primary btn-sm" @click="confirmEdit(item.part.id)" :disabled="!editText.trim()">
                  <Check :size="14" /> 保存
                </button>
              </div>
            </div>
            <!-- 正常显示模式 -->
            <template v-else>
              <div class="markdown-content" v-html="formatText(item.part.text || '')"></div>
            </template>
          </div>
        </template>
      </div>
    </div>

  </div>

  <!-- 删除确认对话框 - 使用 Teleport 移到 body 避免 transform 影响 -->
  <Teleport to="body">
    <div v-if="deleteConfirmPartId" class="dialog-overlay" @click="cancelDelete">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <span>删除消息内容</span>
          <button class="action-btn" @click="cancelDelete">
            <X :size="16" />
          </button>
        </div>
        <div class="dialog-body">
          <p class="dialog-message">确定要删除这部分内容吗？</p>
          <p class="dialog-warning">此操作不可撤销。</p>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-ghost btn-sm" @click="cancelDelete">取消</button>
          <button class="btn btn-danger btn-sm" @click="confirmDelete(deleteConfirmPartId!)">
            <Trash2 :size="14" /> 删除
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.message-row {
  display: flex;
  gap: 16px;
  padding: 16px var(--space-lg);
  width: 100%;
  opacity: 0;
  animation: fade-up 0.4s ease forwards;
}

@keyframes fade-up {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.user-row {
  flex-direction: row-reverse;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.user-row .avatar {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.agent-row .avatar {
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  color: white;
  box-shadow: 0 4px 12px var(--accent-glow);
}

.message-bubble {
  max-width: 80%;
  width: fit-content;
  padding: 10px 14px; /* Reduced padding further */
  border-radius: 16px; /* Slightly reduced radius */
  position: relative;
  box-shadow: var(--shadow-sm);
  line-height: 1.5; /* Tighter line height */
}

.user-bubble {
  background: var(--bg-tertiary);
  border-bottom-right-radius: 2px; /* Sharper tail */
  color: var(--text-primary);
  /* margin-left: auto; Removed unnecessary margin */
}

.agent-bubble {
  background: var(--bg-glass-strong);
  border: 1px solid var(--border-subtle);
  border-top-left-radius: 4px;
}

.message-sender-name {
  font-size: 11px;
  font-weight: 700;
  opacity: 0.5;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Thinking Block */
.thinking-block {
  margin: 8px 0 16px;
  border: 1px solid var(--border-default);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  background: rgba(0,0,0,0.02);
}

.thinking-header:hover {
  background: rgba(0,0,0,0.04);
}

.thinking-label {
  flex: 1;
}

.thinking-chevron {
  transition: transform 0.2s;
}

.thinking-chevron.expanded {
  transform: rotate(180deg);
}

.thinking-body {
  padding: 12px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  font-size: 13px;
  color: var(--text-muted);
  font-style: italic;
  max-height: 300px;
  overflow-y: auto;
}

.thinking-text {
  white-space: pre-wrap;
}

/* Loading Dots */
.loading-wave span {
  animation: wave 1.2s infinite ease-in-out;
  display: inline-block;
  margin: 0 1px;
  font-size: 20px;
  line-height: 10px;
}
.loading-wave span:nth-child(2) { animation-delay: 0.1s; }
.loading-wave span:nth-child(3) { animation-delay: 0.2s; }

@keyframes wave {
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-4px); opacity: 1; }
}

/* Prose / Markdown Styling */
.markdown-content {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-primary);
}

.markdown-content :deep(p) {
  margin-bottom: 1em;
}
.markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3) {
  margin-top: 1.5em;
  margin-bottom: 0.75em;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-primary);
}

.markdown-content :deep(code) {
  background: var(--bg-tertiary);
  padding: 2px 5px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--accent);
}

.markdown-content :deep(pre) {
  background: #1e1e1e; /* Always dark for code blocks usually looks better */
  padding: 16px;
  border-radius: var(--radius-md);
  margin: 1em 0;
  overflow-x: auto;
  border: 1px solid var(--border-default);
}

/* Adjust code block if light mode is strictly required everywhere, 
   but usually high contrast dark code blocks are preferred even in light mode.
   Let's check theme.
*/
:root[data-theme='light'] .markdown-content :deep(pre) {
  background: #fafafa;
  border: 1px solid #e4e4e7;
  color: #27272a;
}
:root[data-theme='light'] .markdown-content :deep(code) {
  color: #7c3aed; /* darker accent */
  background: #f4f4f5;
}

.markdown-content :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 13px;
  border: none;
}

.markdown-content :deep(ul), 
.markdown-content :deep(ol) {
  margin-bottom: 1em;
  padding-left: 1.5em;
}

.markdown-content :deep(li) {
  margin-bottom: 0.25em;
}

.markdown-content :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: var(--accent-subtle);
  text-underline-offset: 2px;
}
.markdown-content :deep(a:hover) {
  text-decoration-color: var(--accent);
}

.markdown-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  margin: 1em 0;
  padding-left: 1em;
  font-style: italic;
  color: var(--text-muted);
}

/* Text Part */
.text-part {
  position: relative;
}

/* Message Actions - outside bubble */
.message-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
  align-self: center;
}

.message-row:hover .message-actions {
  opacity: 1;
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.action-btn.danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--error, #ef4444);
}

/* Edit Mode */
.edit-mode {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.edit-textarea {
  width: 100%;
  min-width: 300px;
  padding: var(--space-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
}

.edit-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

.btn-sm {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: var(--space-xs) var(--space-sm);
  font-size: 13px;
  height: 32px;
}

.btn-danger {
  background: var(--error, #ef4444);
  color: white;
  border: none;
}

.btn-danger:hover {
  background: #dc2626;
}

</style>

<!-- Non-scoped styles for Teleported dialog -->
<style>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 320px;
  max-width: 90vw;
  box-shadow: var(--shadow-lg);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

.dialog-header .action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.dialog-header .action-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.dialog-body {
  padding: var(--space-md);
}

.dialog-message {
  color: var(--text-primary);
  margin-bottom: var(--space-sm);
}

.dialog-warning {
  color: var(--text-muted);
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding: var(--space-md);
  border-top: 1px solid var(--border);
}

.dialog-footer .btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: var(--space-xs) var(--space-sm);
  font-size: 13px;
  height: 32px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.dialog-footer .btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
}

.dialog-footer .btn-ghost:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dialog-footer .btn-danger {
  background: var(--error, #ef4444);
  color: white;
  border: none;
}

.dialog-footer .btn-danger:hover {
  background: #dc2626;
}
</style>

