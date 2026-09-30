<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  AlertCircle,
  ChevronRight,
  ChevronUp,
  File,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  Search,
  X,
} from 'lucide-vue-next'
import { api } from '../api/client'

type BrowseKind = 'filesystem' | 'roots'

interface DirectoryItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
}

const ROOTS_VIEW = '@roots'
const ROOTS_LABEL = '此电脑'

const props = defineProps<{
  visible: boolean
  initialPath?: string
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'cancel'): void
}>()

const currentKind = ref<BrowseKind>('filesystem')
const currentPath = ref('')
const parentPath = ref<string | null>(null)
const addressInput = ref('')
const parentItems = ref<DirectoryItem[]>([])
const currentItems = ref<DirectoryItem[]>([])
const previewItems = ref<DirectoryItem[]>([])
const selectedDirectory = ref('')
const highlightedCurrentPath = ref<string | null>(null)
const previewDirectoryPath = ref<string | null>(null)
const filterText = ref('')
const isLoading = ref(false)
const previewLoading = ref(false)
const error = ref<string | null>(null)
const previewError = ref<string | null>(null)
let baseRequestId = 0
let previewRequestId = 0

const filterValue = computed(() => filterText.value.trim().toLowerCase())
const isRootsView = computed(() => currentKind.value === 'roots')
const hasLoadedDirectory = computed(() => currentPath.value !== '')
const canConfirm = computed(() => Boolean(selectedDirectory.value) && selectedDirectory.value !== ROOTS_VIEW)

const filteredParentItems = computed(() => filterItems(parentItems.value))
const filteredCurrentItems = computed(() => filterItems(currentItems.value))
const filteredPreviewItems = computed(() => filterItems(previewItems.value))

const currentColumnLabel = computed(() => (isRootsView.value ? '可用盘符' : '当前目录'))
const currentColumnEmptyText = computed(() =>
  isRootsView.value ? '没有检测到可访问盘符' : '当前目录为空，或没有匹配的内容',
)
const parentColumnEmptyText = computed(() =>
  isRootsView.value ? '盘符总览没有上一级内容' : '当前目录没有可显示的同级目录',
)
const selectedSummaryText = computed(() => {
  if (selectedDirectory.value) return selectedDirectory.value
  if (isRootsView.value) return '请选择一个盘符或目录'
  return currentPath.value || '未选择目录'
})
const shouldUseRootsHome = computed(() => {
  return (
    isRootsView.value ||
    isWindowsPath(currentPath.value) ||
    isWindowsPath(props.initialPath || '') ||
    isNavigatorWindows()
  )
})

function isNavigatorWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  return /win/i.test(navigator.userAgent) || /win/i.test((navigator as Navigator & { platform?: string }).platform || '')
}

function isWindowsPath(input: string): boolean {
  return /^[a-z]:([\\/]|$)/i.test(input)
}

