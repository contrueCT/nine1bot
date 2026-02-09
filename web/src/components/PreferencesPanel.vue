<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Edit2, Check, X, Globe, FolderOpen } from 'lucide-vue-next'
import { usePreferences } from '../composables/usePreferences'

const {
  preferences,
  globalPreferences,
  projectPreferences,
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
const newScope = ref<'global' | 'project'>('global')

// 添加偏好
async function handleAdd() {
  if (!newContent.value.trim()) return
  await addPreference(newContent.value, newScope.value)
  newContent.value = ''
}

// 删除确认
async function handleDelete(id: string) {
  if (confirm('确定要删除这条偏好吗？')) {
    await deletePreference(id)
  }
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
        设置您的偏好，AI 会在每次对话中自动遵循这些偏好。
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
        <div class="scope-selector">
          <button
            class="scope-btn"
            :class="{ active: newScope === 'global' }"
            @click="newScope = 'global'"
            title="全局偏好（所有项目生效）"
          >
            <Globe :size="14" />
            <span>全局</span>
          </button>
          <button
            class="scope-btn"
            :class="{ active: newScope === 'project' }"
            @click="newScope = 'project'"
            title="项目偏好（仅当前项目生效）"
          >
            <FolderOpen :size="14" />
            <span>项目</span>
          </button>
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
      <div v-if="!loading && preferences.length === 0" class="empty-state">
        <p>还没有设置任何偏好</p>
        <p class="hint">添加偏好后，AI 会在对话中自动遵循</p>
      </div>

      <!-- 加载状态 -->
      <div v-else-if="loading && preferences.length === 0" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <!-- 项目偏好 -->
      <div v-if="projectPreferences.length > 0" class="preferences-section">
        <h3 class="section-title">
          <FolderOpen :size="14" />
          <span>项目偏好</span>
          <span class="count">{{ projectPreferences.length }}</span>
        </h3>
        <div class="preference-items">
          <div
            v-for="pref in projectPreferences"
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
  border-bottom: 0.5px solid var(--border-subtle);
}

.description {
  font-size: 13px;
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
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
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

.scope-selector {
  display: flex;
  gap: var(--space-xs);
}

.scope-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.scope-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

.scope-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.add-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: white;
  font-size: 13px;
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
  background: rgba(239, 68, 68, 0.1);
  border: 0.5px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-sm);
  color: #ef4444;
  font-size: 13px;
}

/* 偏好列表 */
.preferences-list {
  flex: 1;
  overflow-y: auto;
}

.empty-state,
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-xl);
  color: var(--text-muted);
  text-align: center;
}

.empty-state .hint {
  font-size: 12px;
  margin-top: var(--space-xs);
  opacity: 0.7;
}

.loading-state {
  flex-direction: row;
  gap: var(--space-sm);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.section-title .count {
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: 10px;
  font-size: 11px;
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
  border: 0.5px solid var(--border-subtle);
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
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.5;
  word-break: break-word;
}

.item-meta {
  display: flex;
  gap: var(--space-md);
  margin-top: var(--space-xs);
  font-size: 11px;
  color: var(--text-muted);
}

.edit-input {
  flex: 1;
  padding: var(--space-sm);
  border: 0.5px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
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
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.action-btn.save {
  color: var(--success);
}

.action-btn.save:hover {
  background: rgba(34, 197, 94, 0.1);
}

.action-btn.cancel:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}
</style>
