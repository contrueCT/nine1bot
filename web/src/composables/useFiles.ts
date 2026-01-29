import { ref } from 'vue'
import { api, type FileItem, type FileContent, type FileSearchResult } from '../api/client'

export interface FileTreeNode extends FileItem {
  children?: FileTreeNode[]
  isExpanded?: boolean
  isLoading?: boolean
}

export function useFiles() {
  const files = ref<FileTreeNode[]>([])
  const isLoading = ref(false)
  const currentPath = ref('')

  // 文件内容查看
  const fileContent = ref<FileContent | null>(null)
  const isLoadingContent = ref(false)
  const contentError = ref<string | null>(null)

  // 文件搜索
  const searchResults = ref<FileSearchResult[]>([])
  const isSearching = ref(false)
  const searchError = ref<string | null>(null)

  async function loadFiles(path: string = '') {
    try {
      isLoading.value = true
      currentPath.value = path
      const items = await api.getFiles(path)

      // 排序：目录在前，文件在后，按名称排序
      files.value = items
        .map(item => ({ ...item, children: undefined, isExpanded: false, isLoading: false }))
        .sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name)
          return a.type === 'directory' ? -1 : 1
        })
    } catch (error) {
      console.error('Failed to load files:', error)
      files.value = []
    } finally {
      isLoading.value = false
    }
  }

  async function toggleDirectory(node: FileTreeNode) {
    if (node.type !== 'directory') return

    if (node.isExpanded) {
      node.isExpanded = false
      return
    }

    node.isLoading = true
    try {
      const children = await api.getFiles(node.path)
      node.children = children
        .map(item => ({ ...item, children: undefined, isExpanded: false, isLoading: false }))
        .sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name)
          return a.type === 'directory' ? -1 : 1
        })
      node.isExpanded = true
    } catch (error) {
      console.error('Failed to load directory:', error)
    } finally {
      node.isLoading = false
    }
  }

  // 加载文件内容
  async function loadFileContent(path: string) {
    isLoadingContent.value = true
    contentError.value = null
    try {
      fileContent.value = await api.getFileContent(path)
    } catch (error: any) {
      console.error('Failed to load file content:', error)
      contentError.value = error.message || '无法加载文件内容'
      fileContent.value = null
    } finally {
      isLoadingContent.value = false
    }
  }

  // 清除文件内容
  function clearFileContent() {
    fileContent.value = null
    contentError.value = null
  }

  // 搜索文件
  async function searchFiles(pattern: string) {
    if (!pattern.trim()) {
      searchResults.value = []
      return
    }

    isSearching.value = true
    searchError.value = null
    try {
      searchResults.value = await api.searchFiles(pattern)
    } catch (error: any) {
      console.error('Failed to search files:', error)
      searchError.value = error.message || '搜索失败'
      searchResults.value = []
    } finally {
      isSearching.value = false
    }
  }

  // 清除搜索结果
  function clearSearch() {
    searchResults.value = []
    searchError.value = null
  }

  return {
    files,
    isLoading,
    currentPath,
    loadFiles,
    toggleDirectory,
    // 文件内容
    fileContent,
    isLoadingContent,
    contentError,
    loadFileContent,
    clearFileContent,
    // 文件搜索
    searchResults,
    isSearching,
    searchError,
    searchFiles,
    clearSearch
  }
}
