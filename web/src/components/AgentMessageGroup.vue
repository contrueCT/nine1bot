<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownText from './MarkdownText.vue'
import type { Message, MessagePart, FilePart } from '../api/client'
import AgentSteps from './AgentSteps.vue'
import { X, FileDown, File, Eye } from 'lucide-vue-next'
import { useFilePreview } from '../composables/useFilePreview'
import { formatDuration, formatMessageTime } from '../utils/time-format'
import { buildAgentTimeline } from '../utils/agent-timeline'

const props = defineProps<{
  searchMessageId?: string
  messages: Message[]
  isStreaming: boolean
}>()

/* 按时间顺序切开：最后一个工具之前说的话进折叠区、和工具穿插；之后的才是最终回复 */
const timeline = computed(() => buildAgentTimeline(props.messages, { streaming: props.isStreaming }))
const processItems = computed(() => timeline.value.process)
const replyItems = computed(() => timeline.value.reply)

/* 这一轮从第一条回复开始到最后一条完成的墙钟时间：包括模型思考和工具执行。
   还在生成时不显示，免得数字停在半路 */
const lastCompleted = computed(() => {
  let latest = 0
  for (const message of props.messages) latest = Math.max(latest, message.info.time?.completed || 0)
  return latest
})

const totalDuration = computed(() => {
  if (props.isStreaming || !lastCompleted.value) return ''
  const started = props.messages[0]?.info.time?.created
  return started ? formatDuration(lastCompleted.value - started) : ''
})

const completedTime = computed(() => (!props.isStreaming && lastCompleted.value ? formatMessageTime(lastCompleted.value) : null))

function isImageFile(part: MessagePart): boolean {
  return ((part as any).mime || '').startsWith('image/')
}

function resolveFileUrl(url: string): string {
  if (url.startsWith('file://')) {
    return `/file/upload?path=${encodeURIComponent(url.slice(7))}`
  }
  return url
}

const previewImageUrl = ref<string | null>(null)

const { openPreviewByPath } = useFilePreview()

// Collect all file attachments from tool state across all steps
const toolAttachments = computed<FilePart[]>(() => {
  const result: FilePart[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool' && part.state?.attachments?.length) {
        for (const att of part.state.attachments) {
          if ((att as any).url) result.push(att as FilePart)
        }
      }
    }
  }
  return result
})

// Collect all preview_file tools (completed)
interface PreviewMeta {
  path: string
  filename?: string
  size?: number
  interactive?: boolean
  sessionID: string
}
const previewTools = computed<PreviewMeta[]>(() => {
  const result: PreviewMeta[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (
        part.type === 'tool' &&
        (part.tool || '').toLowerCase() === 'preview_file' &&
        part.state?.status === 'completed' &&
        part.state?.metadata?.path
      ) {
        result.push({
          path: part.state.metadata.path as string,
          filename: part.state.metadata.filename as string | undefined,
          size: part.state.metadata.size as number | undefined,
          interactive: part.state.metadata.interactive as boolean | undefined,
          sessionID: part.sessionID
        })
      }
    }
  }
  return result
})