function normalizePath(input: string): string {
  if (input === ROOTS_VIEW) return ROOTS_VIEW
  const normalized = input.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

function pathsEqual(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false
  return normalizePath(left) === normalizePath(right)
}

function filterItems(items: DirectoryItem[]): DirectoryItem[] {
  if (!filterValue.value) return items
  return items.filter((item) => item.name.toLowerCase().includes(filterValue.value))
}

function syncAddressInput(kind: BrowseKind, path: string) {
  addressInput.value = kind === 'roots' ? ROOTS_LABEL : path
}

function resetBrowserState() {
  currentKind.value = 'filesystem'
  currentPath.value = ''
  parentPath.value = null
  addressInput.value = ''
  parentItems.value = []
  currentItems.value = []
  previewItems.value = []
  selectedDirectory.value = ''
  highlightedCurrentPath.value = null
  previewDirectoryPath.value = null
  filterText.value = ''
  error.value = null
  previewError.value = null
  previewLoading.value = false
}

function clearPreview(resetSelection = true) {
  if (resetSelection) {
    highlightedCurrentPath.value = null
  }
  previewDirectoryPath.value = null
  previewItems.value = []
  previewError.value = null
  previewLoading.value = false
  if (resetSelection) {
    selectedDirectory.value = isRootsView.value ? '' : currentPath.value
  }
}

function getHomeTarget(): string {
  return shouldUseRootsHome.value ? ROOTS_VIEW : '~'
}

async function loadBaseDirectory(
  path: string,
  options: { allowFallback?: boolean; preserveStateOnError?: boolean } = {},
) {
  const requestId = ++baseRequestId
  isLoading.value = true
  error.value = null
  previewRequestId += 1
  clearPreview(false)

  try {
    const result = await api.browseDirectory(path)
    if (requestId !== baseRequestId) return

    currentKind.value = result.kind
    currentPath.value = result.path
    parentPath.value = result.parent
    currentItems.value = result.items
    selectedDirectory.value = result.kind === 'roots' ? '' : result.path
    highlightedCurrentPath.value = null
    syncAddressInput(result.kind, result.path)

    if (!result.parent) {
      parentItems.value = []
      return
    }

    const parentResult = await api.browseDirectory(result.parent)
    if (requestId !== baseRequestId) return

    parentItems.value = parentResult.items.filter((item) => item.type === 'directory')
  } catch (err: any) {
    if (requestId !== baseRequestId) return

    if (options.allowFallback && path !== getHomeTarget()) {
      await loadBaseDirectory(getHomeTarget(), {
        allowFallback: false,
        preserveStateOnError: options.preserveStateOnError,
      })
      return
    }

    if (!options.preserveStateOnError && !hasLoadedDirectory.value) {
      resetBrowserState()
    }

    error.value = err?.message || '无法访问此目录'
  } finally {
    if (requestId === baseRequestId) {
      isLoading.value = false
    }
  }
}

async function focusCurrentItem(item: DirectoryItem) {
  highlightedCurrentPath.value = item.path
  previewError.value = null

  if (item.type !== 'directory') {
    previewRequestId += 1
    previewDirectoryPath.value = null
    previewItems.value = []
    previewLoading.value = false
    selectedDirectory.value = isRootsView.value ? '' : currentPath.value
    return
  }

  const requestId = ++previewRequestId
  previewLoading.value = true
  previewDirectoryPath.value = item.path
  selectedDirectory.value = item.path

  try {
    const result = await api.browseDirectory(item.path)
    if (requestId !== previewRequestId) return
    previewItems.value = result.items
  } catch (err: any) {
    if (requestId !== previewRequestId) return
    previewItems.value = []
    previewError.value = err?.message || '无法读取该目录的内容'
  } finally {
    if (requestId === previewRequestId) {
      previewLoading.value = false
    }
  }
}

function enterDirectory(item: DirectoryItem) {
  if (item.type !== 'directory') return
  loadBaseDirectory(item.path, { preserveStateOnError: true })
}

// 单击 250ms 后才触发预览，双击进入目录时取消未决的单击动作，
// 避免同一行 @click + @dblclick 导致双击发出两次预览请求
let entryClickTimer: ReturnType<typeof setTimeout> | null = null

function handleEntryClick(item: DirectoryItem) {
  if (item.type !== 'directory') {
    focusCurrentItem(item)
    return
  }
  if (entryClickTimer) clearTimeout(entryClickTimer)
  entryClickTimer = setTimeout(() => {
    entryClickTimer = null
    focusCurrentItem(item)
  }, 250)
}

function handleEntryDblclick(item: DirectoryItem) {
  if (item.type !== 'directory') return
  if (entryClickTimer) {
    clearTimeout(entryClickTimer)
    entryClickTimer = null
  }
  enterDirectory(item)
}

function navigateHome() {
  loadBaseDirectory(getHomeTarget(), { preserveStateOnError: true })
}

function navigateUp() {
  if (!parentPath.value) return
  loadBaseDirectory(parentPath.value, { preserveStateOnError: true })
}

function selectParentItem(item: DirectoryItem) {
  loadBaseDirectory(item.path, { preserveStateOnError: true })
}

function handleOverlayClick(event: MouseEvent) {
  if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
    cancel()
  }
}

function confirm() {
  if (!canConfirm.value) return
  emit('select', selectedDirectory.value)
}

function cancel() {
  emit('cancel')
}

function normalizeAddressInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed === ROOTS_LABEL || trimmed === ROOTS_VIEW) return ROOTS_VIEW
  if (/^[a-z]:$/i.test(trimmed)) return `${trimmed}\\`
  return trimmed
}

function isAbsoluteOrSpecialPath(input: string): boolean {
  return (
    input === ROOTS_VIEW ||
    input === '~' ||
    input.startsWith('~/') ||
    input.startsWith('/') ||
    input.startsWith('\\\\') ||
    input.startsWith('//') ||
    /^[a-z]:([\\/]|$)/i.test(input)
  )
}

