<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Trash2, Edit2, Check, X, Globe } from 'lucide-vue-next'
import { usePreferences } from '../composables/usePreferences'

const {
  globalPreferences,
  projectPreferences,
  unresolvedPreferences,
  directory,
  assignPreference,
  loading,
  error,
  editingId,
  editingContent,
  loadPreferences,
  addPreference,
  deletePreference,
  startEdit,
  cancelEdit,
  saveEdit,
  formatTime,
  isAmbiguous
} = usePreferences()

// 新增偏好的输入
const newContent = ref('')
const scope = ref<'global' | 'project'>('global')
const sections = computed(() => [
  { id: 'global', label: '全局偏好', items: globalPreferences.value },
  { id: 'project', label: '当前项目偏好', items: projectPreferences.value },
  { id: 'unresolved', label: '未分配的历史项目偏好', items: unresolvedPreferences.value },
])
const total = computed(() => sections.value.reduce((sum, section) => sum + section.items.length, 0))

// 添加偏好
async function handleAdd() {
  if (loading.value || !newContent.value.trim()) return
  const content = newContent.value
  const saved = await addPreference(content, scope.value)
  if (saved && newContent.value === content) newContent.value = ''
}

// 删除确认
const deletingId = ref<string | null>(null)

function handleDelete(id: string) {
  if (!loading.value && !isAmbiguous(id)) deletingId.value = id
}

async function confirmDelete() {
  if (loading.value || !deletingId.value) return
  if (await deletePreference(deletingId.value)) deletingId.value = null
}

// 初始加载
onMounted(() => {
  loadPreferences()
})
</script>

<template>
  <div class="preferences-panel">
    <!-- 头部说明 -->
    <div class="panel-header">
      <p class="description">
        全局偏好适用于所有项目，项目偏好只适用于下面显示的项目。修改在后续对话轮次生效。
      </p>
      <p v-if="directory" class="description">当前项目：{{ directory }}</p>
      <button class="btn btn-ghost btn-sm" :disabled="loading || !!newContent.trim() || !!editingId || !!deletingId" @click="loadPreferences()">重新加载当前项目</button>
    </div>

    <!-- 添加新偏好 -->
    <div class="add-section">
      <div class="add-input-row">
        <textarea
          v-model="newContent"
          placeholder="输入新的偏好，例如：使用简洁的代码风格..."
          class="add-input"
          rows="2"
          maxlength="4096"
          :disabled="loading || !directory"
          @keydown.enter.ctrl="handleAdd"
        />
      </div>
      <div class="add-actions">
        <div class="scope-label">
          <Globe :size="14" />
          <select v-model="scope" aria-label="偏好作用域" :disabled="loading || !directory">
            <option value="global">全局偏好</option>
            <option value="project">当前项目偏好</option>
          </select>
        </div>
        <button
          class="add-btn"
          :disabled="!newContent.trim() || loading || !directory"
          @click="handleAdd"
        >
          <Plus :size="16" />
          <span>添加偏好</span>
        </button>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="error-message">
      {{ error }}
    </div>

    <!-- 偏好列表 -->
    <div class="preferences-list">
      <!-- 空状态 -->
      <div v-if="!loading && total === 0" class="empty-state">
        <p>还没有设置任何偏好</p>
        <p class="hint">添加偏好后，AI 会在对话中自动遵循</p>
      </div>

      <!-- 加载状态 -->
      <div v-else-if="loading && total === 0" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <!-- 全局偏好 -->
      <div v-for="section in sections.filter(item => item.items.length)" :key="section.id" class="preferences-section">
        <h3 class="section-title">
          <Globe :size="14" />
          <span>{{ section.label }}</span>
          <span class="count">{{ section.items.length }}</span>
        </h3>
        <p v-if="section.id === 'unresolved'" class="description">
          这些历史记录缺少项目归属，已保留但不会应用于任何项目。请确认内容属于上方项目后再分配。
        </p>
        <div class="preference-items">
          <div
            v-for="(pref, index) in section.items"
            :key="`${pref.id}:${index}`"
            class="preference-item"
          >
            <!-- 编辑模式 -->
            <template v-if="editingId === pref.id">
              <textarea
                v-model="editingContent"
                class="edit-input"
                rows="2"
                maxlength="4096"
                :disabled="loading"
                @keydown.enter.ctrl="saveEdit"
                @keydown.escape="cancelEdit"
              />
              <div class="item-actions">
                <button :disabled="loading || !editingContent.trim()" class="action-btn save" @click="saveEdit" title="保存">
                  <Check :size="14" />
                </button>
                <button :disabled="loading" class="action-btn cancel" @click="cancelEdit" title="取消">
                  <X :size="14" />
                </button>
              </div>
            </template>
            <!-- 显示模式 -->
            <template v-else>
              <div class="item-content">
                <p class="content-text">{{ pref.content }}</p>
                <p v-if="isAmbiguous(pref.id)" class="error-message" role="alert">
                  ID 冲突，已禁用修改和删除。请在源文件中为重复记录设置不同 ID 后重新加载。
                  <span v-if="pref.origin">源文件：{{ pref.origin }}</span>
                </p>
                <div class="item-meta">
                  <span class="source">{{ pref.source === 'ai' ? 'AI 添加' : '手动添加' }}</span>
                  <span class="time">{{ formatTime(pref.createdAt) }}</span>
                </div>
              </div>
              <div class="item-actions">
                <button class="btn btn-ghost btn-sm" v-if="section.id === 'unresolved'" :disabled="loading || isAmbiguous(pref.id)" @click="assignPreference(pref.id)">分配到当前项目</button>
                <button :disabled="loading || isAmbiguous(pref.id)" class="action-btn edit" @click="startEdit(pref)" title="编辑">
                  <Edit2 :size="14" />
                </button>
                <button :disabled="loading || isAmbiguous(pref.id)" class="action-btn delete" @click="handleDelete(pref.id)" title="删除">
                  <Trash2 :size="14" />
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认对话框 -->
    <Teleport to="body">
      <div v-if="deletingId" class="dialog-overlay" @click="!loading && (deletingId = null)">
        <div class="dialog" @click.stop>
          <div class="dialog-header">
            <span>删除偏好</span>
            <button class="action-btn" @click="!loading && (deletingId = null)">
              <X :size="16" />
            </button>
          </div>
          <div class="dialog-body">
            <p v-if="error" role="alert" class="error-message">{{ error }}</p>
            <p class="dialog-message">确定要删除这条偏好吗？</p>
            <p class="dialog-warning">此操作不可撤销。</p>
          </div>
          <div class="dialog-footer">
            <button class="btn btn-ghost btn-sm" @click="!loading && (deletingId = null)">取消</button>
            <button :disabled="loading" class="btn btn-danger btn-sm" @click="confirmDelete">
              <Trash2 :size="14" />
              删除
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.preferences-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  height: 100%;
  overflow-y: auto;
}

