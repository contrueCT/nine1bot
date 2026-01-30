<script setup lang="ts">
import { computed, ref } from 'vue'
import { ZoomIn, ZoomOut, RotateCw, Maximize2 } from 'lucide-vue-next'
import type { FilePreviewInfo } from '../../composables/useFilePreview'

const props = defineProps<{
  preview: FilePreviewInfo
}>()

const zoom = ref(1)
const rotation = ref(0)

const imageUrl = computed(() => {
  if (props.preview.content) {
    return `data:${props.preview.mime};base64,${props.preview.content}`
  }
  return `/file/preview/${props.preview.id}`
})

function zoomIn() {
  zoom.value = Math.min(zoom.value + 0.25, 5)
}

function zoomOut() {
  zoom.value = Math.max(zoom.value - 0.25, 0.1)
}

function resetZoom() {
  zoom.value = 1
  rotation.value = 0
}

function rotate() {
  rotation.value = (rotation.value + 90) % 360
}
</script>

<template>
  <div class="image-preview">
    <div class="image-controls">
      <button @click="zoomOut" title="缩小">
        <ZoomOut :size="16" />
      </button>
      <span class="zoom-level">{{ Math.round(zoom * 100) }}%</span>
      <button @click="zoomIn" title="放大">
        <ZoomIn :size="16" />
      </button>
      <button @click="rotate" title="旋转">
        <RotateCw :size="16" />
      </button>
      <button @click="resetZoom" title="重置">
        <Maximize2 :size="16" />
      </button>
    </div>
    <div class="image-container">
      <img
        :src="imageUrl"
        :alt="preview.filename"
        :style="{
          transform: `scale(${zoom}) rotate(${rotation}deg)`,
        }"
        draggable="false"
      />
    </div>
  </div>
</template>

<style scoped>
.image-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.image-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.image-controls button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.image-controls button:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.zoom-level {
  min-width: 50px;
  text-align: center;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.image-container {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-md);
  background: var(--bg-secondary);
}

.image-container img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transition: transform 0.2s ease;
  user-select: none;
}
</style>