function goToAddress() {
  const requested = normalizeAddressInput(addressInput.value)
  if (!requested) {
    syncAddressInput(currentKind.value, currentPath.value)
    return
  }

  if (!isAbsoluteOrSpecialPath(requested)) {
    error.value = '请输入绝对路径，例如 D:\\repo、\\\\server\\share 或 ~'
    return
  }

  loadBaseDirectory(requested, { preserveStateOnError: true })
}

function handleKeydown(event: KeyboardEvent) {
  if (!props.visible) return
  if (event.key === 'Escape') {
    cancel()
    return
  }

  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea')) {
    return
  }

  if (event.key === 'Enter' && canConfirm.value) {
    event.preventDefault()
    confirm()
  }
}

function getDisplayPath(path: string): string {
  if (path === ROOTS_VIEW) return ROOTS_LABEL
  return path || '~'
}

function getColumnTitle(path: string | null, fallback: string): string {
  if (!path) return fallback
  if (path === ROOTS_VIEW) return ROOTS_LABEL

  const normalized = path.replace(/\\/g, '/')
  const trimmed = normalized.endsWith('/') && normalized.length > 1 ? normalized.slice(0, -1) : normalized
  const segments = trimmed.split('/').filter(Boolean)

  if (segments.length === 0) {
    return trimmed || fallback
  }

  const lastSegment = segments[segments.length - 1]
  if (/^[a-z]:$/i.test(lastSegment)) {
    return `${lastSegment}\\`
  }
  return lastSegment
}

function formatSize(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    resetBrowserState()
    loadBaseDirectory(props.initialPath || '~', { allowFallback: true, preserveStateOnError: false })
  },
)

