<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Bot, User, Brain, ChevronDown, Pencil, Trash2, X, Check } from 'lucide-vue-next'
import type { Message, MessagePart } from '../api/client'
import ToolCall from './ToolCall.vue'
import { useUserProfile } from '../composables/useUserProfile'

const { profile, botAvatar } = useUserProfile()

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
    // 过滤 synthetic 文本（系统生成的上传描述等），不在用户气泡中显示
    if (part.type === 'text' && (part as any).synthetic) return
    if (part.type === 'text' && part.text) {
      result.push({ type: 'text', part, index })
    } else if (part.type === 'tool') {
      result.push({ type: 'tool', part, index })
    } else if (part.type === 'reasoning') {
      result.push({ type: 'reasoning', part, index })
    } else if (part.type === 'file') {
      result.push({ type: 'file', part, index })
    }
  })
  return result
})

// Check if a file part is an image
function isImageFile(part: MessagePart): boolean {
  const mime = (part as any).mime || ''
  return mime.startsWith('image/')
}

// 将 file:// URL 转为 HTTP URL（浏览器无法加载 file:// 协议）
function resolveFileUrl(url: string): string {
  if (url.startsWith('file://')) {
    return `/file/upload?path=${encodeURIComponent(url.slice(7))}`
  }
  return url
}

// Image preview state
const previewImageUrl = ref<string | null>(null)

function openImagePreview(url: string) {
  previewImageUrl.value = url
}

function closeImagePreview() {
  previewImageUrl.value = null
}

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
      <template v-if="message.info.role === 'user'">
        <img v-if="profile.avatarUrl" :src="profile.avatarUrl" alt="Avatar" class="avatar-img" />
        <User v-else :size="18" />
      </template>
      <template v-else>
        <img v-if="botAvatar.botAvatarUrl" :src="botAvatar.botAvatarUrl" alt="Bot" class="avatar-img" />
        <Bot v-else :size="18" />
      </template>
    </div>

    <div class="message-wrapper" :class="{ 'user-wrapper': message.info.role === 'user' }">
      <div class="message-bubble" :class="{ 'user-bubble': message.info.role === 'user', 'agent-bubble glass': message.info.role !== 'user' }">

      <div class="message-sender-name" v-if="message.info.role === 'user' && profile.name">
        {{ profile.name }}
      </div>
      <div class="message-sender-name" v-else-if="message.info.role !== 'user'">
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

          <!-- File Attachment (Image) -->
          <div v-else-if="item.type === 'file'" class="file-attachment">
            <img
              v-if="isImageFile(item.part)"
              :src="resolveFileUrl((item.part as any).url)"
              :alt="(item.part as any).filename || 'Uploaded image'"
              class="uploaded-image"
              @click="openImagePreview(resolveFileUrl((item.part as any).url))"
            />
            <a v-else :href="resolveFileUrl((item.part as any).url)" target="_blank" class="file-badge">
              <span class="file-icon">📄</span>
              <span class="file-name">{{ (item.part as any).filename || 'File' }}</span>
            </a>
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

      <!-- 用户消息的操作按钮（在气泡下方） -->
      <div class="message-actions" v-if="message.info.role === 'user' && !editingPartId">
        <button class="action-btn" @click="startEdit(message.parts.find(p => p.type === 'text')!)" title="编辑">
          <Pencil :size="14" />
        </button>
        <button class="action-btn danger" @click="startDelete(message.parts.find(p => p.type === 'text')!)" title="删除">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
  </div>

  <!-- 图片预览模态框 -->
  <Teleport to="body">
    <div v-if="previewImageUrl" class="image-preview-overlay" @click="closeImagePreview">
      <img :src="previewImageUrl" class="preview-image" @click.stop />
      <button class="preview-close" @click="closeImagePreview">
        <X :size="24" />
      </button>
    </div>
  </Teleport>

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
  gap: 12px;
  padding: 12px var(--space-lg);
  width: 100%;
  opacity: 0;
  animation: fade-up 0.3s var(--ease-smooth) forwards;
}

@keyframes fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.user-row {
  flex-direction: row-reverse;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
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
  background: var(--accent);
  color: white;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}

/* Message wrapper for positioning actions */
.message-wrapper {
  display: flex;
  flex-direction: column;
  max-width: 720px;
}

.user-wrapper {
  align-items: flex-end;
}

.message-bubble {
  width: fit-content;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  position: relative;
  line-height: 1.5;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.user-bubble {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.agent-bubble {
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
}

.message-sender-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Thinking Block */
.thinking-block {
  margin: 8px 0 16px;
  border: 0.5px solid var(--border-default);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  transition: background var(--transition-fast);
}

.thinking-header:hover {
  background: var(--bg-tertiary);
}

.thinking-label {
  flex: 1;
}

.thinking-chevron {
  transition: transform 0.15s var(--ease-smooth);
}

.thinking-chevron.expanded {
  transform: rotate(180deg);
}

.thinking-body {
  padding: 12px;
  border-top: 0.5px solid var(--border-subtle);
  background: var(--bg-secondary);
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
  font-weight: var(--font-weight-normal);
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
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--accent);
}

.markdown-content :deep(pre) {
  background: var(--bg-secondary);
  padding: 16px;
  border-radius: var(--radius-md);
  margin: 1em 0;
  overflow-x: auto;
  border: 0.5px solid var(--border-default);
}

:root[data-theme='dark'] .markdown-content :deep(pre) {
  background: #1a1a1e;
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
  text-decoration-color: rgba(204, 77, 40, 0.3);
  text-underline-offset: 2px;
}
.markdown-content :deep(a:hover) {
  text-decoration-color: var(--accent);
}

.markdown-content :deep(blockquote) {
  border-left: 2px solid var(--accent);
  margin: 1em 0;
  padding-left: 1em;
  font-style: italic;
  color: var(--text-muted);
}

/* Text Part */
.text-part {
  position: relative;
}

/* Message Actions - below user bubble */
.message-actions {
  display: flex;
  flex-direction: row;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
  margin-top: 4px;
  justify-content: flex-end;
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
  background: var(--error-subtle);
  color: var(--error);
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
  background: var(--bg-primary);
  border: 0.5px solid var(--border-default);
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
  background: var(--error);
  color: white;
  border: none;
}

.btn-danger:hover {
  background: #dc2626;
}

/* File Attachment */
.file-attachment {
  margin: 8px 0;
}

.uploaded-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: transform var(--transition-fast);
  border: 0.5px solid var(--border-subtle);
}

.uploaded-image:hover {
  transform: scale(1.01);
}

.file-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: 13px;
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.file-badge:hover {
  background: var(--bg-elevated);
}

.file-icon {
  font-size: 18px;
}

.file-name {
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
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
  border-bottom: 0.5px solid var(--border-subtle);
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
  background: var(--bg-tertiary);
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
  border-top: 0.5px solid var(--border-subtle);
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
  border: 0.5px solid var(--border-default);
  color: var(--text-secondary);
}

.dialog-footer .btn-ghost:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dialog-footer .btn-danger {
  background: var(--error);
  color: white;
  border: none;
}

.dialog-footer .btn-danger:hover {
  background: #dc2626;
}

/* Image Preview Modal */
.image-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1001;
  cursor: pointer;
}

.preview-image {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  cursor: default;
}

.preview-close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: white;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.preview-close:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>

