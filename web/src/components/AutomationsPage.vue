<script setup lang="ts">
import { ref } from 'vue'
import { CalendarClock, Webhook } from 'lucide-vue-next'
import type { Session } from '../api/client'
import type { ProjectInfo } from './Sidebar.vue'
import SchedulesPage from './SchedulesPage.vue'
import WebhooksPage from './WebhooksPage.vue'

defineProps<{
  projects: ProjectInfo[]
}>()

const emit = defineEmits<{
  selectSession: [session: Session]
}>()

const activeTab = ref<'webhooks' | 'schedules'>('webhooks')
</script>

<template>
  <div class="automations-page">
    <header class="automations-header">
      <div>
        <h1>Automations</h1>
        <p>Project-bound triggers for unattended agent runs.</p>
      </div>
      <div class="automation-tabs" role="tablist" aria-label="Automation types">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'webhooks' }"
          role="tab"
          :aria-selected="activeTab === 'webhooks'"
          @click="activeTab = 'webhooks'"
        >
          <Webhook :size="16" />
          Webhooks
        </button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'schedules' }"
          role="tab"
          :aria-selected="activeTab === 'schedules'"
          @click="activeTab = 'schedules'"
        >
          <CalendarClock :size="16" />
          Schedules
        </button>
      </div>
    </header>

    <WebhooksPage
      v-if="activeTab === 'webhooks'"
      embedded
      :projects="projects"
      @select-session="emit('selectSession', $event)"
    />
    <SchedulesPage
      v-else
      :projects="projects"
      @select-session="emit('selectSession', $event)"
    />
  </div>
</template>

<style scoped>
.automations-page {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  padding: var(--space-lg);
  overflow: auto;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.automations-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
}

.automations-header h1 {
  margin: 0;
  font-size: 30px;
  font-weight: 650;
  line-height: 1.15;
}

.automations-header p {
  margin: var(--space-xs) 0 0;
  color: var(--text-muted);
  font-size: 14px;
}

.automation-tabs {
  display: inline-flex;
  gap: var(--space-xs);
  padding: 4px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
}

.tab-btn {
  height: 34px;
  padding: 0 var(--space-md);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.tab-btn.active {
  color: var(--text-primary);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-sm);
}

@media (max-width: 760px) {
  .automations-page {
    padding: var(--space-md);
  }

  .automations-header {
    display: grid;
  }

  .automation-tabs {
    width: 100%;
  }

  .tab-btn {
    flex: 1 1 0;
  }
}
</style>
