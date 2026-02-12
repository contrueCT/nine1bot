<script setup lang="ts">
import { X, ClipboardList } from 'lucide-vue-next'
import type { Message } from '../api/client'

const props = defineProps<{
  messages: Message[]
}>()

defineEmits<{
  close: []
}>()

// Extract plan content from AI messages
// Looks for messages containing [规划模式] or plan-related markers
function extractPlans(): Array<{ content: string; timestamp?: number }> {
  const plans: Array<{ content: string; timestamp?: number }> = []

  for (const msg of props.messages) {
    if (msg.info.role !== 'assistant') continue

    for (const part of msg.parts) {
      if (part.type === 'text' && part.text) {
        // Check if this message contains a plan
        if (part.text.includes('规划') || part.text.includes('计划') ||
            part.text.includes('Plan') || part.text.includes('步骤') ||
            part.text.includes('待办')) {
          plans.push({
            content: part.text,
            timestamp: msg.info.time?.created
          })
        }
      }
    }
  }

  return plans
}
</script>

<template>
  <div class="plan-panel">
    <div class="plan-header">
      <div class="plan-title">
        <ClipboardList :size="16" />
        <span>Plan</span>
      </div>
      <button class="plan-close" @click="$emit('close')">
        <X :size="16" />
      </button>
    </div>
    <div class="plan-content custom-scrollbar">
      <template v-if="extractPlans().length > 0">
        <div
          v-for="(plan, index) in extractPlans()"
          :key="index"
          class="plan-item"
        >
          <div class="plan-text" v-html="plan.content.replace(/\n/g, '<br>')"></div>
        </div>
      </template>
      <div v-else class="plan-empty">
        <ClipboardList :size="24" />
        <p>No plans yet</p>
        <p class="plan-empty-hint">Use Plan mode in the + menu to have the AI create an execution plan before taking action.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-panel {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
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
  border-bottom: 0.5px solid var(--border-subtle);
  flex-shrink: 0;
}

.plan-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
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
  border: 0.5px solid var(--border-subtle);
}

.plan-item + .plan-item {
  margin-top: var(--space-sm);
}

.plan-text {
  font-size: 13px;
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
  font-size: 13px;
}

.plan-empty-hint {
  font-size: 12px !important;
  color: var(--text-muted);
  max-width: 240px;
}
</style>