function downloadAttachment(att: FilePart) {
  let url = att.url
  if (url.startsWith('file://')) {
    url = `/file/download?path=${encodeURIComponent(url.slice(7))}`
  }
  const a = document.createElement('a')
  a.href = url
  a.download = att.filename || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const openingPreviewIdx = ref<number | null>(null)
async function openPreview(meta: PreviewMeta, idx: number) {
  openingPreviewIdx.value = idx
  try {
    await openPreviewByPath(meta.path, { interactive: meta.interactive, sessionID: meta.sessionID })
  } finally {
    openingPreviewIdx.value = null
  }
}
</script>

<template>
  <div class="agent-group">
    <!-- 过程：工具、思考和过程中说的话按先后排在一个折叠区里。
         生成中始终挂着，状态行位置固定，不会在出字时冒出来又消失 -->
    <AgentSteps
      v-if="isStreaming || processItems.length > 0"
      :items="processItems"
      :searchMessageId="searchMessageId"
      :isStreaming="isStreaming"
      :duration="totalDuration"
    />

    <!-- 最终回复：悬停时在下方显示完成时间 -->
    <div v-if="replyItems.length > 0 || toolAttachments.length > 0 || previewTools.length > 0" class="agent-reply">
      <!-- 最终回复：光标只跟在最后一段后面 -->
      <template v-for="(item, index) in replyItems" :key="item.part.id">
        <MarkdownText
          v-if="item.kind === 'text'"
          :text="item.part.text || ''"
          :data-search-message="item.part.messageID" tabindex="-1"
          :streaming="isStreaming && index === replyItems.length - 1"
        />
        <div v-else class="file-attachment">
          <img
            v-if="isImageFile(item.part)"
            :src="resolveFileUrl((item.part as any).url)"
            :alt="(item.part as any).filename || 'image'"
            class="uploaded-image"
            @click="previewImageUrl = resolveFileUrl((item.part as any).url)"
          />
          <a v-else :href="resolveFileUrl((item.part as any).url)" target="_blank" class="file-badge">
            <File :size="18" class="file-icon" />
            <span class="file-name">{{ (item.part as any).filename || '文件' }}</span>
          </a>
        </div>
      </template>

      <!-- Tool file attachments: surfaced from inside collapsed steps -->
      <div v-if="toolAttachments.length > 0" class="tool-attachments-section">
        <div
          v-for="att in toolAttachments"
          :key="att.id"
          class="attachment-item"
        >
          <File :size="16" class="attachment-icon" />
          <span class="attachment-name">{{ att.filename || '未命名文件' }}</span>
          <span v-if="(att as any).size" class="attachment-size">{{ formatSize((att as any).size) }}</span>
          <button class="download-btn" @click="downloadAttachment(att)">
            <FileDown :size="13" /><span>下载</span>
          </button>
        </div>
      </div>

      <!-- Preview file tools: surfaced from inside collapsed steps -->
      <div v-if="previewTools.length > 0" class="preview-tools-section">
        <div
          v-for="(meta, idx) in previewTools"
          :key="meta.path"
          class="preview-item"
        >
          <Eye :size="16" class="preview-icon" />
          <span class="preview-name">{{ meta.filename || '文件预览' }}</span>
          <span v-if="meta.size" class="preview-size">{{ formatSize(meta.size) }}</span>
          <button
            class="preview-btn"
            @click="openPreview(meta, idx)"
            :disabled="openingPreviewIdx === idx"
          >
            <template v-if="openingPreviewIdx === idx">
              <div class="mini-spinner"></div><span>加载中</span>
            </template>
            <template v-else>
              <Eye :size="13" /><span>预览</span>
            </template>
          </button>
        </div>
      </div>

      <div v-if="completedTime" class="reply-meta">
        <time :datetime="completedTime.iso" :title="completedTime.full">{{ completedTime.label }}</time>
      </div>
    </div>
  </div>

  <!-- Image preview -->
  <Teleport to="body">
    <div v-if="previewImageUrl" class="image-preview-overlay" @click="previewImageUrl = null">
      <img :src="previewImageUrl" class="preview-image" @click.stop />
      <button class="preview-close" @click="previewImageUrl = null"><X :size="24" /></button>
    </div>
  </Teleport>
</template>

<style scoped>
.agent-group {
  width: 100%;
}

/* Prose / Markdown styling lives in global style.css (.markdown-content) */
.markdown-content {
  margin-bottom: 4px;
}

/* 完成时间只在悬停时出现，但一直占着这一行，出现时不推动下面的内容 */
.reply-meta {
  display: flex;
  align-items: center;
  height: 20px;
  margin-top: 4px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.agent-reply:hover .reply-meta,
.agent-reply:focus-within .reply-meta {
  opacity: 1;
}

@media (hover: none) {
  .reply-meta { opacity: 1; }
}

.file-attachment { margin: 8px 0; }

.uploaded-image {
  max-width: 100%; max-height: 300px;
  border-radius: var(--radius-md); cursor: pointer;
  transition: transform var(--transition-fast);
  border: 1px solid var(--border-subtle);
}
.uploaded-image:hover { transform: scale(1.01); }

.file-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md); font-size: var(--text-13);
  text-decoration: none; color: inherit; cursor: pointer;
  transition: background var(--transition-fast);
}
.file-badge:hover { background: var(--bg-elevated); }
.file-icon { font-size: var(--text-lg); }
.file-name {
  color: var(--text-primary); max-width: 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Tool file attachments surfaced from steps */
.tool-attachments-section,
.preview-tools-section {
  margin-top: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.attachment-item,
.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.attachment-item:not(:last-child),
.preview-item:not(:last-child) {
  border-bottom: 1px solid var(--border-subtle);
}

.attachment-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.preview-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.attachment-name,
.preview-name {
  flex: 1;
  font-size: var(--text-13);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size,
.preview-size {
  font-size: var(--text-sm);
  color: var(--text-muted);
  flex-shrink: 0;
}

.download-btn,
.preview-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.download-btn:hover,
.preview-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.download-btn:active,
.preview-btn:active:not(:disabled) {
  transform: translateY(0);
}

.preview-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.mini-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

</style>
