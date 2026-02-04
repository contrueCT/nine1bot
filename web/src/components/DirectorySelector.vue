<script setup lang="ts">
import { Folder } from 'lucide-vue-next'

defineProps<{
  modelValue: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

function handleClick() {
  // Trigger the parent to open directory browser
  emit('update:modelValue', '')
}
</script>

<template>
  <div class="directory-selector" :class="{ disabled }">
    <button 
      class="directory-selector-btn" 
      :disabled="disabled"
      @click="handleClick"
    >
      <Folder :size="14" />
      <span class="directory-path">{{ modelValue || '未选择目录' }}</span>
    </button>
  </div>
</template>

<style scoped>
.directory-selector {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}

.directory-selector.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.directory-selector-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.directory-selector-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--accent);
}

.directory-selector-btn:disabled {
  cursor: not-allowed;
}

.directory-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
</style>
