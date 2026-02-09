<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileDown, File, Eye } from 'lucide-vue-next'
import type { MessagePart } from '../api/client'
import { useFilePreview } from '../composables/useFilePreview'

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
}>()

const { openPreviewByPath } = useFilePreview()

const isExpanded = ref(false)

const toolName = computed(() => props.tool.tool || 'unknown')
const status = computed(() => props.tool.state?.status || 'pending')

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

// Tool display name
const displayName = computed(() => {
  const title = props.tool.state?.title
  if (title) return title

  const names: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Bash',
    grep: 'Grep',
    glob: 'Glob',
    list: 'List',
    webfetch: 'Fetch',
    task: 'Task',
    todowrite: 'Todo',
    todoread: 'Todo'
  }
  return names[toolName.value.toLowerCase()] || toolName.value
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
    downloadUrl = `/api/file/download?path=${encodeURIComponent(filepath)}`
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
    <div class="tool-call-header" @click="isExpanded = !isExpanded">
      <div class="tool-call-icon" :class="statusClass">
        <template v-if="status === 'running'">
          <div class="loading-spinner"></div>
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

      <span v-if="toolTarget" class="tool-call-target truncate">{{ toolTarget }}</span>

      <span v-if="executionTime" class="tool-call-time text-xs text-muted">{{ executionTime }}</span>

      <span class="tool-call-toggle" :class="{ expanded: isExpanded }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </span>
    </div>

    <div v-if="isExpanded" class="tool-call-body">
      <div v-if="tool.state?.input" class="detail-section">
        <div class="detail-label">Input</div>
        <pre>{{ fullInput }}</pre>
      </div>
      <div v-if="outputPreview" class="detail-section">
        <div class="detail-label">Output</div>
        <pre>{{ outputPreview }}</pre>
      </div>
      <div v-if="tool.state?.error" class="detail-section error">
        <div class="detail-label">Error</div>
        <pre class="error-text">{{ tool.state.error }}</pre>
      </div>
    </div>

    <!-- Preview button for preview_file tool -->
    <div v-if="isPreviewTool && previewMetadata?.path && status === 'completed'" class="tool-preview">
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
    <div v-if="attachments.length > 0" class="tool-attachments">
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
.tool-call-target {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-muted);
}

.tool-call-time {
  flex-shrink: 0;
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
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
  border: 0.5px solid var(--border-subtle);
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) 0;
}

.attachment-item:not(:last-child) {
  border-bottom: 0.5px solid var(--border-subtle);
  padding-bottom: var(--space-sm);
  margin-bottom: var(--space-xs);
}

.attachment-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.attachment-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.download-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
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
  border: 0.5px solid var(--accent);
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
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-size {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.preview-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
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
