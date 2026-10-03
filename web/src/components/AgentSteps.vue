<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronRight, Check, X } from 'lucide-vue-next'
import type { MessagePart } from '../api/client'
import ToolCall from './ToolCall.vue'
import MarkdownText from './MarkdownText.vue'
import { useCollapse } from '../composables/use-collapse'
import { getToolDisplayName } from '../utils/tool-names'
import { summarizeTools } from '../utils/step-summary'
import type { ProcessItem } from '../utils/agent-timeline'

const props = defineProps<{
  /** 按时间顺序排好的过程：工具、思考、过程中说的话 */
  searchMessageId?: string
  items: ProcessItem[]
  isStreaming: boolean
  /** 这一轮的总用时，已格式化；生成中为空 */
  duration?: string
}>()

/* 过程区延迟挂载 + 0fr → 1fr 过渡：收起时不让上百张工具卡常驻 DOM。
   运行中默认展开，过程中说的话和工具调用一直看得见；跑完自动收起。
   用户在运行中手动收起过，就尊重这个选择，不再自动弹开。 */
const { mounted: bodyMounted, open: isExpanded, set, toggle } = useCollapse()
const userToggled = ref(false)

function handleToggle() {
  userToggled.value = true
  void toggle()
}

watch(() => props.isStreaming, (streaming, wasStreaming) => {
  if (streaming && !userToggled.value) void set(true)
  // 一轮结束：收起，并清掉手动记录，之后开合由用户决定
  if (!streaming && wasStreaming) {
    userToggled.value = false
    void set(false)
  }
}, { immediate: true })

watch(() => props.searchMessageId, id => {
  if (id && props.items.some(item => item.kind === 'narration' && item.part.messageID === id)) void set(true)
}, { immediate: true })

const reasoningExpanded = ref<Record<string, boolean>>({})

const tools = computed(() => props.items.filter(item => item.kind === 'tool').map(item => item.part))
const failedCount = computed(() => tools.value.filter(part => part.state?.status === 'error').length)
const activeTool = computed(() => tools.value.filter(part => part.state?.status === 'running' || part.state?.status === 'pending').slice(-1)[0])

/* 状态色：失败过就标红，跑完才给绿，运行中用强调色的呼吸点 */
const stepsTone = computed(() => (failedCount.value > 0 ? 'error' : props.isStreaming ? 'running' : 'success'))

/* 头部只有一行，元素固定不增删，只换文字：
   运行中说「现在在做什么」，跑完才说「一共做了什么」 */
const headline = computed(() => {
  if (props.isStreaming) {
    const active = activeTool.value
    if (active) {
      const target = getToolTarget(active)
      return target ? `正在${getToolLabel(active)} ${target}` : `正在${getToolLabel(active)}`
    }
    // 没有工具在跑，就是在等模型输出
    return '正在思考'
  }
  return summarizeTools(
    tools.value.map(part => ({ label: getToolLabel(part), status: part.state?.status })),
    props.items.length,
  )
})

/** 归类计数用的名字：不能用 title，title 往回带上了目标文件，一条一类就没法统计 */
function getToolLabel(part: MessagePart): string {
  return getToolDisplayName((part.tool || '').toLowerCase(), part.tool || '工具')
}

function getToolTarget(part: MessagePart): string {
  const input = part.state?.input
  if (!input) return ''
  const path = (input.filePath || input.file_path || input.path) as string | undefined
  if (path) return path.length > 45 ? '…' + path.slice(-42) : path
  if (input.command) {
    const cmd = input.command as string
    return cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd
  }
  if (input.pattern) return `"${input.pattern}"`
  if (input.url) return input.url as string
  if (input.query) return input.query as string
  return ''
}

function toggleReasoning(partId: string) {
  reasoningExpanded.value[partId] = !reasoningExpanded.value[partId]
}

function needsExpandButton(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 200
}

/** 只有最后一项还在输出时才挂光标，前面说完的话不闪 */
function isLiveNarration(index: number): boolean {
  return props.isStreaming && !activeTool.value && index === props.items.length - 1
}
</script>

