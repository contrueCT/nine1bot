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

// JSON 编辑模式
const editMode = ref<'form' | 'json'>('form')
const jsonInput = ref('')
const jsonError = ref('')

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
  editMode.value = 'form'
  jsonInput.value = ''
  jsonError.value = ''
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

// 验证 MCP 配置格式
function validateMcpConfig(config: any): string | null {
  // 验证 type 字段
  if (!config.type) {
    return '缺少必要字段: type'
  }
  if (config.type !== 'local' && config.type !== 'remote') {
    return 'type 必须是 "local" 或 "remote"'
  }

  // 验证 local 类型
  if (config.type === 'local') {
    if (!config.command) {
      return 'local 类型缺少必要字段: command'
    }
    if (!Array.isArray(config.command)) {
      return 'command 必须是字符串数组'
    }
    if (config.command.length === 0) {
      return 'command 数组不能为空'
    }
    if (!config.command.every((c: any) => typeof c === 'string')) {
      return 'command 数组中的元素必须是字符串'
    }

    // 验证 environment（可选）
    if (config.environment !== undefined) {
      if (typeof config.environment !== 'object' || config.environment === null || Array.isArray(config.environment)) {
        return 'environment 必须是对象'
      }
      for (const [key, value] of Object.entries(config.environment)) {
        if (typeof value !== 'string') {
          return `environment.${key} 的值必须是字符串`
        }
      }
    }
  }

  // 验证 remote 类型
  if (config.type === 'remote') {
    if (!config.url) {
      return 'remote 类型缺少必要字段: url'
    }
    if (typeof config.url !== 'string') {
      return 'url 必须是字符串'
    }
    // 简单的 URL 格式验证
    if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
      return 'url 必须以 http:// 或 https:// 开头'
    }

    // 验证 headers（可选）
    if (config.headers !== undefined) {
      if (typeof config.headers !== 'object' || config.headers === null || Array.isArray(config.headers)) {
        return 'headers 必须是对象'
      }
      for (const [key, value] of Object.entries(config.headers)) {
        if (typeof value !== 'string') {
          return `headers.${key} 的值必须是字符串`
        }
      }
    }
  }

  // 验证公共可选字段
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    return 'enabled 必须是布尔值'
  }
  if (config.timeout !== undefined) {
    if (typeof config.timeout !== 'number' || !Number.isInteger(config.timeout) || config.timeout <= 0) {
      return 'timeout 必须是正整数'
    }
  }

  // 检查是否有未知字段
  const localAllowedFields = ['type', 'command', 'environment', 'enabled', 'timeout']
  const remoteAllowedFields = ['type', 'url', 'headers', 'enabled', 'timeout', 'oauth']
  const allowedFields = config.type === 'local' ? localAllowedFields : remoteAllowedFields

  for (const key of Object.keys(config)) {
    if (!allowedFields.includes(key)) {
      return `未知字段: ${key}（${config.type} 类型允许的字段: ${allowedFields.join(', ')}）`
    }
  }

  return null // 验证通过
}

// 验证服务器名称
function validateServerName(name: string): string | null {
  if (!name || name.trim() === '') {
    return '服务器名称不能为空'
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return '服务器名称只能包含字母、数字、下划线和连字符'
  }
  if (name.length > 64) {
    return '服务器名称不能超过 64 个字符'
  }
  return null
}

// JSON 模式提交
function submitJson() {
  jsonError.value = ''

  try {
    // 尝试解析为 { "name": config } 格式
    const trimmed = jsonInput.value.trim()
    if (!trimmed) {
      jsonError.value = '请输入 MCP 配置'
      return
    }

    const wrapped = `{${trimmed}}`
    let parsed: any
    try {
      parsed = JSON.parse(wrapped)
    } catch (e: any) {
      jsonError.value = 'JSON 格式错误: ' + e.message
      return
    }

    const entries = Object.entries(parsed)
    if (entries.length === 0) {
      jsonError.value = '请输入 MCP 配置'
      return
    }
    if (entries.length > 1) {
      jsonError.value = '一次只能添加一个 MCP 配置'
      return
    }

    const [name, config] = entries[0] as [string, any]

    // 验证服务器名称
    const nameError = validateServerName(name)
    if (nameError) {
      jsonError.value = nameError
      return
    }

    // 验证配置格式
    const configError = validateMcpConfig(config)
    if (configError) {
      jsonError.value = configError
      return
    }

    emit('add', name, config)
    closeForm()
  } catch (e: any) {
    jsonError.value = '发生错误: ' + e.message
  }
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
        <p class="section-desc text-muted text-sm">全局 MCP 配置概览。每个项目可在对话中的 "+" 菜单独立控制 MCP 连接状态。</p>
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

      <!-- 模式切换 -->
      <div class="mode-switch">
        <button
          class="mode-btn"
          :class="{ active: editMode === 'form' }"
          @click="editMode = 'form'"
        >
          表单模式
        </button>
        <button
          class="mode-btn"
          :class="{ active: editMode === 'json' }"
          @click="editMode = 'json'"
        >
          JSON 模式
        </button>
      </div>

      <!-- 表单模式 -->
      <div v-if="editMode === 'form'" class="form-body">
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
            placeholder="例如: npx -y @modelcontextprotocol/server-filesystem /path"
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

      <!-- JSON 模式 -->
      <div v-if="editMode === 'json'" class="form-body">
        <div class="json-hint">
          输入 MCP 配置 JSON，格式: <code>"server-name": { "type": "local", "command": [...] }</code>
        </div>
        <div class="form-group">
          <textarea
            v-model="jsonInput"
            class="json-textarea"
            rows="10"
            placeholder='"my-server": {
  "type": "local",
  "command": ["npx", "-y", "@some/mcp-server"],
  "environment": {
    "API_KEY": "{env:SOME_API_KEY}"
  },
  "enabled": true
}'
          ></textarea>
        </div>
        <div v-if="jsonError" class="form-error">{{ jsonError }}</div>
      </div>

      <div class="form-footer">
        <button class="btn btn-ghost" @click="closeForm">取消</button>
        <button
          class="btn btn-primary"
          @click="editMode === 'json' ? submitJson() : submitForm()"
          :disabled="isSubmitting"
        >
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
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 0.5px solid var(--border-subtle);
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
  border: 0.5px solid var(--border-default);
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
  border-top: 0.5px solid var(--border-subtle);
  background: var(--bg-secondary);
}

/* 模式切换 */
.mode-switch {
  display: flex;
  padding: var(--space-sm) var(--space-md);
  gap: var(--space-xs);
  border-bottom: 0.5px solid var(--border-subtle);
}

.mode-btn {
  padding: var(--space-xs) var(--space-sm);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mode-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.mode-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

/* JSON 编辑 */
.json-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: var(--space-sm);
  line-height: 1.5;
}

.json-hint code {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
}

.json-textarea {
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  min-height: 200px;
  transition: border-color var(--transition-fast);
}

.json-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.json-textarea::placeholder {
  color: var(--text-muted);
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
  border-top: 0.5px solid var(--border-subtle);
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
