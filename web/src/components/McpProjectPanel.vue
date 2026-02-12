<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { X, Server, Loader2, Plug, Unplug, Plus } from 'lucide-vue-next'
import { mcpApi } from '../api/client'
import type { McpServer, McpConfig } from '../api/client'

defineProps<{
  currentDirectory?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const servers = ref<McpServer[]>([])
const loading = ref(false)

// Add form state
const showAddForm = ref(false)
const formName = ref('')
const formType = ref<'local' | 'remote'>('local')
const formCommand = ref('')
const formUrl = ref('')
const formError = ref('')
const isSubmitting = ref(false)

async function loadServers() {
  loading.value = true
  try {
    servers.value = await mcpApi.list()
  } catch (e) {
    console.error('Failed to load MCP servers:', e)
  } finally {
    loading.value = false
  }
}

async function connectServer(name: string) {
  try {
    await mcpApi.connect(name)
    await loadServers()
  } catch (e) {
    console.error('Failed to connect MCP server:', e)
  }
}

async function disconnectServer(name: string) {
  try {
    await mcpApi.disconnect(name)
    await loadServers()
  } catch (e) {
    console.error('Failed to disconnect MCP server:', e)
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'connected': return 'var(--success)'
    case 'connecting': return 'var(--warning, #f59e0b)'
    case 'failed': return 'var(--error)'
    default: return 'var(--text-muted)'
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting...'
    case 'disabled': return 'Disconnected'
    case 'failed': return 'Failed'
    case 'needs_auth': return 'Auth Required'
    default: return status
  }
}

function canConnect(status: string): boolean {
  return status === 'disabled' || status === 'failed'
}

// Parse command string to array
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
      if (current) { result.push(current); current = '' }
    } else {
      current += char
    }
  }
  if (current) result.push(current)
  return result
}

function resetForm() {
  formName.value = ''
  formType.value = 'local'
  formCommand.value = ''
  formUrl.value = ''
  formError.value = ''
}

function toggleAddForm() {
  showAddForm.value = !showAddForm.value
  if (!showAddForm.value) resetForm()
}

async function submitAdd() {
  formError.value = ''
  if (!formName.value.trim()) { formError.value = '请输入名称'; return }

  let config: McpConfig
  if (formType.value === 'local') {
    if (!formCommand.value.trim()) { formError.value = '请输入命令'; return }
    config = { type: 'local', command: parseCommand(formCommand.value), enabled: true }
  } else {
    if (!formUrl.value.trim()) { formError.value = '请输入 URL'; return }
    config = { type: 'remote', url: formUrl.value.trim(), enabled: true }
  }

  isSubmitting.value = true
  try {
    await mcpApi.add(formName.value.trim(), config)
    await mcpApi.connect(formName.value.trim())
    await loadServers()
    showAddForm.value = false
    resetForm()
  } catch (e: any) {
    formError.value = e.message || '添加失败'
  } finally {
    isSubmitting.value = false
  }
}

onMounted(loadServers)
</script>

