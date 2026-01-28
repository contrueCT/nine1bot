<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessagePart } from '../api/client'

const props = defineProps<{
  tool: MessagePart
}>()

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
</style>
