<script setup lang="ts">
import type { Skill } from '../api/client'

defineProps<{
  skills: Skill[]
  loading: boolean
}>()
</script>

<template>
  <div class="skills-list">
    <div class="section-header">
      <h3 class="section-title">可用技能</h3>
      <p class="section-desc text-muted text-sm">AI 可以使用的内置和插件技能</p>
      <div class="skill-hint">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 16v-4M12 8h.01"/>
        </svg>
        <span>需要安装网上的技能？在聊天中发送技能链接，让 Nine1Bot 帮你安装</span>
      </div>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="skills.length === 0" class="empty-state">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
      </div>
      <p class="empty-state-title">暂无可用技能</p>
      <p class="empty-state-description">在聊天中发送技能仓库链接，让 Nine1Bot 帮你安装</p>
    </div>

    <div v-else class="skills-grid">
      <div v-for="skill in skills" :key="skill.name" class="skill-card card">
        <div class="card-body">
          <div class="skill-header">
            <div class="skill-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
            </div>
            <span class="badge" :class="skill.source === 'builtin' ? 'badge-info' : 'badge-accent'">
              {{ skill.source === 'builtin' ? '内置' : '插件' }}
            </span>
          </div>
          <div class="skill-name">{{ skill.name }}</div>
          <div v-if="skill.description" class="skill-desc text-sm text-muted">
            {{ skill.description }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skills-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.section-header {
  margin-bottom: var(--space-sm);
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.section-desc {
  margin: 0;
}

.skill-hint {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.skill-hint svg {
  flex-shrink: 0;
  color: var(--accent);
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-xl);
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-md);
}

.skill-card .card-body {
  padding: var(--space-md);
}

.skill-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
}

.skill-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  color: var(--text-muted);
}

.skill-name {
  font-weight: 500;
  margin-bottom: var(--space-xs);
}

.skill-desc {
  line-height: 1.4;
}
</style>
