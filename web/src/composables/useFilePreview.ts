import { ref, computed } from 'vue'
import type { SSEEvent } from '../api/client'

export interface FilePreviewInfo {
  id: string
  sessionID: string
  path: string
  filename: string
  mime: string
  content?: string // base64 encoded for small files
  size: number
  interactive?: boolean
}

// Shared state across all components
const previews = ref<Map<string, FilePreviewInfo>>(new Map())
const activePreviewId = ref<string | null>(null)
const isPanelOpen = ref(false)

export function useFilePreview() {
  const previewList = computed(() => Array.from(previews.value.values()))

  const activePreview = computed(() => {
    if (!activePreviewId.value) return null
    return previews.value.get(activePreviewId.value) || null
  })

  const hasPreviews = computed(() => previews.value.size > 0)

  // Determine preview type based on MIME type
  const previewType = computed<'image' | 'code' | 'markdown' | 'html' | 'office' | 'unknown'>(() => {
    const preview = activePreview.value
    if (!preview) return 'unknown'

    const mime = preview.mime
    if (mime.startsWith('image/')) return 'image'
    if (mime === 'text/markdown') return 'markdown'
    if (mime === 'text/html') return 'html'
    if (mime.includes('officedocument') || mime.includes('wordprocessingml')) return 'office'
    if (mime.startsWith('text/') || mime === 'application/json') return 'code'
    return 'unknown'
  })

  // Get language from MIME type for syntax highlighting
  const codeLanguage = computed(() => {
    const preview = activePreview.value
    if (!preview) return 'plaintext'

    const mime = preview.mime
    const ext = preview.filename.split('.').pop()?.toLowerCase() || ''

    const mimeToLang: Record<string, string> = {
      'text/javascript': 'javascript',
      'text/typescript': 'typescript',
      'text/x-python': 'python',
      'text/x-rust': 'rust',
      'text/x-go': 'go',
      'text/x-vue': 'vue',
      'text/x-svelte': 'svelte',
      'text/css': 'css',
      'text/scss': 'scss',
      'text/sass': 'sass',
      'text/less': 'less',
      'application/json': 'json',
      'text/yaml': 'yaml',
      'text/xml': 'xml',
      'text/x-java': 'java',
      'text/x-kotlin': 'kotlin',
      'text/x-c': 'c',
      'text/x-cpp': 'cpp',
      'text/x-csharp': 'csharp',
      'text/x-ruby': 'ruby',
      'text/x-php': 'php',
      'text/x-swift': 'swift',
      'text/x-shellscript': 'bash',
      'text/x-powershell': 'powershell',
      'text/x-sql': 'sql',
      'text/toml': 'toml',
    }

    // First try MIME type
    if (mimeToLang[mime]) return mimeToLang[mime]

    // Fallback to extension
    const extToLang: Record<string, string> = {
      'js': 'javascript',
      'mjs': 'javascript',
      'cjs': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'jsx': 'javascript',
      'py': 'python',
      'rs': 'rust',
      'go': 'go',
      'vue': 'vue',
      'svelte': 'svelte',
      'css': 'css',
      'scss': 'scss',
      'sass': 'sass',
      'less': 'less',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'java': 'java',
      'kt': 'kotlin',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'rb': 'ruby',
      'php': 'php',
      'swift': 'swift',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'ps1': 'powershell',
      'sql': 'sql',
      'toml': 'toml',
      'md': 'markdown',
      'html': 'html',
      'htm': 'html',
    }

    return extToLang[ext] || 'plaintext'
  })

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event

    switch (type) {
      case 'file-preview.open': {
        const info = properties as FilePreviewInfo
        previews.value.set(info.id, info)
        activePreviewId.value = info.id
        isPanelOpen.value = true
        break
      }

      case 'file-preview.close': {
        const { id } = properties as { id: string }
        previews.value.delete(id)
        if (activePreviewId.value === id) {
          const remaining = Array.from(previews.value.keys())
          activePreviewId.value = remaining[0] || null
        }
        if (previews.value.size === 0) {
          isPanelOpen.value = false
        }
        break
      }
    }
  }

  function selectPreview(id: string) {
    if (previews.value.has(id)) {
      activePreviewId.value = id
    }
  }

  function closePreview(id?: string) {
    const targetId = id || activePreviewId.value
    if (targetId) {
      previews.value.delete(targetId)
      if (activePreviewId.value === targetId) {
        const remaining = Array.from(previews.value.keys())
        activePreviewId.value = remaining[0] || null
      }
    }
    if (previews.value.size === 0) {
      isPanelOpen.value = false
    }
  }

  function closeAllPreviews() {
    previews.value.clear()
    activePreviewId.value = null
    isPanelOpen.value = false
  }

  function openPanel() {
    if (previews.value.size > 0) {
      isPanelOpen.value = true
    }
  }

  function closePanel() {
    isPanelOpen.value = false
  }

  // Open preview by file path (for reopening from tool metadata)
  async function openPreviewByPath(
    filePath: string,
    options?: { interactive?: boolean; sessionID?: string }
  ): Promise<boolean> {
    try {
      const params = new URLSearchParams({ path: filePath })
      if (options?.interactive) {
        params.set('interactive', 'true')
      }

      const res = await fetch(`/file/preview-by-path?${params}`)
      if (!res.ok) {
        console.error('Failed to load preview:', await res.text())
        return false
      }

      const data = await res.json()

      // Generate a new preview ID
      const previewId = `preview-${Date.now()}`

      const previewInfo: FilePreviewInfo = {
        id: previewId,
        sessionID: options?.sessionID || '',
        path: data.path,
        filename: data.filename,
        mime: data.mime,
        content: data.content,
        size: data.size,
        interactive: data.interactive,
      }

      previews.value.set(previewId, previewInfo)
      activePreviewId.value = previewId
      isPanelOpen.value = true

      return true
    } catch (error) {
      console.error('Failed to open preview:', error)
      return false
    }
  }

  return {
    // State
    previews: previewList,
    activePreviewId,
    activePreview,
    isPanelOpen,
    hasPreviews,
    previewType,
    codeLanguage,

    // Actions
    handleSSEEvent,
    selectPreview,
    closePreview,
    closeAllPreviews,
    openPanel,
    closePanel,
    openPreviewByPath,
  }
}
