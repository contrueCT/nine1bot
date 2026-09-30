<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileDown, File, Eye } from 'lucide-vue-next'
import type { MessagePart } from '../api/client'
import { useFilePreview } from '../composables/useFilePreview'
import { useCollapse } from '../composables/use-collapse'
import { getToolDisplayName } from '../utils/tool-names'

// 附件类型
interface FileAttachment {
  id: string
  type: 'file'
  mime: string
  filename?: string
  url: string
}

const props = defineProps<{
  tool: MessagePart
  hideAttachments?: boolean
}>()

const { openPreviewByPath } = useFilePreview()

/* 输出区延迟挂载：收起时不占 DOM，展开时带 0fr → 1fr 的高度过渡 */
const { mounted: bodyMounted, open: isExpanded, toggle } = useCollapse()

const toolName = computed(() => props.tool.tool || 'unknown')
const status = computed(() => props.tool.state?.status || 'pending')
const statusLabel = computed(() => ({
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  error: '失败',
} as Record<string, string>)[status.value] || status.value)

const statusClass = computed(() => {
  switch (status.value) {
    case 'pending': return 'pending'
    case 'running': return 'running'
    case 'completed': return 'success'
    case 'error': return 'error'
    default: return ''
  }
})

// Tool target preview
const toolTarget = computed(() => {
  const input = props.tool.state?.input
  if (!input) return ''

  if (input.filePath || input.file_path) {
    return input.filePath || input.file_path
  }
  if (input.path) return input.path
  if (input.command) {
    const cmd = input.command as string
    return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd
  }
  if (input.pattern) return `"${input.pattern}"`
  if (input.url) return input.url
  if (input.query) return input.query

  return ''
})

/* 名字固定用动作名（「读取」「搜索」），不拿 state.title 顶替：
   title 要等工具跑完才到，一换行里的字就从「读取 README.md」跳成「README.md」 */
const displayName = computed(() => getToolDisplayName(toolName.value))

// 目标优先取入参（运行中就有）；没有入参目标的工具（如 MCP）才退回到 title
const visibleTarget = computed(() => {
  const target = String(toolTarget.value || '')
  if (target) return target
  const title = props.tool.state?.title || ''
  return title && title !== displayName.value ? title : ''
})

// Output preview
const outputPreview = computed(() => {
  const output = props.tool.state?.output
  if (!output) return null

  const str = typeof output === 'string' ? output : JSON.stringify(output)
  return str.length > 300 ? str.slice(0, 300) + '...' : str
})

// Full input JSON
const fullInput = computed(() => {
  const input = props.tool.state?.input
  if (!input) return ''
  return JSON.stringify(input, null, 2)
})

// Execution time
const executionTime = computed(() => {
  const time = props.tool.state?.time
  if (!time?.start || !time?.end) return null
  const duration = time.end - time.start
  if (duration < 1000) return `${duration}ms`
  return `${(duration / 1000).toFixed(1)}s`
})

// Attachments (files to download)
const attachments = computed<FileAttachment[]>(() => {
  const atts = props.tool.state?.attachments
  if (!atts || !Array.isArray(atts)) return []
  return atts.filter((a: any) => a.type === 'file' && a.url)
})

// Check if this is a preview_file tool
const isPreviewTool = computed(() => {
  return toolName.value.toLowerCase() === 'preview_file'
})

// Get preview metadata
const previewMetadata = computed(() => {
  if (!isPreviewTool.value) return null
  return props.tool.state?.metadata as {
    previewId?: string
    path?: string
    filename?: string
    mime?: string
    size?: number
    interactive?: boolean
  } | null
})

// Open preview from metadata
const isOpeningPreview = ref(false)
async function openPreview() {
  const meta = previewMetadata.value
  if (!meta?.path) return

  isOpeningPreview.value = true
  try {
    await openPreviewByPath(meta.path, {
      interactive: meta.interactive,
      sessionID: props.tool.sessionID
    })
  } finally {
    isOpeningPreview.value = false
  }
}

