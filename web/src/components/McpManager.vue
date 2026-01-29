<script setup lang="ts">
import { ref } from 'vue'
import type { McpServer, McpConfig } from '../api/client'

defineProps<{
  servers: McpServer[]
  loading: boolean
}>()

const emit = defineEmits<{
  connect: [name: string]
  disconnect: [name: string]
  add: [name: string, config: McpConfig]
  remove: [name: string]
}>()

// 表单状态
const showForm = ref(false)
const formName = ref('')
const formType = ref<'local' | 'remote'>('local')
const formCommand = ref('')
const formUrl = ref('')
const formError = ref('')
const isSubmitting = ref(false)

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

function canConnect(status: string) {
  return status === 'disabled' || status === 'failed'
}

function resetForm() {
  formName.value = ''
  formType.value = 'local'
  formCommand.value = ''
  formUrl.value = ''
  formError.value = ''
}

function openForm() {
  resetForm()
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  resetForm()
}

async function submitForm() {
  formError.value = ''

  if (!formName.value.trim()) {
    formError.value = '请输入服务器名称'
    return
  }

  if (formType.value === 'local' && !formCommand.value.trim()) {
    formError.value = '请输入命令'
    return
  }

  if (formType.value === 'remote' && !formUrl.value.trim()) {
    formError.value = '请输入 URL'
    return
  }

  isSubmitting.value = true

  try {
    let config: McpConfig
    if (formType.value === 'local') {
      // 解析命令行，支持引号
      const command = parseCommand(formCommand.value)
      config = {
        type: 'local',
        command,
        enabled: true
      }
    } else {
      config = {
        type: 'remote',
        url: formUrl.value.trim(),
        enabled: true
      }
    }

    emit('add', formName.value.trim(), config)
    closeForm()
  } catch (e: any) {
    formError.value = e.message || '添加失败'
  } finally {
    isSubmitting.value = false
  }
}

// 解析命令行字符串为数组
function parseCommand(cmd: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true
      quoteChar = char
    } else if (char === quoteChar && inQuote) {
      inQuote = false
      quoteChar = ''
    } else if (char === ' ' && !inQuote) {
      if (current) {
        result.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    result.push(current)
  }

  return result
}

function confirmRemove(name: string) {
  if (confirm(`确定要删除 MCP 服务器 "${name}" 吗？`)) {
    emit('remove', name)
  }
}
</script>

<template>
  <div class="mcp-manager">
    <div class="section-header">
      <div class="section-header-left">
        <h3 class="section-title">MCP 服务器</h3>
        <p class="section-desc text-muted text-sm">管理 Model Context Protocol 服务器连接</p>
      </div>
      <button class="btn btn-primary btn-sm" @click="openForm" v-if="!showForm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        添加
      </button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showForm" class="add-form">
      <div class="form-header">
        <span class="form-title">添加新服务器</span>
        <button class="btn-icon" @click="closeForm" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="form-body">
        <div class="form-group">
          <label class="form-label">名称</label>
          <input
            type="text"
            class="form-input"
            v-model="formName"
            placeholder="例如: filesystem"
            @keyup.enter="submitForm"
          />
        </div>

        <div class="form-group">
          <label class="form-label">类型</label>
          <div class="radio-group">
            <label class="radio-item">
              <input type="radio" v-model="formType" value="local" />
              <span>本地</span>
            </label>
            <label class="radio-item">
              <input type="radio" v-model="formType" value="remote" />
              <span>远程</span>
            </label>
          </div>
        </div>

        <div class="form-group" v-if="formType === 'local'">
          <label class="form-label">命令</label>
          <input
            type="text"
            class="form-input"
            v-model="formCommand"
            placeholder="例如: npx -y @anthropic-ai/mcp-server-filesystem /path"
            @keyup.enter="submitForm"
          />
          <span class="form-hint">完整命令行，空格分隔参数</span>
        </div>

        <div class="form-group" v-if="formType === 'remote'">
          <label class="form-label">URL</label>
          <input
            type="text"
            class="form-input"
            v-model="formUrl"
            placeholder="例如: https://mcp.example.com/sse"
            @keyup.enter="submitForm"
          />
        </div>

        <div v-if="formError" class="form-error">{{ formError }}</div>
      </div>

      <div class="form-footer">
        <button class="btn btn-ghost" @click="closeForm">取消</button>
        <button class="btn btn-primary" @click="submitForm" :disabled="isSubmitting">
          {{ isSubmitting ? '添加中...' : '添加服务器' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="servers.length === 0 && !showForm" class="empty-state">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
      </div>
      <p class="empty-state-title">暂无 MCP 服务器</p>
      <p class="empty-state-description">点击上方"添加"按钮配置 MCP 服务器</p>
    </div>

    <div v-else-if="servers.length > 0" class="list">
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
            class="btn btn-secondary btn-sm"
            @click="emit('connect', server.name)"
          >
            连接
          </button>
          <button
            v-else-if="server.status === 'connected'"
            class="btn btn-ghost btn-sm"
            @click="emit('disconnect', server.name)"
          >
            断开
          </button>
          <button
            v-else-if="server.status === 'needs_auth'"
            class="btn btn-secondary btn-sm"
            @click="emit('connect', server.name)"
          >
            认证
          </button>
          <div v-else-if="server.status === 'connecting'" class="loading-spinner"></div>

          <button
            class="btn btn-ghost btn-sm btn-danger"
            @click="confirmRemove(server.name)"
            title="删除"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
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
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
}

.section-header-left {
  flex: 1;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.section-desc {
  margin: 0;
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-xl);
}

/* 添加表单样式 */
.add-form {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
}

.form-title {
  font-weight: 500;
  font-size: 14px;
}

.btn-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-icon:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.form-body {
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.form-input {
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color var(--transition-fast);
}

.form-input:focus {
  outline: none;
  border-color: var(--accent);
}

.form-input::placeholder {
  color: var(--text-muted);
}

.form-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.form-error {
  color: var(--error);
  font-size: 13px;
  padding: var(--space-sm);
  background: rgba(239, 68, 68, 0.1);
  border-radius: var(--radius-sm);
}

.radio-group {
  display: flex;
  gap: var(--space-md);
}

.radio-item {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  cursor: pointer;
  font-size: 14px;
}

.radio-item input {
  accent-color: var(--accent);
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
}

.list-item-meta {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-xs);
}

.list-item-actions {
  display: flex;
  gap: var(--space-xs);
  align-items: center;
}

.btn-danger {
  color: var(--text-muted);
}

.btn-danger:hover {
  color: var(--error);
  background: rgba(239, 68, 68, 0.1);
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