.panel-header {
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--border-subtle);
}

.description {
  font-size: var(--text-13);
  color: var(--text-muted);
  margin: 0;
}

/* 添加区域 */
.add-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.add-input-row {
  width: 100%;
}

.add-input {
  width: 100%;
  padding: var(--space-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--text-13);
  resize: vertical;
  min-height: 60px;
}

.add-input:focus {
  outline: none;
  border-color: var(--accent);
}

.add-input::placeholder {
  color: var(--text-muted);
}

.add-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.scope-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.add-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  font-size: var(--text-13);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.add-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 错误提示 */
.error-message {
  padding: var(--space-sm) var(--space-md);
  background: var(--error-subtle);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-radius: var(--radius-sm);
  color: var(--error);
  font-size: var(--text-13);
}

/* 偏好列表 */
.preferences-list {
  flex: 1;
  overflow-y: auto;
}

/* .empty-state 使用全局样式（style.css），此处仅补充列表内布局 */
.loading-state {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding: var(--space-xl);
  color: var(--text-muted);
  text-align: center;
  gap: var(--space-sm);
}

.empty-state .hint {
  font-size: var(--text-sm);
  margin-top: var(--space-xs);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* 偏好分组 */
.preferences-section {
  margin-bottom: var(--space-lg);
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin: 0 0 var(--space-sm) 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.section-title .count {
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: 10px;
  font-size: var(--text-xs);
  font-weight: 500;
}

.preference-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.preference-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.preference-item:hover {
  border-color: var(--border-default);
}

.item-content {
  flex: 1;
  min-width: 0;
}

.content-text {
  margin: 0;
  font-size: var(--text-base);
  color: var(--text-primary);
  line-height: 1.5;
  word-break: break-word;
}

.item-meta {
  display: flex;
  gap: var(--space-md);
  margin-top: var(--space-xs);
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.edit-input {
  flex: 1;
  padding: var(--space-sm);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--text-base);
  resize: vertical;
  min-height: 60px;
}

.edit-input:focus {
  outline: none;
}

.item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.action-btn.delete:hover {
  background: var(--error-subtle);
  color: var(--error);
}

.action-btn.save {
  color: var(--success);
}

.action-btn.save:hover {
  background: var(--success-subtle);
}

.action-btn.cancel:hover {
  background: var(--error-subtle);
  color: var(--error);
}
</style>