<template>
  <div class="mcp-project-panel">
    <div class="mcp-panel-header">
      <div class="mcp-panel-title-row">
        <Server :size="16" />
        <span class="mcp-panel-title">MCP Servers</span>
      </div>
      <div class="mcp-panel-header-actions">
        <button class="mcp-panel-btn" @click="toggleAddForm" :title="showAddForm ? '取消' : '添加服务器'">
          <Plus v-if="!showAddForm" :size="16" />
          <X v-else :size="16" />
        </button>
        <button class="mcp-panel-btn" @click="emit('close')">
          <X :size="16" />
        </button>
      </div>
    </div>

    <div v-if="currentDirectory" class="mcp-panel-directory">
      <span class="mcp-dir-label">Directory:</span>
      <span class="mcp-dir-path">{{ currentDirectory }}</span>
    </div>

    <!-- Add Server Form -->
    <div v-if="showAddForm" class="mcp-add-form">
      <div class="mcp-form-row">
        <input
          v-model="formName"
          type="text"
          class="mcp-form-input"
          placeholder="服务器名称"
          @keyup.enter="submitAdd"
        />
      </div>
      <div class="mcp-form-type">
        <label class="mcp-radio">
          <input type="radio" v-model="formType" value="local" />
          <span>本地</span>
        </label>
        <label class="mcp-radio">
          <input type="radio" v-model="formType" value="remote" />
          <span>远程</span>
        </label>
      </div>
      <div class="mcp-form-row">
        <input
          v-if="formType === 'local'"
          v-model="formCommand"
          type="text"
          class="mcp-form-input"
          placeholder="命令，如: npx -y @modelcontextprotocol/server-filesystem /path"
          @keyup.enter="submitAdd"
        />
        <input
          v-else
          v-model="formUrl"
          type="text"
          class="mcp-form-input"
          placeholder="URL，如: https://mcp.example.com/sse"
          @keyup.enter="submitAdd"
        />
      </div>
      <div v-if="formError" class="mcp-form-error">{{ formError }}</div>
      <div class="mcp-form-actions">
        <button class="mcp-form-cancel" @click="toggleAddForm">取消</button>
        <button class="mcp-form-submit" @click="submitAdd" :disabled="isSubmitting">
          {{ isSubmitting ? '添加中...' : '添加并连接' }}
        </button>
      </div>
    </div>

    <div class="mcp-panel-body">
      <div v-if="loading" class="mcp-loading">
        <Loader2 :size="16" class="spin" />
        <span>Loading...</span>
      </div>

      <div v-else-if="servers.length === 0 && !showAddForm" class="mcp-empty">
        <Server :size="24" />
        <span>No MCP servers configured</span>
        <p class="mcp-empty-hint">点击 "+" 添加服务器，或在 Settings → MCP 中管理</p>
      </div>

      <div v-else class="mcp-server-list">
        <div v-for="server in servers" :key="server.name" class="mcp-server-item">
          <div class="mcp-server-status">
            <div class="status-dot" :style="{ background: getStatusColor(server.status) }"></div>
          </div>
          <div class="mcp-server-info">
            <span class="mcp-server-name">{{ server.name }}</span>
            <span class="mcp-server-status-text">{{ getStatusText(server.status) }}</span>
          </div>
          <div class="mcp-server-action">
            <button
              v-if="canConnect(server.status)"
              class="mcp-action-btn connect"
              @click="connectServer(server.name)"
              title="Connect"
            >
              <Plug :size="14" />
            </button>
            <button
              v-else-if="server.status === 'connected'"
              class="mcp-action-btn disconnect"
              @click="disconnectServer(server.name)"
              title="Disconnect"
            >
              <Unplug :size="14" />
            </button>
            <Loader2 v-else-if="server.status === 'connecting'" :size="14" class="spin" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mcp-project-panel {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  max-height: 480px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: panelIn 0.15s ease-out;
}

@keyframes panelIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.mcp-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 0.5px solid var(--border-subtle);
}

.mcp-panel-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}

.mcp-panel-title {
  font-size: 14px;
  font-weight: 600;
}

.mcp-panel-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mcp-panel-btn {
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

.mcp-panel-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.mcp-panel-directory {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px var(--space-md);
  background: var(--bg-primary);
  border-bottom: 0.5px solid var(--border-subtle);
  font-size: 12px;
}

.mcp-dir-label {
  color: var(--text-muted);
}

.mcp-dir-path {
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Add Form */
.mcp-add-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-bottom: 0.5px solid var(--border-subtle);
  background: var(--bg-primary);
}

.mcp-form-row {
  width: 100%;
}

.mcp-form-input {
  width: 100%;
  padding: 6px 10px;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-composer);
  color: var(--text-primary);
  font-size: 13px;
  font-family: var(--font-sans);
  outline: none;
  transition: border-color var(--transition-fast);
}

.mcp-form-input:focus {
  border-color: var(--accent);
}

.mcp-form-input::placeholder {
  color: var(--text-muted);
}

.mcp-form-type {
  display: flex;
  gap: var(--space-md);
}

.mcp-radio {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.mcp-radio input {
  accent-color: var(--accent);
}

.mcp-form-error {
  font-size: 12px;
  color: var(--error);
  padding: 4px 8px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: var(--radius-sm);
}

.mcp-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-xs);
}

.mcp-form-cancel,
.mcp-form-submit {
  padding: 4px 12px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mcp-form-cancel {
  background: transparent;
  color: var(--text-muted);
}

.mcp-form-cancel:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.mcp-form-submit {
  background: var(--accent);
  color: white;
  font-weight: 500;
}

.mcp-form-submit:hover:not(:disabled) {
  opacity: 0.9;
}

.mcp-form-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mcp-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-xs);
}

.mcp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--space-xl);
  color: var(--text-muted);
  font-size: 13px;
}

.mcp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: var(--space-xl);
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

.mcp-empty-hint {
  font-size: 12px;
  opacity: 0.7;
  margin: 0;
}

.mcp-server-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcp-server-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.mcp-server-item:hover {
  background: var(--bg-tertiary);
}

.mcp-server-status {
  flex-shrink: 0;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.mcp-server-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.mcp-server-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-server-status-text {
  font-size: 11px;
  color: var(--text-muted);
}

.mcp-server-action {
  flex-shrink: 0;
}

.mcp-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mcp-action-btn.connect {
  color: var(--text-muted);
}

.mcp-action-btn.connect:hover {
  background: rgba(34, 197, 94, 0.1);
  color: var(--success);
}

.mcp-action-btn.disconnect {
  color: var(--text-muted);
}

.mcp-action-btn.disconnect:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--error);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