watch(filteredCurrentItems, (items) => {
  if (!highlightedCurrentPath.value) return

  const stillVisible = items.some((item) => pathsEqual(item.path, highlightedCurrentPath.value))
  if (!stillVisible) {
    clearPreview()
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (entryClickTimer) {
    clearTimeout(entryClickTimer)
    entryClickTimer = null
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click="handleOverlayClick">
      <div class="modal directory-browser-modal">
        <div class="modal-header">
          <div class="header-copy">
            <h2 class="modal-title">选择工作目录</h2>
            <p class="modal-subtitle">支持跨盘切换、地址栏直达，以及三栏目录预览。</p>
          </div>
          <button class="btn btn-ghost btn-icon sm" @click="cancel" aria-label="关闭目录选择器">
            <X :size="18" />
          </button>
        </div>

        <div class="directory-toolbar">
          <div class="toolbar-actions">
            <button class="toolbar-btn" @click="navigateHome" :title="shouldUseRootsHome ? '显示盘符总览' : '返回主目录'">
              <Home :size="16" />
            </button>
            <button class="toolbar-btn" @click="navigateUp" :disabled="!parentPath" title="返回上一级">
              <ChevronUp :size="16" />
            </button>
          </div>

          <form class="address-bar" @submit.prevent="goToAddress">
            <FolderOpen :size="16" class="path-icon" />
            <input
              v-model="addressInput"
              type="text"
              spellcheck="false"
              :placeholder="isRootsView ? ROOTS_LABEL : '输入绝对路径，按 Enter 跳转'"
            />
          </form>

          <label class="search-field">
            <Search :size="16" />
            <input v-model="filterText" type="text" placeholder="过滤当前已加载内容" />
          </label>
        </div>

        <div class="modal-body directory-browser-body">
          <div v-if="isLoading && !hasLoadedDirectory" class="browser-state">
            <Loader2 :size="24" class="spin" />
            <span>正在加载目录结构...</span>
          </div>

          <div v-else-if="error && !hasLoadedDirectory" class="browser-state error">
            <AlertCircle :size="24" />
            <span>{{ error }}</span>
            <button class="btn btn-secondary btn-sm" @click="navigateHome">返回可访问位置</button>
          </div>

          <div v-else class="browser-shell">
            <div v-if="error || isLoading" class="browser-banner" :class="{ error: !!error }">
              <Loader2 v-if="isLoading && !error" :size="16" class="spin" />
              <AlertCircle v-else-if="error" :size="16" />
              <span>{{ error || '正在加载新目录...' }}</span>
            </div>

            <div class="browser-columns">
              <section class="browser-column">
                <header class="column-header">
                  <span class="column-label">父级目录</span>
                  <span class="column-path" :title="parentPath || currentPath">
                    {{ getColumnTitle(parentPath, '根目录') }}
                  </span>
                </header>

                <div v-if="filteredParentItems.length === 0" class="column-empty">
                  <Folder :size="18" />
                  <span>{{ parentColumnEmptyText }}</span>
                </div>

                <div v-else class="column-list">
                  <button
                    v-for="item in filteredParentItems"
                    :key="item.path"
                    class="entry-row"
                    :class="{ active: pathsEqual(item.path, currentPath) }"
                    @click="selectParentItem(item)"
                  >
                    <Folder :size="16" class="entry-icon folder" />
                    <span class="entry-name">{{ item.name }}</span>
                  </button>
                </div>
              </section>

              <section class="browser-column browser-column-current">
                <header class="column-header">
                  <span class="column-label">{{ currentColumnLabel }}</span>
                  <span class="column-path" :title="getDisplayPath(currentPath)">
                    {{ getColumnTitle(currentPath, currentColumnLabel) }}
                  </span>
                </header>

                <div v-if="filteredCurrentItems.length === 0" class="column-empty">
                  <Folder :size="18" />
                  <span>{{ currentColumnEmptyText }}</span>
                </div>

                <div v-else class="column-list">
                  <div
                    v-for="item in filteredCurrentItems"
                    :key="item.path"
                    class="entry-row entry-row-current"
                    :class="{
                      active: pathsEqual(item.path, highlightedCurrentPath),
                      directory: item.type === 'directory',
                      file: item.type === 'file',
                    }"
                    @click="handleEntryClick(item)"
                    @dblclick="handleEntryDblclick(item)"
                  >
                    <component :is="item.type === 'directory' ? Folder : File" :size="16" class="entry-icon" />
                    <div class="entry-main">
                      <span class="entry-name">{{ item.name }}</span>
                      <span v-if="item.type === 'file' && item.size !== undefined" class="entry-meta">
                        {{ formatSize(item.size) }}
                      </span>
                      <span v-else-if="isRootsView" class="entry-meta">盘符</span>
                      <span v-else-if="item.type === 'directory'" class="entry-meta">目录</span>
                    </div>
                    <button
                      v-if="item.type === 'directory'"
                      class="enter-btn"
                      title="进入此目录"
                      @click.stop="enterDirectory(item)"
                    >
                      <ChevronRight :size="15" />
                    </button>
                  </div>
                </div>
              </section>

              <section class="browser-column">
                <header class="column-header">
                  <span class="column-label">下一层预览</span>
                  <span class="column-path" :title="previewDirectoryPath || ''">
                    {{ getColumnTitle(previewDirectoryPath, '预览') }}
                  </span>
                </header>

                <div v-if="previewLoading" class="column-empty">
                  <Loader2 :size="18" class="spin" />
                  <span>正在读取子目录...</span>
                </div>

                <div v-else-if="previewError" class="column-empty error">
                  <AlertCircle :size="18" />
                  <span>{{ previewError }}</span>
                </div>

                <div v-else-if="!previewDirectoryPath" class="column-empty">
                  <FolderOpen :size="18" />
                  <span>点击中栏目录或盘符后，这里会显示它的内容</span>
                </div>

                <div v-else-if="filteredPreviewItems.length === 0" class="column-empty">
                  <Folder :size="18" />
                  <span>该位置为空，或没有匹配的内容</span>
                </div>

                <div v-else class="column-list">
                  <div v-for="item in filteredPreviewItems" :key="item.path" class="entry-row preview-row">
                    <component :is="item.type === 'directory' ? Folder : File" :size="16" class="entry-icon" />
                    <div class="entry-main">
                      <span class="entry-name">{{ item.name }}</span>
                      <span v-if="item.type === 'file' && item.size !== undefined" class="entry-meta">
                        {{ formatSize(item.size) }}
                      </span>
                      <span v-else-if="item.type === 'directory'" class="entry-meta">目录</span>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div class="modal-footer directory-footer">
          <div class="selected-summary">
            <span class="selected-label">当前选择</span>
            <span class="selected-path" :title="selectedSummaryText">
              {{ selectedSummaryText }}
            </span>
          </div>

          <div class="footer-actions">
            <button class="btn btn-secondary" @click="cancel">取消</button>
            <button class="btn btn-primary" @click="confirm" :disabled="!canConfirm">
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.directory-browser-modal {
  width: min(96vw, 1100px);
  max-width: 1100px;
  max-height: 78vh;
  display: flex;
  flex-direction: column;
}

.header-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-subtitle {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.directory-toolbar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(240px, 320px);
  gap: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 85%, white 15%) 0%, var(--bg-secondary) 100%);
  border-bottom: 1px solid var(--border-subtle);
}

.toolbar-actions {
  display: flex;
  gap: var(--space-sm);
}

.toolbar-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-elevated) 70%, var(--bg-secondary) 30%);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--transition-normal),
    border-color var(--transition-normal),
    color var(--transition-normal),
    transform var(--transition-fast);
}

