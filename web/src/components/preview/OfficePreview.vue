<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Download, AlertCircle } from 'lucide-vue-next'
import type { FilePreviewInfo } from '../../composables/useFilePreview'

const props = defineProps<{
  preview: FilePreviewInfo
}>()

const containerRef = ref<HTMLDivElement | null>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)
let renderGeneration = 0
let requestController: AbortController | undefined

// Dynamic import of docx-preview
async function loadDocxPreview() {
  try {
    const module = await import('docx-preview')
    return module
  } catch (e) {
    console.warn('docx-preview not installed, falling back to download mode')
    return null
  }
}

async function renderDocument() {
  const generation = ++renderGeneration
  const preview = props.preview
  requestController?.abort()
  const controller = new AbortController()
  requestController = controller
  isLoading.value = true
  error.value = null
  containerRef.value?.replaceChildren()

  try {
    // Check if it's a DOCX file
    if (!preview.mime.includes('wordprocessingml')) {
      error.value = '不支持的文档格式，仅支持 .docx 文件'
      return
    }

    // Load docx-preview module
    const docxModule = await loadDocxPreview()
    if (generation !== renderGeneration) return
    if (!docxModule) {
      error.value = 'Word 预览组件未安装'
      return
    }

    // Get file content
    let blob: Blob
    if (preview.content) {
      // Decode base64
      const binary = atob(preview.content)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      blob = new Blob([bytes], { type: preview.mime })
    } else {
      // Fetch from server
      const res = await fetch(`/file/preview/${encodeURIComponent(preview.id)}`, { signal: controller.signal })
      if (!res.ok) throw new Error(`无法读取文件（HTTP ${res.status}）`)
      blob = await res.blob()
    }

    if (generation !== renderGeneration) return
    // Rendering cannot be cancelled. Stage each result outside the live view so
    // a slower previous document cannot overwrite the currently selected one.
    const rendered = document.createElement('div')
    await docxModule.renderAsync(blob, rendered, undefined, {
      className: 'docx-wrapper',
      inWrapper: true,
    })
    if (generation !== renderGeneration) return
    containerRef.value?.replaceChildren(rendered)
  } catch (e: any) {
    if (generation === renderGeneration) error.value = e.message || '文档加载失败'
  } finally {
    if (generation === renderGeneration) isLoading.value = false
  }
}

onMounted(renderDocument)
watch(() => props.preview, renderDocument, { flush: 'post' })
onUnmounted(() => {
  renderGeneration++
  requestController?.abort()
})

// Download file
function downloadFile() {
  const link = document.createElement('a')
  if (props.preview.content) {
    link.href = `data:${props.preview.mime};base64,${props.preview.content}`
  } else {
    link.href = `/file/preview/${props.preview.id}`
  }
  link.download = props.preview.filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
</script>

<template>
  <div class="office-preview">
    <div v-if="isLoading" class="loading">
      <span class="loading-spinner"></span>
      正在加载文档...
    </div>

    <div v-else-if="error" class="error-state">
      <AlertCircle :size="48" class="error-icon" />
      <p class="error-message">{{ error }}</p>
      <p class="error-hint">您可以下载文件后在本地查看</p>
      <button class="download-btn" @click="downloadFile">
        <Download :size="16" />
        下载文件
      </button>
      <button class="download-btn" @click="renderDocument">重试预览</button>
    </div>

    <div v-show="!isLoading && !error" ref="containerRef" class="docx-container"></div>
  </div>
</template>

<style scoped>
.office-preview {
  height: 100%;
  overflow: auto;
  background: var(--bg-primary);
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  height: 100%;
  color: var(--text-muted);
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  height: 100%;
  padding: var(--space-lg);
  text-align: center;
}

.error-icon {
  color: var(--text-muted);
  opacity: 0.5;
}

.error-message {
  color: var(--text-primary);
  font-weight: 500;
}

.error-hint {
  color: var(--text-muted);
  font-size: var(--text-13);
}

.download-btn {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  background: var(--accent);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--accent-fg);
  font-size: var(--text-13);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.download-btn:hover {
  background: var(--accent-hover);
}

.docx-container {
  padding: var(--space-md);
  background: white;
  min-height: 100%;
}

/* docx-preview styles */
.docx-container :deep(.docx-wrapper) {
  background: white;
  padding: 20px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  max-width: 800px;
  margin: 0 auto;
}

.docx-container :deep(table) {
  border-collapse: collapse;
  width: 100%;
}

.docx-container :deep(td),
.docx-container :deep(th) {
  border: 1px solid var(--border-default);
  padding: 8px;
}
</style>