<template>
  <div class="steps" :class="{ 'is-open': isExpanded, 'is-running': isStreaming }">
    <div
      class="steps-head"
      role="button"
      tabindex="0"
      :aria-expanded="isExpanded"
      :aria-label="isExpanded ? '收起执行过程' : '展开执行过程'"
      @click="handleToggle"
      @keydown.enter.prevent="handleToggle"
      @keydown.space.prevent="handleToggle"
    >
      <div class="steps-icon" :class="stepsTone" aria-hidden="true">
        <span v-if="stepsTone === 'running'" class="tool-pulse"></span>
        <X v-else-if="stepsTone === 'error'" :size="10" />
        <Check v-else :size="10" />
      </div>
      <span class="steps-summary" :class="{ 'steps-shimmer': isStreaming }">{{ headline }}</span>
      <span v-if="duration" class="steps-duration" :title="`这一轮用时 ${duration}`">{{ duration }}</span>
      <ChevronRight :size="12" class="steps-chevron" :class="{ open: isExpanded }" />
    </div>

    <div v-if="bodyMounted" class="steps-collapse" :class="{ open: isExpanded }" :aria-hidden="!isExpanded">
      <div class="steps-body">
        <template v-for="(item, index) in items" :key="item.part.id">
          <!-- 过程中说的话：和工具按先后穿插，比最终回复淡一档 -->
          <div v-if="item.kind === 'narration'" class="narration" :data-search-message="item.part.messageID" tabindex="-1">
            <MarkdownText :text="item.part.text || ''" :streaming="isLiveNarration(index)" />
          </div>

          <div v-else-if="item.kind === 'reasoning'" class="reasoning-block">
            <div v-if="item.part.text">
              <div
                class="reasoning-text"
                :class="{ clamped: !reasoningExpanded[item.part.id] }"
              >{{ item.part.text }}</div>
              <button
                v-if="needsExpandButton(item.part.text)"
                class="reasoning-toggle"
                @click.stop="toggleReasoning(item.part.id)"
              >
                {{ reasoningExpanded[item.part.id] ? '收起' : '展开' }}
              </button>
            </div>
            <div v-else class="loading-wave">
              <span>.</span><span>.</span><span>.</span>
            </div>
          </div>

          <ToolCall v-else :tool="item.part" :hideAttachments="true" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.steps {
  margin: 2px 0 6px;
}

/* ── 头：运行中和跑完共用，只换文字不换元素，更新时不闪 ── */
.steps-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  padding: 3px 6px;
  cursor: pointer;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.steps-head:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.steps-icon {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background var(--transition-normal), color var(--transition-normal);
}
.steps-icon.success {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}
.steps-icon.error {
  background: var(--error-subtle);
  color: var(--error);
}
.steps-icon.running {
  color: var(--accent);
}
.steps-icon .tool-pulse {
  width: 7px;
  height: 7px;
}

.steps-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-13);
  font-family: var(--font-sans);
  color: var(--text-muted);
}
.steps-head:hover .steps-summary {
  color: var(--text-secondary);
}

/* 一道扫过文字的微光，比转圈安静 */
.steps-summary.steps-shimmer {
  background: linear-gradient(
    100deg,
    var(--text-muted) 0%,
    var(--text-muted) 38%,
    var(--text-primary) 50%,
    var(--text-muted) 62%,
    var(--text-muted) 100%
  );
  background-size: 240% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: steps-shimmer 2.2s linear infinite;
}

@keyframes steps-shimmer {
  from { background-position: 130% 0; }
  to { background-position: -30% 0; }
}

.steps-duration {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.steps-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}
.steps-chevron.open {
  transform: rotate(90deg);
}

/* ── 过程正文：0fr → 1fr 让开合有个高度过渡 ── */
.steps-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-normal);
}
.steps-collapse.open {
  grid-template-rows: 1fr;
}
.steps-collapse > * {
  min-height: 0;
  overflow: hidden;
}

/* 这层是 0fr 行轨里的格子项，只能有横向的 padding / border：纵向的压不掉，
   收起时会剩成一条缝（ToolCall.vue 里为此专门垫了一层 .tool-collapse-clip）。 */
.steps-body {
  padding-left: 14px;
  border-left: 1.5px solid var(--border-subtle);
  margin-left: 6px;
}

/* 组里的卡片退成列表行：挂在左侧细轨上表示层级，不再每张一个框。 */
.steps-body :deep(.tool-call) {
  background: transparent;
  border: 0;
  border-radius: 0;
  margin: 0;
}
.steps-body :deep(.tool-call-header) {
  padding: 4px 6px;
  border-radius: var(--radius-sm);
}
.steps-body :deep(.tool-call-header:hover) {
  background: var(--bg-secondary);
}
.steps-body :deep(.tool-call-body) {
  padding: 2px 6px 8px 22px;
  background: transparent;
  border-top: 0;
}

/* ── 过程中说的话 ── */
.narration {
  padding: 6px 6px 4px;
}
.narration :deep(.markdown-content) {
  font-size: var(--text-base);
  line-height: 1.65;
  color: var(--text-secondary);
}
.narration :deep(.markdown-content p) {
  margin-bottom: 0.4em;
}

/* ── Reasoning ── */
.reasoning-block {
  margin: 4px 6px 6px;
}

.reasoning-text {
  font-size: var(--text-sm);
  color: var(--text-muted);
  font-style: italic;
  white-space: pre-wrap;
  line-height: 1.55;
  word-break: break-word;
}

.reasoning-text.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.reasoning-toggle {
  font-size: var(--text-xs);
  color: var(--accent);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  margin-top: 2px;
  font-family: inherit;
  line-height: 1.8;
}
.reasoning-toggle:hover {
  text-decoration: underline;
}

/* ── Loading dots ── */
.loading-wave span {
  animation: wave 1.2s infinite ease-in-out;
  display: inline-block;
  margin: 0 1px;
  font-size: var(--text-lg);
  line-height: 10px;
  color: var(--text-muted);
}
.loading-wave span:nth-child(2) { animation-delay: 0.1s; }
.loading-wave span:nth-child(3) { animation-delay: 0.2s; }

@keyframes wave {
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-4px); opacity: 1; }
}
</style>