.toolbar-btn:hover:not(:disabled) {
  background: var(--bg-elevated);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.toolbar-btn:active:not(:disabled) {
  transform: translateY(1px);
}

.toolbar-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.address-bar,
.search-field {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 0 var(--space-md);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-elevated) 76%, var(--bg-secondary) 24%);
  color: var(--text-muted);
  box-shadow: var(--shadow-sm);
}

.address-bar input,
.search-field input {
  width: 100%;
  height: 38px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.address-bar input {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.address-bar input::placeholder,
.search-field input::placeholder {
  color: var(--text-muted);
}

.path-icon {
  flex-shrink: 0;
  color: var(--accent);
}

.directory-browser-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-lg);
  overflow: hidden;
}

.browser-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.browser-banner {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-elevated) 28%);
  color: var(--text-secondary);
}

.browser-banner.error {
  color: var(--error);
  border-color: color-mix(in srgb, var(--error) 22%, var(--border-default));
  background: color-mix(in srgb, var(--error-subtle) 60%, var(--bg-elevated) 40%);
}

.browser-state,
.column-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  min-height: 180px;
  text-align: center;
  color: var(--text-muted);
}

.browser-state.error,
.column-empty.error {
  color: var(--error);
}

.spin {
  animation: spin 1s linear infinite;
}

.browser-columns {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(220px, 0.95fr) minmax(300px, 1.15fr) minmax(260px, 1fr);
  gap: var(--space-md);
}

.browser-column {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 88%, var(--bg-secondary) 12%) 0%, var(--bg-elevated) 100%);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.browser-column-current {
  box-shadow: var(--shadow-md);
}

.column-header {
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-secondary) 60%, var(--bg-elevated) 40%);
}

.column-label {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.column-path {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-list {
  flex: 1;
  height: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-sm);
}

.entry-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 10px 12px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-normal),
    box-shadow var(--transition-normal),
    color var(--transition-normal);
}

.entry-row + .entry-row {
  margin-top: 4px;
}

.entry-row:hover {
  background: color-mix(in srgb, var(--accent-subtle) 60%, var(--bg-secondary) 40%);
}

.entry-row.active {
  background: color-mix(in srgb, var(--accent-subtle) 90%, var(--bg-elevated) 10%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
}

.entry-row.file {
  color: var(--text-secondary);
}

.preview-row {
  cursor: default;
}

.preview-row:hover {
  background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-elevated) 28%);
}

.entry-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.entry-icon.folder,
.entry-row.directory .entry-icon {
  color: var(--accent);
}

.entry-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
}

.entry-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.enter-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--transition-normal),
    color var(--transition-normal);
}

.enter-btn:hover {
  background: color-mix(in srgb, var(--bg-secondary) 70%, var(--bg-elevated) 30%);
  color: var(--text-primary);
}

.directory-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

.selected-summary {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.selected-label {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.selected-path {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-actions {
  display: flex;
  gap: var(--space-sm);
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 0.8125rem;
}

@media (max-width: 980px) {
  .directory-browser-modal {
    width: min(96vw, 980px);
  }

  .directory-toolbar {
    grid-template-columns: 1fr;
  }

  .browser-columns {
    display: flex;
    gap: var(--space-md);
    overflow-x: auto;
    padding-bottom: var(--space-xs);
  }

  .browser-column {
    flex: 0 0 min(78vw, 320px);
    min-height: 420px;
  }
}

@media (max-width: 720px) {
  .directory-browser-modal {
    width: 100%;
    max-height: 100vh;
    height: 100vh;
    border-radius: 0;
  }

  .modal-header,
  .directory-toolbar,
  .directory-browser-body,
  .modal-footer {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }

  .directory-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .footer-actions {
    justify-content: flex-end;
  }
}
</style>


