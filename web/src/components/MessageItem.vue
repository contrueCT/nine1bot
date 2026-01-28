<script setup lang="ts">
import { computed } from 'vue'
import type { Message, MessagePart } from '../api/client'
import ToolCall from './ToolCall.vue'

const props = defineProps<{
  message: Message
}>()

// 获取所有需要显示的部分，按顺序排列
const displayParts = computed(() => {
  const result: Array<{ type: string; part: MessagePart; index: number }> = []
  props.message.parts.forEach((part, index) => {
    if (part.type === 'text' && part.text) {
      result.push({ type: 'text', part, index })
    } else if (part.type === 'tool') {
      result.push({ type: 'tool', part, index })
    } else if (part.type === 'reasoning') {
      // 始终显示 reasoning 部分（即使文本为空，也显示 "Thinking" 标题）
      result.push({ type: 'reasoning', part, index })
    }
  })
  return result
})

const roleLabel = computed(() => {
  return props.message.role === 'user' ? '你' : 'Agent'
})
</script>

<template>
  <div class="message" :class="message.role">
    <div class="message-header">
      <span class="role-label">{{ roleLabel }}</span>
    </div>

    <div class="message-content">
      <!-- 按顺序显示所有部分 -->
      <template v-for="item in displayParts" :key="item.part.id || item.index">
        <!-- 思考过程 -->
        <div v-if="item.type === 'reasoning'" class="reasoning-content">
          <div class="reasoning-header">Thinking</div>
          <div v-if="item.part.text" class="reasoning-text">{{ item.part.text }}</div>
          <div v-else class="reasoning-text thinking-dots">
            <span></span><span></span><span></span>
          </div>
        </div>

        <!-- 工具调用 -->
        <ToolCall
          v-else-if="item.type === 'tool'"
          :tool="item.part"
        />

        <!-- 文本内容 -->
        <div v-else-if="item.type === 'text'" class="text-content" v-html="formatText(item.part.text || '')"></div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
// 格式化文本，简单处理换行和代码块
function formatText(text: string): string {
  // 转义 HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // 代码块
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="code-block"><code class="language-${lang}">${code.trim()}</code></pre>`
  })

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')

  // 换行
  html = html.replace(/\n/g, '<br>')

  return html
}
</script>

<style scoped>
.message {
  padding: 14px 18px;
  border-radius: 12px;
  background: var(--bg-secondary);
  animation: fadeIn 0.2s ease-out;
  box-shadow: var(--shadow-sm);
}

.message.user {
  background: var(--bg-tertiary);
  margin-left: 48px;
  border: 1px solid var(--border-subtle);
}

.message.assistant {
  margin-right: 48px;
  border: 1px solid var(--border-color);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.role-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.message-content {
  font-size: 14px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.text-content {
  white-space: pre-wrap;
  word-break: break-word;
}

.text-content :deep(.code-block) {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
  overflow-x: auto;
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
  font-size: 13px;
}

.text-content :deep(.inline-code) {
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
  font-size: 13px;
}

.reasoning-content {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
}

.reasoning-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.reasoning-text {
  color: var(--text-secondary);
  font-style: italic;
  white-space: pre-wrap;
}

.thinking-dots {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}

.thinking-dots span {
  width: 6px;
  height: 6px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: dotPulse 1.4s infinite ease-in-out both;
}

.thinking-dots span:nth-child(1) {
  animation-delay: -0.32s;
}

.thinking-dots span:nth-child(2) {
  animation-delay: -0.16s;
}

.thinking-dots span:nth-child(3) {
  animation-delay: 0s;
}

@keyframes dotPulse {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
