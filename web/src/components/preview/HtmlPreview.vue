<script setup lang="ts">
import { computed, ref, onBeforeUnmount, watch } from 'vue'
import { RefreshCw, ExternalLink, Code, Eye } from 'lucide-vue-next'
import type { FilePreviewInfo } from '../../composables/useFilePreview'
import { decodeBase64Utf8 } from '../../utils/encoding'
import { openPreviewInNewTab } from '../../utils/preview-window'

const props = defineProps<{
  preview: FilePreviewInfo
}>()

const iframeKey = ref(0)
const showSource = ref(false)
const sourceContent = ref('')
const isLoading = ref(true)

// iframe URL or srcdoc
const iframeSrc = computed(() => {
  if (props.preview.content !== undefined) {
    return null // Use srcdoc
  }
  return `/file/preview/${encodeURIComponent(props.preview.id)}`
})

const iframeSrcdoc = computed(() => {
  if (props.preview.content !== undefined) {
    return decodeBase64Utf8(props.preview.content)
  }
  return null
})

// sandbox attributes based on interactive mode
const sandboxAttr = computed(() => {
  const base = ['allow-scripts']
  if (props.preview.interactive) {
    base.push('allow-same-origin', 'allow-forms', 'allow-modals', 'allow-popups')
  }
  return base.join(' ')
})

// Cancel old source reads when changing preview or leaving the component.
let sourceGeneration = 0
let sourceController: AbortController | undefined
async function loadSource() {
  const generation = ++sourceGeneration
  sourceController?.abort()
  const controller = new AbortController()
  sourceController = controller
  isLoading.value = true
  sourceContent.value = ''
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    let content: string
    if (props.preview.content !== undefined) {
      content = decodeBase64Utf8(props.preview.content)
    } else {
      const res = await fetch(`/file/preview/${encodeURIComponent(props.preview.id)}`, { signal: controller.signal })
      if (!res.ok) throw new Error(`Failed to load source: ${res.status}`)
      content = await res.text()
    }
    if (generation === sourceGeneration) sourceContent.value = content
  } catch {
    if (generation === sourceGeneration) sourceContent.value = 'Failed to load source'
  } finally {
    clearTimeout(timeout)
    if (generation === sourceGeneration) isLoading.value = false
  }
}

watch(() => [props.preview.id, props.preview.content], loadSource, { immediate: true })
onBeforeUnmount(() => {
  sourceGeneration++
  sourceController?.abort()
})

function refresh() {
  iframeKey.value++
}

function openInNewTab() {
  openPreviewInNewTab(props.preview)
}

function toggleSource() {
  showSource.value = !showSource.value
}
</script>

<template>
  <div class="html-preview">
    <div class="html-controls">
      <button @click="refresh" title="刷新">
        <RefreshCw :size="14" />
        刷新
      </button>
      <button @click="toggleSource" :class="{ active: showSource }" title="查看源码">
        <Code :size="14" />
        源码
      </button>
      <button @click="openInNewTab" title="新标签页打开">
        <ExternalLink :size="14" />
        新窗口
      </button>
      <span v-if="preview.interactive" class="interactive-badge">
        <Eye :size="12" />
        交互模式
      </span>
    </div>

    <div v-if="showSource" class="source-view">
      <pre v-if="!isLoading"><code>{{ sourceContent }}</code></pre>
      <div v-else class="loading">加载中...</div>
    </div>

    <iframe
      v-else
      :key="iframeKey"
      :src="iframeSrc || undefined"
      :srcdoc="iframeSrcdoc || undefined"
      :sandbox="sandboxAttr"
      class="html-iframe"
    ></iframe>
  </div>
</template>

<style scoped>
.html-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.html-controls {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.html-controls button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.html-controls button:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.html-controls button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}

.interactive-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 4px 8px;
  background: var(--success);
  color: var(--solid-fg);
  font-size: var(--text-xs);
  font-weight: 500;
  border-radius: var(--radius-sm);
}

.source-view {
  flex: 1;
  overflow: auto;
  background: var(--bg-secondary);
}

.source-view pre {
  margin: 0;
  padding: var(--space-md);
  font-family: var(--font-mono);
  font-size: var(--text-13);
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}

.source-view .loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
}

.html-iframe {
  flex: 1;
  width: 100%;
  border: none;
  background: white;
}
</style>
