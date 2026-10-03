<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Pencil, Trash2, X, Check, File } from 'lucide-vue-next'
import type { Message, MessagePart } from '../api/client'
import { useUserProfile } from '../composables/useUserProfile'
import { createMessageMutation, type MessageMutationDone } from '../composables/message-mutation'
import { formatMessageTime } from '../utils/time-format'

const { profile } = useUserProfile()

const props = defineProps<{
  message: Message
}>()

const emit = defineEmits<{
  'delete-part': [messageId: string, partId: string, done: MessageMutationDone]
  'update-part': [messageId: string, partId: string, updates: { text?: string }, done: MessageMutationDone]
}>()

// 编辑状态
const editingPartId = ref<string | null>(null)
const editText = ref('')
const deleteConfirmPartId = ref<string | null>(null)
const mutation = createMessageMutation()
const mutationState = mutation.state
watch(() => props.message.info.id, () => {
  mutation.reset()
  editingPartId.value = null
  deleteConfirmPartId.value = null
  editText.value = ''
})
onUnmounted(mutation.reset)

// 用户消息的第一个文本 part（纯附件消息没有，编辑/删除按钮据此隐藏）
const firstTextPart = computed(() => props.message.parts.find(p => p.type === 'text'))

const sentTime = computed(() => {
  const created = props.message.info.time?.created
  return created ? formatMessageTime(created) : null
})

function startEdit(part?: MessagePart) {
  if (mutationState.pending) return
  mutation.reset()
  if (!part || part.type !== 'text' || !part.text) return
  editingPartId.value = part.id
  editText.value = part.text
}

function cancelEdit() {
  if (mutationState.pending) return
  mutation.reset()
  editingPartId.value = null
  editText.value = ''
}

function confirmEdit(partId: string) {
  if (!editText.value.trim()) return
  const done = mutation.begin(cancelEdit)
  if (done) emit('update-part', props.message.info.id, partId, { text: editText.value.trim() }, done)
}

function startDelete(part?: MessagePart) {
  if (mutationState.pending || !part || part.type !== 'text') return
  mutation.reset()
  deleteConfirmPartId.value = part.id
}

function cancelDelete() {
  if (mutationState.pending) return
  mutation.reset()
  deleteConfirmPartId.value = null
}

function confirmDelete(partId: string) {
  const done = mutation.begin(cancelDelete)
  if (done) emit('delete-part', props.message.info.id, partId, done)
}

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
})

