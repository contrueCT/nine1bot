<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { Copy, Check } from 'lucide-vue-next'
import type { FilePreviewInfo } from '../../composables/useFilePreview'
import { useFilePreview } from '../../composables/useFilePreview'

const props = defineProps<{
  preview: FilePreviewInfo
}>()

const { codeLanguage } = useFilePreview()

const copied = ref(false)
const codeContent = ref('')
const isLoading = ref(true)
const error = ref<string | null>(null)

// Decode base64 content or fetch from server
async function loadContent() {
  isLoading.value = true
  error.value = null

  try {
    if (props.preview.content) {
      // Decode base64
      codeContent.value = atob(props.preview.content)
    } else {
      // Fetch from server
      const res = await fetch(`/file/preview/${props.preview.id}`)
      if (!res.ok) throw new Error('Failed to load file')
      codeContent.value = await res.text()
    }
  } catch (e: any) {
    error.value = e.message || 'Failed to load content'
  } finally {
    isLoading.value = false
  }
}

onMounted(loadContent)
watch(() => props.preview.id, loadContent)

// Copy code to clipboard
async function copyCode() {
  await navigator.clipboard.writeText(codeContent.value)
  copied.value = true
  setTimeout(() => copied.value = false, 2000)
}

// Count lines
const lineCount = computed(() => {
  if (!codeContent.value) return 0
  return codeContent.value.split('\n').length
})

// Generate line numbers
const lineNumbers = computed(() => {
  return Array.from({ length: lineCount.value }, (_, i) => i + 1)
})
</script>

<template>
  <div class="code-preview">
    <div class="code-header">
      <span class="language-badge">{{ codeLanguage }}</span>
      <span class="line-count">{{ lineCount }} lines</span>
      <button class="copy-btn" @click="copyCode" :disabled="isLoading">
        <Check v-if="copied" :size="14" />
        <Copy v-else :size="14" />
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>

    <div v-if="isLoading" class="loading">
      <span class="loading-spinner"></span>
      加载中...
    </div>

    <div v-else-if="error" class="error">
      {{ error }}
    </div>

    <div v-else class="code-container">
      <div class="line-numbers">
        <span v-for="n in lineNumbers" :key="n">{{ n }}</span>
      </div>
      <pre class="code-content"><code>{{ codeContent }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.code-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
}

.code-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-tertiary);
  border-bottom: 0.5px solid var(--border-default);
  flex-shrink: 0;
}

.language-badge {
  padding: 2px 8px;
  background: var(--accent);
  color: white;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  text-transform: uppercase;
}

.line-count {
  font-size: 11px;
  color: var(--text-muted);
}

.copy-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 4px 10px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.copy-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.copy-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading,
.error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  color: var(--text-muted);
}

.error {
  color: var(--error);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.code-container {
  flex: 1;
  display: flex;
  overflow: auto;
  font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
  font-size: 13px;
  line-height: 1.5;
}

.line-numbers {
  display: flex;
  flex-direction: column;
  padding: var(--space-sm) var(--space-sm);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  text-align: right;
  user-select: none;
  flex-shrink: 0;
  border-right: 0.5px solid var(--border-default);
}

.line-numbers span {
  min-width: 2em;
}

.code-content {
  flex: 1;
  margin: 0;
  padding: var(--space-sm) var(--space-md);
  overflow-x: auto;
  white-space: pre;
  color: var(--text-primary);
}

.code-content code {
  font-family: inherit;
}
</style>
