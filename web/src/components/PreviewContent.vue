<script setup lang="ts">
import { ref } from 'vue'
import { Eye, X, Download, ExternalLink, Copy, Check } from 'lucide-vue-next'
import { useFilePreview } from '../composables/useFilePreview'

// Sub-renderers
import ImagePreview from './preview/ImagePreview.vue'
import CodePreview from './preview/CodePreview.vue'
import MarkdownPreview from './preview/MarkdownPreview.vue'
import HtmlPreview from './preview/HtmlPreview.vue'
import OfficePreview from './preview/OfficePreview.vue'

const {
  previews,
  activePreviewId,
  activePreview,
  previewType,
  selectPreview,
  closePreview,
} = useFilePreview()

const copied = ref(false)

// Format file size
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Download file
function downloadFile() {
  if (!activePreview.value) return
  const preview = activePreview.value

  const link = document.createElement('a')
  if (preview.content) {
    // Inline content
    link.href = `data:${preview.mime};base64,${preview.content}`
  } else {
    // Large file from server
    link.href = `/file/preview/${preview.id}`
  }
  link.download = preview.filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

// Copy file path
async function copyPath() {
  if (!activePreview.value) return
  await navigator.clipboard.writeText(activePreview.value.path)
  copied.value = true
  setTimeout(() => copied.value = false, 2000)
}

// Open in new tab (for HTML)
function openInNewTab() {
  if (!activePreview.value) return
  const preview = activePreview.value

  if (preview.content) {
    const decoded = atob(preview.content)
    const blob = new Blob([decoded], { type: preview.mime })
    window.open(URL.createObjectURL(blob), '_blank')
  } else {
    window.open(`/file/preview/${preview.id}`, '_blank')
  }
}
</script>

<template>
  <div class="preview-content">
    <!-- 文件标签 -->
    <div v-if="previews.length > 1" class="preview-tabs">
      <button
        v-for="preview in previews"
        :key="preview.id"
        class="preview-tab"
        :class="{ active: activePreviewId === preview.id }"
        @click="selectPreview(preview.id)"
      >
        <span class="tab-name">{{ preview.filename }}</span>
        <button class="tab-close" @click.stop="closePreview(preview.id)">
          <X :size="12" />
        </button>
      </button>
    </div>

    <!-- 预览内容 -->
    <div class="preview-body">
      <template v-if="activePreview">
        <!-- 文件信息条 -->
        <div class="file-info">
          <span class="filename">{{ activePreview.filename }}</span>
          <span class="file-meta">{{ formatSize(activePreview.size) }}</span>
          <div class="file-actions">
            <button class="action-btn" @click="copyPath" :title="copied ? '已复制' : '复制路径'">
              <Check v-if="copied" :size="14" />
              <Copy v-else :size="14" />
            </button>
            <button class="action-btn" @click="downloadFile" title="下载">
              <Download :size="14" />
            </button>
            <button
              v-if="previewType === 'html'"
              class="action-btn"
              @click="openInNewTab"
              title="新标签页打开"
            >
              <ExternalLink :size="14" />
            </button>
          </div>
        </div>

        <!-- 根据类型选择渲染器 -->
        <div class="preview-renderer">
          <ImagePreview
            v-if="previewType === 'image'"
            :preview="activePreview"
          />
          <CodePreview
            v-else-if="previewType === 'code'"
            :preview="activePreview"
          />
          <MarkdownPreview
            v-else-if="previewType === 'markdown'"
            :preview="activePreview"
          />
          <HtmlPreview
            v-else-if="previewType === 'html'"
            :preview="activePreview"
          />
          <OfficePreview
            v-else-if="previewType === 'office'"
            :preview="activePreview"
          />
          <div v-else class="unsupported">
            <Eye :size="48" class="unsupported-icon" />
            <p>无法预览此文件类型</p>
            <p class="unsupported-hint">{{ activePreview.mime }}</p>
            <button class="btn btn-primary" @click="downloadFile">
              <Download :size="16" /> 下载文件
            </button>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="empty-state">
          <Eye :size="48" class="empty-icon" />
          <p>没有打开的预览</p>
          <p class="empty-hint">Agent 预览文件后会在这里显示</p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.preview-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.preview-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  padding: var(--space-sm);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.preview-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.preview-tab:hover {
  background: var(--bg-tertiary);
}

.preview-tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 2px;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.tab-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.2);
}

.preview-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-info {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.filename {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-meta {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.file-actions {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-left: auto;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
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

.preview-renderer {
  flex: 1;
  overflow: auto;
}

.unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--space-lg);
  text-align: center;
  color: var(--text-muted);
}

.unsupported-icon {
  opacity: 0.3;
  margin-bottom: var(--space-md);
}

.unsupported-hint {
  font-size: 12px;
  opacity: 0.7;
  margin-top: var(--space-xs);
  margin-bottom: var(--space-md);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-primary {
  background: var(--accent);
  color: white;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  text-align: center;
  padding: var(--space-lg);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: var(--space-md);
}

.empty-hint {
  font-size: 12px;
  opacity: 0.7;
  margin-top: var(--space-xs);
}
</style>