// User message parts (simple: only text and file)
const userParts = computed(() => {
  return props.message.parts
    .filter(p => {
      if (p.type === 'text' && (p as any).synthetic) return false
      return p.type === 'text' || p.type === 'file'
    })
    .map((part, index) => ({ part, index }))
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

// user 消息文本渲染后不再变化，按文本缓存 marked+DOMPurify 结果
const formatCache = new Map<string, string>()

// Format text with marked and sanitize with DOMPurify
function formatText(text: string): string {
  const cached = formatCache.get(text)
  if (cached !== undefined) return cached

  let rendered: string
  try {
    rendered = DOMPurify.sanitize(marked.parse(text) as string)
  } catch (e) {
    console.error('Markdown parse error:', e)
    rendered = DOMPurify.sanitize(text)
  }
  formatCache.set(text, rendered)
  return rendered
}

// Escape 关闭图片预览 / 删除确认框
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (previewImageUrl.value) {
    closeImagePreview()
  } else if (deleteConfirmPartId.value) {
    cancelDelete()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- ChatPanel 只传入 user 消息，agent 消息由 AgentMessageGroup 渲染 -->
  <div class="message-row user-row">
    <!-- 只有设置了头像才显示：默认的小人图标每条消息都重复一遍，只是噪声 -->
    <div v-if="profile.avatarUrl" class="avatar">
      <img :src="profile.avatarUrl" alt="头像" class="avatar-img" />
    </div>

    <!-- User message -->
    <div class="message-wrapper user-wrapper">
      <div class="message-sender-name" v-if="profile.name">{{ profile.name }}</div>
      <div class="message-bubble user-bubble" :class="{ editing: !!editingPartId }">
        <div class="message-content">
          <template v-for="item in userParts" :key="item.part.id || item.index">
            <!-- File Attachment -->
            <div v-if="item.part.type === 'file'" class="file-attachment">
              <img
                v-if="isImageFile(item.part)"
                :src="resolveFileUrl((item.part as any).url)"
                :alt="(item.part as any).filename || '上传的图片'"
                class="uploaded-image"
                @click="openImagePreview(resolveFileUrl((item.part as any).url))"
              />
              <a v-else :href="resolveFileUrl((item.part as any).url)" target="_blank" class="file-badge">
                <span class="file-icon"><File :size="18" /></span>
                <span class="file-name">{{ (item.part as any).filename || '文件' }}</span>
              </a>
            </div>
            <!-- Text -->
            <div v-else-if="item.part.type === 'text'" class="text-part" :class="{ editing: editingPartId === item.part.id }">
              <div v-if="editingPartId === item.part.id" class="edit-mode" :aria-busy="mutationState.pending">
                <textarea v-model="editText" :disabled="mutationState.pending" class="edit-textarea" rows="4" @keyup.escape="cancelEdit"></textarea>
                <p v-if="mutationState.error" class="mutation-error" role="alert">{{ mutationState.error }}</p>
                <div class="edit-actions">
                  <button class="btn btn-ghost btn-sm" :disabled="mutationState.pending" @click="cancelEdit"><X :size="14" /> 取消</button>
                  <button class="btn btn-primary btn-sm" @click="confirmEdit(item.part.id)" :disabled="!editText.trim() || mutationState.pending"><Check :size="14" /> {{ mutationState.pending ? '保存中…' : '保存' }}</button>
                </div>
              </div>
              <template v-else>
                <div class="markdown-content" v-html="formatText(item.part.text || '')"></div>
              </template>
            </div>
          </template>
        </div>
      </div>
      <!-- 悬停时出现：发送时间 + 操作按钮（纯附件消息没有文本 part，不渲染编辑/删除）。
           这一行始终占位，只切换透明度，悬停时下面的消息不会跳动 -->
      <div class="message-actions" v-if="!editingPartId && (sentTime || firstTextPart)">
        <time v-if="sentTime" class="message-time" :datetime="sentTime.iso" :title="sentTime.full">{{ sentTime.label }}</time>
        <template v-if="firstTextPart">
          <button class="action-btn" @click="startEdit(firstTextPart)" title="编辑" aria-label="编辑消息"><Pencil :size="14" /></button>
          <button class="action-btn danger" @click="startDelete(firstTextPart)" title="删除" aria-label="删除消息"><Trash2 :size="14" /></button>
        </template>
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
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label="删除消息内容" :aria-busy="mutationState.pending" @click.stop>
        <div class="dialog-header">
          <span>删除消息内容</span>
          <button class="action-btn" :disabled="mutationState.pending" @click="cancelDelete">
            <X :size="16" />
          </button>
        </div>
        <div class="dialog-body">
          <p class="dialog-message">确定要删除这部分内容吗？</p>
          <p v-if="mutationState.error" class="mutation-error" role="alert">{{ mutationState.error }}</p>
          <p class="dialog-warning">此操作不可撤销。</p>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-ghost btn-sm" :disabled="mutationState.pending" @click="cancelDelete">取消</button>
          <button class="btn btn-danger btn-sm" :disabled="mutationState.pending" @click="confirmDelete(deleteConfirmPartId!)">
            <Trash2 :size="14" /> {{ mutationState.pending ? '删除中…' : '删除' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mutation-error { color: var(--error); font-size: 0.8125rem; }
.message-row {
  display: flex;
  gap: 10px;
  padding: 16px var(--space-lg) 8px;
  width: 100%;
  opacity: 0;
  animation: fade-up 0.3s var(--ease-smooth) forwards;
}

.user-row {
  flex-direction: row-reverse;
}

.avatar {
  width: 28px;
  height: 28px;
  margin-top: 2px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.user-row .avatar {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
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
  min-width: 0;
  max-width: min(82%, 620px);
}

.user-wrapper {
  align-items: flex-end;
}

.message-bubble {
  width: fit-content;
  max-width: 100%;
  position: relative;
  overflow-wrap: anywhere;
}

/* 用户气泡：浅灰块，靠近发言人一侧的上角收紧，读起来是「从右边说出来的」。
   字号比回答小一档：用户的话是指令，回答才是要细读的正文。 */
.user-bubble {
  padding: 9px 15px;
  border-radius: 18px 6px 18px 18px;
  background: var(--user-bubble);
  color: var(--text-primary);
}

.user-bubble.editing {
  width: min(620px, 100%);
  border-radius: 14px;
}

.user-bubble :deep(.markdown-content) {
  font-size: var(--text-base);
  line-height: 1.65;
}

.user-bubble :deep(.markdown-content p) {
  margin-bottom: 0.6em;
}

.user-bubble :deep(.markdown-content p:last-child) {
  margin-bottom: 0;
}

/* 气泡本身就是浅灰，行内代码和代码块要反过来用白底才分得出来 */
.user-bubble :deep(.markdown-content code) {
  background: var(--bg-primary);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

.user-bubble :deep(.markdown-content pre) {
  margin: 0.6em 0;
  padding: 10px 12px;
  background: var(--bg-primary);
}

.user-bubble :deep(.markdown-content pre code) {
  box-shadow: none;
}

.user-bubble :deep(.markdown-content pre .copy-code) {
  display: none;
}

.message-sender-name {
  margin: 0 6px 4px;
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--text-muted);
}

/* Prose / Markdown styling lives in global style.css (.markdown-content) */

/* Text Part */
.text-part {
  position: relative;
}

/* Message Actions - below user bubble */
.message-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 2px;
  min-height: 26px;
  opacity: 0;
  transition: opacity var(--transition-fast);
  margin-top: 2px;
  justify-content: flex-end;
}

.message-time {
  margin-right: 4px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.message-row:hover .message-actions,
.message-row:focus-within .message-actions {
  opacity: 1;
}

@media (hover: none) {
  .message-actions { opacity: 1; }
}

.action-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-btn:hover {
  background: var(--hover-overlay);
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
  min-width: 0;
  padding: var(--space-sm) 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  line-height: 1.6;
  color: var(--text-primary);
  font-size: var(--text-base);
  font-family: inherit;
  resize: vertical;
}

.edit-textarea:focus {
  outline: none;
  border-color: rgba(var(--accent-rgb), 0.45);
  box-shadow: 0 0 0 3px var(--accent-subtle);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

/* File Attachment */
.file-attachment {
  margin: 4px 0;
}

.file-attachment:first-child { margin-top: 0; }
.file-attachment:last-child { margin-bottom: 0; }

.uploaded-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: transform var(--transition-fast);
  border: 1px solid var(--border-subtle);
}

.uploaded-image:hover {
  transform: scale(1.01);
}

.file-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: var(--text-13);
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.file-badge:hover {
  background: var(--bg-elevated);
}

.file-icon {
  font-size: var(--text-lg);
}

.file-name {
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>


