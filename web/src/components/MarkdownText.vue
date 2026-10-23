<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { copyText } from '../utils/clipboard'
import { createCodeRenderer, markdownRenderMode } from '../utils/markdown-renderer'
import { markdownWorkerClient } from '../utils/markdown-worker-client'
import {
  applyBlockOps,
  createMarkdownBlockRenderer,
  diffBlocks,
  type MarkdownBlocks,
} from '../utils/markdown-blocks'

const props = defineProps<{ text: string; streaming?: boolean }>()

const host = ref<HTMLDivElement>()
const renderer = createCodeRenderer()
const renderingPlain = ref(false)
const renderPending = ref(false)
const copyTimers = new Set<ReturnType<typeof setTimeout>>()
let disposed = false

/* 复制结果停留一会儿再复原，避免按钮一直写着「已复制」 */
const COPY_FEEDBACK_MS = 1600

async function handleClick(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.copy-code')
  const code = button?.closest('pre')?.querySelector('code')
  if (!button || !code) return
  const copied = await copyText(code.textContent || '')
  if (disposed) return
  button.textContent = copied ? '已复制' : '复制失败'
  button.classList.toggle('copied', copied)
  const timer = setTimeout(() => {
    copyTimers.delete(timer)
    if (!button.isConnected) return
    button.textContent = '复制'
    button.classList.remove('copied')
  }, COPY_FEEDBACK_MS)
  copyTimers.add(timer)
}

const renderBlocks = createMarkdownBlockRenderer({
  markedOptions: { breaks: true, gfm: true, renderer },
  sanitize: (html) => DOMPurify.sanitize(html),
})

/* 上一次落到 DOM 上的块，用来算 diff。流式追加时通常只有尾块变化，
   前面的块一个都不碰——选中不会丢，代码块的横向滚动位置也不会归零。 */
let blocks: MarkdownBlocks = []
let plainSource = ''
let plainNode: Text | undefined
let renderVersion = 0
let cancelRender: (() => void) | undefined

function paintText(element: HTMLElement, source: string) {
  if (!renderingPlain.value || !plainNode || plainNode.parentNode !== element) {
    plainNode = document.createTextNode(source)
    element.replaceChildren(plainNode)
  } else if (source.startsWith(plainSource)) {
    plainNode.appendData(source.slice(plainSource.length))
  } else plainNode.data = source
  plainSource = source
  renderingPlain.value = true
  blocks = []
}

function paintBlocks(element: HTMLElement, next: MarkdownBlocks) {
  if (renderingPlain.value) element.replaceChildren()
  renderingPlain.value = false
  plainNode = undefined
  plainSource = ''
  applyBlockOps(element, diffBlocks(blocks, next), next)
  blocks = next
}

function paint() {
  const element = host.value
  if (!element || disposed) return
  cancelRender?.()
  cancelRender = undefined
  renderPending.value = false
  const source = props.text
  const mode = markdownRenderMode(source.length, Boolean(props.streaming))
  if (mode === 'inline') {
    paintBlocks(element, renderBlocks(source))
    return
  }
  // Large live tails append a Text node. This keeps every character visible
  // without reparsing/replacing a growing paragraph on every streaming tick.
  paintText(element, source)
  if (mode === 'text') return
  const version = ++renderVersion
  renderPending.value = true
  cancelRender = markdownWorkerClient.render(source, rawBlocks => {
    if (disposed || version !== renderVersion || props.text !== source) return
    cancelRender = undefined
    renderPending.value = false
    if (!rawBlocks) return // CSP/worker failures retain the complete safe text.
    const next = rawBlocks.map(html => DOMPurify.sanitize(html)).filter(Boolean)
    paintBlocks(element, next)
  })
}

/* 帧内合并：一帧里来几个 delta 只重排一次版 */
let timer: ReturnType<typeof setTimeout> | undefined
let lastRender = 0
function flush() {
  if (timer) clearTimeout(timer)
  timer = undefined
  lastRender = Date.now()
  paint()
}

watch([() => props.text, () => props.streaming], () => {
  renderVersion++
  cancelRender?.()
  cancelRender = undefined
  if (!props.streaming || blocks.length === 0 || Date.now() - lastRender >= 32) flush()
  else if (!timer) timer = setTimeout(flush, 32 - (Date.now() - lastRender))
})

onMounted(flush)
onUnmounted(() => {
  disposed = true
  renderVersion++
  cancelRender?.()
  if (timer) clearTimeout(timer)
  for (const copyTimer of copyTimers) clearTimeout(copyTimer)
  copyTimers.clear()
})
</script>

<template>
  <div
    ref="host"
    class="markdown-content"
    :class="{ 'is-streaming': streaming, 'markdown-plain': renderingPlain }"
    :aria-busy="renderPending || undefined"
    @click="handleClick"
  />
</template>

<style scoped>
.markdown-plain { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
