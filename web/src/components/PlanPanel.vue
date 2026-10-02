<script setup lang="ts">
import { computed } from 'vue'
import { X, ClipboardList } from 'lucide-vue-next'
import DOMPurify from 'dompurify'
import type { Message } from '../api/client'

const props = defineProps<{
  messages: Message[]
}>()

defineEmits<{
  close: []
}>()

// Extract plan content from AI messages
// Looks for messages containing [规划模式] or plan-related markers
const plans = computed(() => {
  const result: Array<{ content: string; timestamp?: number }> = []

  for (const msg of props.messages) {
    if (msg.info.role !== 'assistant') continue

    for (const part of msg.parts) {
      if (part.type === 'text' && part.text) {
        // Check if this message contains a plan
        if (part.text.includes('规划') || part.text.includes('计划') ||
            part.text.includes('Plan') || part.text.includes('步骤') ||
            part.text.includes('待办')) {
          result.push({
            content: part.text,
            timestamp: msg.info.time?.created
          })
        }
      }
    }
  }

  return result
})

// 换行转为 <br> 后用 DOMPurify 消毒，防止 AI 输出中的 HTML 注入
function formatPlanContent(content: string): string {
  return DOMPurify.sanitize(content.replace(/\n/g, '<br>'))
}
</script>

<template>
  <div class="plan-panel">
    <div class="plan-header">
      <div class="plan-title">
        <ClipboardList :size="16" />
        <span>计划参考</span>
      </div>
      <button class="plan-close" @click="$emit('close')">
        <X :size="16" />
      </button>
    </div>
    <div class="plan-content custom-scrollbar">
      <p class="plan-empty-hint">以下内容从回复中按关键词提取，仅供参考；不代表计划已获批准或执行权限已改变。</p>
      <template v-if="plans.length > 0">
        <div
          v-for="(plan, index) in plans"
          :key="index"
          class="plan-item"
        >
          <div class="plan-text" v-html="formatPlanContent(plan.content)"></div>
        </div>
      </template>
      <div v-else class="plan-empty">
        <ClipboardList :size="24" />
        <p>暂无计划</p>
        <p class="plan-empty-hint">在输入框启用「先规划」可请求 AI 先给出计划。这是提示词引导，不是只读执行模式。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-panel {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  max-height: 600px;
  overflow: hidden;
}

.plan-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.plan-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-13);
  font-weight: 600;
  color: var(--text-primary);
}

.plan-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.plan-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.plan-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-md);
}

.plan-item {
  padding: var(--space-sm);
  background: var(--bg-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

.plan-item + .plan-item {
  margin-top: var(--space-sm);
}

.plan-text {
  font-size: var(--text-13);
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}

.plan-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xl) var(--space-md);
  color: var(--text-muted);
  text-align: center;
}

.plan-empty p {
  margin: 0;
  font-size: var(--text-13);
}

.plan-empty-hint {
  font-size: var(--text-sm) !important;
  color: var(--text-muted);
  max-width: 240px;
}
</style>
