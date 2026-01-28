<script setup lang="ts">
import type { McpServer } from '../api/client'

defineProps<{
  servers: McpServer[]
  loading: boolean
}>()

const emit = defineEmits<{
  connect: [name: string]
  disconnect: [name: string]
}>()

function getStatusBadge(status: string) {
  switch (status) {
    case 'connected': return 'badge-success'
    case 'connecting': return 'badge-warning'
    case 'failed': return 'badge-error'
    case 'needs_auth': return 'badge-warning'
    case 'needs_client_registration': return 'badge-warning'
    case 'disabled': return 'badge-default'
    default: return 'badge-default'
  }
}

function getStatusText(status: string) {
  switch (status) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中'
    case 'disabled': return '已禁用'
    case 'failed': return '连接失败'
    case 'needs_auth': return '需要认证'
    case 'needs_client_registration': return '需要注册'
    default: return status
  }
}

// 判断是否可以连接
function canConnect(status: string) {
  return status === 'disabled' || status === 'failed'
}
</script>

<template>
  <div class="mcp-manager">
    <div class="section-header">
      <h3 class="section-title">MCP 服务器</h3>
      <p class="section-desc text-muted text-sm">管理 Model Context Protocol 服务器连接</p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="servers.length === 0" class="empty-state">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
      </div>
      <p class="empty-state-title">暂无 MCP 服务器</p>
      <p class="empty-state-description">配置 MCP 服务器以扩展 AI 能力</p>
    </div>

    <div v-else class="list">
      <div v-for="server in servers" :key="server.name" class="list-item">
        <div class="list-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <path d="M8 21h8M12 17v4"/>
          </svg>
        </div>
        <div class="list-item-content">
          <div class="list-item-title">{{ server.name }}</div>
          <div class="list-item-meta">
            <span class="badge" :class="getStatusBadge(server.status)">
              {{ getStatusText(server.status) }}
            </span>
            <span v-if="server.tools?.length" class="text-muted text-xs">
              {{ server.tools.length }} 工具
            </span>
          </div>
          <div v-if="server.error" class="error-text text-xs">
            {{ server.error }}
          </div>
        </div>
        <div class="list-item-actions">
          <button
            v-if="canConnect(server.status)"
            class="btn btn-secondary"
            @click="emit('connect', server.name)"
          >
            连接
          </button>
          <button
            v-else-if="server.status === 'connected'"
            class="btn btn-ghost"
            @click="emit('disconnect', server.name)"
          >
            断开
          </button>
          <button
            v-else-if="server.status === 'needs_auth'"
            class="btn btn-secondary"
            @click="emit('connect', server.name)"
          >
            认证
          </button>
          <div v-else-if="server.status === 'connecting'" class="loading-spinner"></div>
        </div>
      </div>
    </div>

    <!-- Tools List -->
    <template v-for="server in servers.filter(s => s.status === 'connected' && s.tools?.length)" :key="`tools-${server.name}`">
      <div class="tools-section">
        <h4 class="tools-title text-sm text-muted">{{ server.name }} 工具</h4>
        <div class="tools-grid">
          <div v-for="tool in server.tools" :key="tool.name" class="tool-card">
            <div class="tool-name font-mono text-sm">{{ tool.name }}</div>
            <div v-if="tool.description" class="tool-desc text-xs text-muted">{{ tool.description }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mcp-manager {
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

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-xl);
}

.list-item-meta {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-xs);
}

.error-text {
  color: var(--error);
  margin-top: var(--space-xs);
}

.tools-section {
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
}

.tools-title {
  margin-bottom: var(--space-sm);
  font-weight: 500;
}

.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-sm);
}

.tool-card {
  padding: var(--space-sm);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
}

.tool-name {
  margin-bottom: 2px;
}

.tool-desc {
  line-height: 1.4;
}
</style>
