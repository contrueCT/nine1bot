<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { FileDiff, RefreshCw, X } from 'lucide-vue-next'
import { useSessionChanges } from '../composables/useSessionChanges'
import { useModalFocus } from '../composables/useModalFocus'

const props = defineProps<{
  sessionId: string
  directory: string
  sessionTitle?: string
  isStreaming: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement>()
const opened = ref(new Set<string>())
const visibleCount = ref(50)
const { files, loading, error, loadedAt, load, reset } = useSessionChanges()
const visibleFiles = computed(() => files.value.slice(0, visibleCount.value))
const additions = computed(() => files.value.reduce((sum, file) => sum + file.additions, 0))
const deletions = computed(() => files.value.reduce((sum, file) => sum + file.deletions, 0))
const TEXT_LIMIT = 100_000
function refresh() { return load(props.sessionId, props.directory) }
function toggle(file: string) {
  const next = new Set(opened.value)
  if (next.has(file)) next.delete(file)
  else next.add(file)
  opened.value = next
}
watch(() => [props.sessionId, props.directory], () => {
  opened.value = new Set()
  visibleCount.value = 50
  void refresh()
}, { immediate: true })
watch(() => props.isStreaming, (running, wasRunning) => {
  if (wasRunning && !running) void refresh()
})
onUnmounted(reset)
useModalFocus(root, () => emit('close'))
</script>

<template>
  <section ref="root" class="changes-panel" role="dialog" aria-modal="true" aria-labelledby="changes-title" tabindex="-1">
    <header class="changes-header">
      <div>
        <h2 id="changes-title"><FileDiff :size="18" /> 文件变更</h2>
        <p>{{ sessionTitle || '当前会话' }}</p>
      </div>
      <div class="changes-actions">
        <button type="button" class="btn btn-ghost" :disabled="loading" @click="refresh" aria-label="刷新文件变更">
          <RefreshCw :size="16" /> 刷新
        </button>
        <button type="button" class="btn btn-ghost btn-icon" @click="emit('close')" aria-label="关闭文件变更"><X :size="18" /></button>
      </div>
    </header>
    <p class="changes-note">查看会话快照中的变更前后内容。快照可能包含会话期间的其他操作；提交前请核对当前工作区和测试结果。</p>
    <p v-if="isStreaming" class="changes-note" role="status">任务仍在运行，当前只显示已记录的快照；结束后会刷新。</p>
    <div v-if="error" class="changes-error" role="alert">
      {{ error }}<span v-if="loadedAt">，下方保留上次成功读取的快照</span>
      <button type="button" class="btn btn-ghost" :disabled="loading" @click="refresh">重试</button>
    </div>
    <p v-if="loading" class="changes-note" role="status">正在读取文件变更…</p>
    <p v-else-if="loadedAt && !files.length && !error" class="changes-empty">尚无已记录的文件变更。快照未启用、尚未完成或文件未发生变化时，这里可能为空。</p>
    <div v-if="files.length" class="changes-summary">{{ files.length }} 个文件 <span class="added">+{{ additions }}</span> <span class="removed">−{{ deletions }}</span></div>
    <div class="changes-files custom-scrollbar">
      <article v-for="file in visibleFiles" :key="file.file" class="change-file">
        <button type="button" class="change-file-toggle" :aria-expanded="opened.has(file.file)" @click="toggle(file.file)">
          <span class="change-path">{{ file.file }}</span>
          <span class="change-counts"><span class="added">+{{ file.additions }}</span> <span class="removed">−{{ file.deletions }}</span></span>
        </button>
        <div v-if="opened.has(file.file)" class="change-columns">
          <section><h3>变更前</h3><p v-if="file.before.length > TEXT_LIMIT" class="changes-note">内容较长，仅显示前 {{ TEXT_LIMIT }} 个字符</p><pre>{{ file.before.slice(0, TEXT_LIMIT) || '（空）' }}</pre></section>
          <section><h3>变更后</h3><p v-if="file.after.length > TEXT_LIMIT" class="changes-note">内容较长，仅显示前 {{ TEXT_LIMIT }} 个字符</p><pre>{{ file.after.slice(0, TEXT_LIMIT) || '（空）' }}</pre></section>
        </div>
      </article>
      <button v-if="files.length > visibleCount" type="button" class="btn btn-ghost" @click="visibleCount += 50">显示更多文件</button>
    </div>
  </section>
</template>

<style scoped>
.changes-panel { width: min(1050px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); display: flex; flex-direction: column; background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: 20px; outline: none; }
.changes-header, .changes-actions, .change-file-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.changes-header h2 { display: flex; gap: 8px; align-items: center; margin: 0; font-size: 18px; }
.changes-header p { color: var(--text-muted); font-size: 12px; margin: 5px 0; overflow-wrap: anywhere; }
.changes-note, .changes-empty { font-size: 12px; line-height: 1.6; color: var(--text-muted); margin: 10px 0; }
.changes-error { color: var(--error); font-size: 13px; padding: 8px 0; }
.changes-summary { font-size: 13px; padding: 8px 0 12px; }
.added { color: var(--success, #16803c); }
.removed { color: var(--error, #b82f2f); }
.changes-files { overflow: auto; min-height: 0; }
.change-file { border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
.change-file-toggle { width: 100%; padding: 12px; background: var(--bg-secondary); color: inherit; border: none; text-align: left; cursor: pointer; }
.change-path { min-width: 0; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 12px; }
.change-counts { flex-shrink: 0; font-size: 12px; }
.change-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.change-columns section { min-width: 0; }
.change-columns section + section { border-left: 1px solid var(--border-default); }
.change-columns h3 { font-size: 12px; margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--border-default); }
.change-columns pre { font: 12px/1.6 var(--font-mono); margin: 0; padding: 12px; max-height: 45vh; overflow: auto; white-space: pre; }
@media (max-width: 600px) { .changes-panel { padding: 12px; } .changes-header { align-items: flex-start; } .changes-actions { gap: 4px; } .change-columns { grid-template-columns: minmax(0, 1fr); } .change-columns section + section { border-left: none; border-top: 1px solid var(--border-default); } }
</style>
