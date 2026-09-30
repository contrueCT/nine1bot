<script setup lang="ts">
import { Bug, FileText, FlaskConical, FolderTree } from 'lucide-vue-next'

const emit = defineEmits<{
  select: [prompt: string]
}>()

/* 起手任务都落在「当前工作目录」上，和空态的目录标题是同一件事。
   点选只填进输入框，不直接发送：用户往往要补一句具体要求。 */
const starters = [
  { icon: FolderTree, label: '梳理项目结构', prompt: '梳理这个目录的结构，说明入口文件、主要模块和它们之间的关系。' },
  { icon: Bug, label: '找出并修复问题', prompt: '检查这个项目里最可能出问题的地方，找出一个具体的 bug 并修复，说明原因。' },
  { icon: FlaskConical, label: '补上测试', prompt: '找出缺少测试的关键逻辑，补上单元测试并运行，汇报结果。' },
  { icon: FileText, label: '起草说明文档', prompt: '根据现有代码起草一份 README：用途、安装、运行方式和目录说明。' },
]
</script>

<template>
  <div class="prompt-categories-wrapper">
    <ul class="starter-list">
      <li v-for="starter in starters" :key="starter.label">
        <button type="button" class="starter" :title="starter.prompt" @click="emit('select', starter.prompt)">
          <component :is="starter.icon" :size="15" aria-hidden="true" />
          <span>{{ starter.label }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.prompt-categories-wrapper {
  width: 100%;
  max-width: var(--input-max-width);
  margin: 0 auto;
  padding: var(--space-sm) 0 var(--space-lg);
}

.starter-list {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-xs);
}

.starter {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--text-13);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.starter svg {
  flex-shrink: 0;
  color: var(--text-muted);
}

.starter span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.starter:hover {
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.starter:hover svg {
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .starter-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
