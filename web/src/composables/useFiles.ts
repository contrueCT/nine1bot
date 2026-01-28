import { ref } from 'vue'
import { api, type FileItem } from '../api/client'

export interface FileTreeNode extends FileItem {
  children?: FileTreeNode[]
  isExpanded?: boolean
  isLoading?: boolean
}

export function useFiles() {
  const files = ref<FileTreeNode[]>([])
  const isLoading = ref(false)
  const currentPath = ref('')

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

  return {
    files,
    isLoading,
    currentPath,
    loadFiles,
    toggleDirectory
  }
}
