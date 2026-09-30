<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Edit2, Check, X, Globe } from 'lucide-vue-next'
import { usePreferences } from '../composables/usePreferences'

const {
  globalPreferences,
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
  formatTime
} = usePreferences()

// 新增偏好的输入
const newContent = ref('')

// 添加偏好
async function handleAdd() {
  if (!newContent.value.trim()) return
  await addPreference(newContent.value, 'global')
  newContent.value = ''
}

// 删除确认
const deletingId = ref<string | null>(null)

function handleDelete(id: string) {
  deletingId.value = id
}

async function confirmDelete() {
  if (!deletingId.value) return
  await deletePreference(deletingId.value)
  deletingId.value = null
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
        设置您的全局偏好，AI 会在每次对话中自动遵循这些偏好。
      </p>
    </div>

    <!-- 添加新偏好 -->
    <div class="add-section">
      <div class="add-input-row">
        <textarea
          v-model="newContent"
          placeholder="输入新的偏好，例如：使用简洁的代码风格..."
          class="add-input"
          rows="2"
          @keydown.enter.ctrl="handleAdd"
        />
      </div>
      <div class="add-actions">
        <div class="scope-label">
          <Globe :size="14" />
          <span>全局偏好</span>
        </div>
        <button
          class="add-btn"
          :disabled="!newContent.trim() || loading"
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
      <div v-if="!loading && globalPreferences.length === 0" class="empty-state">
        <p>还没有设置任何偏好</p>
        <p class="hint">添加偏好后，AI 会在对话中自动遵循</p>
      </div>

      <!-- 加载状态 -->
      <div v-else-if="loading && globalPreferences.length === 0" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <!-- 全局偏好 -->
      <div v-if="globalPreferences.length > 0" class="preferences-section">
        <h3 class="section-title">
          <Globe :size="14" />
          <span>全局偏好</span>
          <span class="count">{{ globalPreferences.length }}</span>
        </h3>
        <div class="preference-items">
          <div
            v-for="pref in globalPreferences"
            :key="pref.id"
            class="preference-item"
          >
            <!-- 编辑模式 -->
            <template v-if="editingId === pref.id">
              <textarea
                v-model="editingContent"
                class="edit-input"
                rows="2"
                @keydown.enter.ctrl="saveEdit"
                @keydown.escape="cancelEdit"
              />
              <div class="item-actions">
                <button class="action-btn save" @click="saveEdit" title="保存">
                  <Check :size="14" />
                </button>
                <button class="action-btn cancel" @click="cancelEdit" title="取消">
                  <X :size="14" />
                </button>
              </div>
            </template>
            <!-- 显示模式 -->
            <template v-else>
              <div class="item-content">
                <p class="content-text">{{ pref.content }}</p>
                <div class="item-meta">
                  <span class="source">{{ pref.source === 'ai' ? 'AI 添加' : '手动添加' }}</span>
                  <span class="time">{{ formatTime(pref.createdAt) }}</span>
                </div>
              </div>
              <div class="item-actions">
                <button class="action-btn edit" @click="startEdit(pref)" title="编辑">
                  <Edit2 :size="14" />
                </button>
                <button class="action-btn delete" @click="handleDelete(pref.id)" title="删除">
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
      <div v-if="deletingId" class="dialog-overlay" @click="deletingId = null">
        <div class="dialog" @click.stop>
          <div class="dialog-header">
            <span>删除偏好</span>
            <button class="action-btn" @click="deletingId = null">
              <X :size="16" />
            </button>
          </div>
          <div class="dialog-body">
            <p class="dialog-message">确定要删除这条偏好吗？</p>
            <p class="dialog-warning">此操作不可撤销。</p>
          </div>
          <div class="dialog-footer">
            <button class="btn btn-ghost btn-sm" @click="deletingId = null">取消</button>
            <button class="btn btn-danger btn-sm" @click="confirmDelete">
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
