<script setup lang="ts">
import { Folder } from 'lucide-vue-next'

defineProps<{
  modelValue: string
  disabled?: boolean
}>()

</script>

<template>
  <div class="directory-selector" :class="{ disabled }">
    <div class="directory-selector-display">
      <Folder :size="14" />
      <span class="directory-path">{{ modelValue || '未选择目录' }}</span>
    </div>
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

.directory-selector-display {
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
}

.directory-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
</style>