// Download file
function downloadFile(attachment: FileAttachment) {
  let downloadUrl = attachment.url

  // If it's a file:// URL, convert to API download endpoint
  if (attachment.url.startsWith('file://')) {
    const filepath = attachment.url.slice(7) // Remove "file://"
    downloadUrl = `/file/download?path=${encodeURIComponent(filepath)}`
  }

  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = attachment.filename || 'download'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

// Format file size
function formatFileSize(url: string): string {
  // Estimate size from base64 data URL
  if (url.startsWith('data:')) {
    const base64Part = url.split(',')[1]
    if (base64Part) {
      const bytes = Math.ceil(base64Part.length * 0.75)
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }
  }
  return ''
}

// Format size from bytes
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <div class="tool-call">
    <div
      class="tool-call-header"
      role="button"
      tabindex="0"
      :aria-expanded="isExpanded"
      :aria-label="`${displayName}${toolTarget ? ` ${toolTarget}` : ''}，${statusLabel}`"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <div class="tool-call-icon" :class="statusClass" aria-hidden="true">
        <template v-if="status === 'running'">
          <span class="tool-pulse" aria-hidden="true"></span>
        </template>
        <template v-else-if="status === 'completed'">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </template>
        <template v-else-if="status === 'error'">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </template>
        <template v-else>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
          </svg>
        </template>
      </div>

      <span class="tool-call-name">{{ displayName }}</span>

      <span v-if="visibleTarget" class="tool-call-target truncate" :title="visibleTarget">{{ visibleTarget }}</span>

      <span v-if="executionTime" class="tool-call-time text-xs text-muted">{{ executionTime }}</span>

      <span class="tool-call-toggle" :class="{ expanded: isExpanded }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </span>
    </div>

    <div v-if="bodyMounted" class="tool-collapse" :class="{ open: isExpanded }" :aria-hidden="!isExpanded">
      <!-- 这层只负责裁剪，不许带 padding / border：0fr 行轨的下限是格子项的外尺寸，
           内边距压不掉，收起时会剩一条露出正文顶端的缝。内边距放里面那层。 -->
      <div class="tool-collapse-clip">
        <div class="tool-call-body">
          <div v-if="tool.state?.input" class="detail-section">
            <div class="detail-label">输入</div>
            <pre>{{ fullInput }}</pre>
          </div>
          <div v-if="outputPreview" class="detail-section">
            <div class="detail-label">输出</div>
            <pre>{{ outputPreview }}</pre>
          </div>
          <div v-if="tool.state?.error" class="detail-section error">
            <div class="detail-label">错误</div>
            <pre class="error-text">{{ tool.state.error }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Preview button for preview_file tool -->
    <div v-if="!hideAttachments && isPreviewTool && previewMetadata?.path && status === 'completed'" class="tool-preview">
      <div class="preview-item">
        <Eye :size="16" class="preview-icon" />
        <span class="preview-name">{{ previewMetadata.filename || '文件预览' }}</span>
        <span class="preview-size">{{ previewMetadata.size ? formatSize(previewMetadata.size) : '' }}</span>
        <button
          class="preview-btn"
          @click="openPreview"
          :disabled="isOpeningPreview"
          title="打开预览"
        >
          <template v-if="isOpeningPreview">
            <div class="loading-spinner small"></div>
            <span>加载中</span>
          </template>
          <template v-else>
            <Eye :size="14" />
            <span>预览</span>
          </template>
        </button>
      </div>
    </div>

    <!-- Attachments (always visible when present) -->
    <div v-if="!hideAttachments && attachments.length > 0" class="tool-attachments">
      <div
        v-for="attachment in attachments"
        :key="attachment.id"
        class="attachment-item"
      >
        <File :size="16" class="attachment-icon" />
        <span class="attachment-name">{{ attachment.filename || '未命名文件' }}</span>
        <span class="attachment-size">{{ formatFileSize(attachment.url) }}</span>
        <button class="download-btn" @click="downloadFile(attachment)" title="下载文件">
          <FileDown :size="14" />
          <span>下载</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 0fr → 1fr：不用量高度就能把展开做成过渡，内容多长都对 */
.tool-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-normal);
}

.tool-collapse.open {
  grid-template-rows: 1fr;
}

/* 0fr 只把行轨压成 0，压不掉格子项自己的 padding 和 border——行轨的下限取的是
   格子项的「外尺寸」，min-height: 0 只管内容盒。所以格子项必须是一层光板：
   .tool-call-body 直接当格子项的话，收起时会剩 16+16+1=33px 的一条缝，
   里头还露出「输入」那行字的顶端。 */
.tool-collapse > * {
  min-height: 0;
  overflow: hidden;
}

.tool-call-target {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-muted);
}

.tool-call-time {
  flex-shrink: 0;
  margin-left: auto;
}

.tool-call-target + .tool-call-time,
.tool-call-time + .tool-call-toggle {
  margin-left: 0;
}

.detail-section {
  margin-bottom: var(--space-md);
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--space-xs);
}

.error-text {
  color: var(--error);
}

/* Attachments */
.tool-attachments {
  margin-top: var(--space-sm);
  padding: var(--space-sm);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) 0;
}

.attachment-item:not(:last-child) {
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: var(--space-sm);
  margin-bottom: var(--space-xs);
}

.attachment-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.attachment-name {
  flex: 1;
  font-size: var(--text-13);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  font-size: var(--text-sm);
  color: var(--text-muted);
  flex-shrink: 0;
}

.download-btn {
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

.download-btn:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.download-btn:active {
  transform: translateY(0);
}

/* Preview section */
.tool-preview {
  margin-top: var(--space-sm);
  padding: var(--space-sm);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  border: 1px solid var(--accent);
}

.preview-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.preview-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.preview-name {
  flex: 1;
  font-size: var(--text-13);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-size {
  font-size: var(--text-sm);
  color: var(--text-muted);
  flex-shrink: 0;
}

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

.preview-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.preview-btn:active:not(:disabled) {
  transform: translateY(0);
}

.preview-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.loading-spinner.small {
  width: 12px;
  height: 12px;
  border-width: 2px;
}
</style>
