<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { FilePreviewInfo } from '../../composables/useFilePreview'
import { decodeBase64Utf8 } from '../../utils/encoding'

const props = defineProps<{
  preview: FilePreviewInfo
}>()

const content = ref('')
const isLoading = ref(true)
const error = ref<string | null>(null)

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
})

// Load content
async function loadContent() {
  isLoading.value = true
  error.value = null

  try {
    if (props.preview.content) {
      content.value = decodeBase64Utf8(props.preview.content)
    } else {
      const res = await fetch(`/file/preview/${props.preview.id}`)
      if (!res.ok) throw new Error('Failed to load file')
      content.value = await res.text()
    }
  } catch (e: any) {
    error.value = e.message || 'Failed to load content'
  } finally {
    isLoading.value = false
  }
}

onMounted(loadContent)
watch(() => props.preview.id, loadContent)

// Render markdown to HTML
const renderedHtml = computed(() => {
  if (!content.value) return ''
  const html = marked.parse(content.value) as string
  return DOMPurify.sanitize(html)
})
</script>

<template>
  <div class="markdown-preview">
    <div v-if="isLoading" class="loading">
      <span class="loading-spinner"></span>
      加载中...
    </div>

    <div v-else-if="error" class="error">
      {{ error }}
    </div>

    <div v-else class="markdown-body" v-html="renderedHtml"></div>
  </div>
</template>

<style scoped>
.markdown-preview {
  height: 100%;
  overflow: auto;
  background: var(--bg-primary);
}

.loading,
.error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  height: 100%;
  color: var(--text-muted);
}

.error {
  color: var(--error);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.markdown-body {
  padding: var(--space-lg);
  max-width: 800px;
  margin: 0 auto;
  color: var(--text-primary);
  line-height: 1.6;
}

/* Markdown styles */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-body :deep(h1) { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.markdown-body :deep(h2) { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.markdown-body :deep(h3) { font-size: 1.25em; }
.markdown-body :deep(h4) { font-size: 1em; }

.markdown-body :deep(p) {
  margin: 1em 0;
}

.markdown-body :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(code) {
  padding: 0.2em 0.4em;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
}

.markdown-body :deep(pre) {
  padding: var(--space-md);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  overflow-x: auto;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: none;
}

.markdown-body :deep(blockquote) {
  margin: 1em 0;
  padding: 0.5em 1em;
  border-left: 4px solid var(--accent);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 1em 0;
  padding-left: 2em;
}

.markdown-body :deep(li) {
  margin: 0.5em 0;
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 0.5em 1em;
  border: 1px solid var(--border);
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--bg-secondary);
  font-weight: 600;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-md);
}

.markdown-body :deep(hr) {
  margin: 2em 0;
  border: none;
  border-top: 1px solid var(--border);
}
</style>
