import { ref, computed } from 'vue'

export interface FileAttachment {
  id: string
  file: File
  status: 'pending' | 'processing' | 'ready' | 'error'
  preview?: string  // Data URL for image preview
  dataUrl?: string  // Base64 data URL for sending
  error?: string
  mime: string
  filename: string
  size: number
}

// Supported image types
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp'
]

// Supported document types
const SUPPORTED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/msword', // .doc
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.ms-excel', // .xls
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml'
]

// File extensions for fallback detection (when MIME type is generic)
const DOCUMENT_EXTENSIONS = [
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
  '.txt', '.md', '.csv', '.json', '.xml'
]

// Max file size: 20MB for images, 10MB for documents
const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024

export function useFileUpload() {
  const attachments = ref<FileAttachment[]>([])

  const isProcessing = computed(() =>
    attachments.value.some(a => a.status === 'processing')
  )

  const hasReady = computed(() =>
    attachments.value.some(a => a.status === 'ready')
  )

  // Check if file is a supported image
  function isImage(file: File): boolean {
    return SUPPORTED_IMAGE_TYPES.includes(file.type)
  }

  // Check if file is a supported document
  function isDocument(file: File): boolean {
    if (SUPPORTED_DOCUMENT_TYPES.includes(file.type)) {
      return true
    }
    // Fallback to extension check for generic MIME types
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    return DOCUMENT_EXTENSIONS.includes(ext)
  }

  // Check if file is supported (image or document)
  function isSupported(file: File): boolean {
    return isImage(file) || isDocument(file)
  }

  // Get MIME type, with fallback for generic types
  function getMimeType(file: File): string {
    if (file.type && file.type !== 'application/octet-stream') {
      return file.type
    }
    // Fallback based on extension
    const ext = file.name.split('.').pop()?.toLowerCase()
    const mimeMap: Record<string, string> = {
      'pdf': 'application/pdf',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc': 'application/msword',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'ppt': 'application/vnd.ms-powerpoint',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'csv': 'text/csv',
      'json': 'application/json',
      'xml': 'application/xml'
    }
    return mimeMap[ext || ''] || file.type
  }

  // Convert file to base64 data URL
  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
  }

  // Add files
  async function addFiles(files: FileList | File[]) {
    const fileArray = Array.from(files)

    for (const file of fileArray) {
      // Check if supported
      if (!isSupported(file)) {
        console.warn(`Unsupported file type: ${file.name} (${file.type})`)
        continue
      }

      // Check file size based on type
      const maxSize = isImage(file) ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE
      if (file.size > maxSize) {
        console.warn(`File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB, max: ${maxSize / 1024 / 1024}MB)`)
        continue
      }

      const id = crypto.randomUUID()
      const mime = getMimeType(file)

      const attachment: FileAttachment = {
        id,
        file,
        status: 'pending',
        mime,
        filename: file.name,
        size: file.size
      }

      attachments.value.push(attachment)

      // Process asynchronously
      processFile(attachment)
    }
  }

  async function processFile(attachment: FileAttachment) {
    const idx = attachments.value.findIndex(a => a.id === attachment.id)
    if (idx === -1) return

    attachments.value[idx].status = 'processing'

    try {
      const dataUrl = await fileToDataUrl(attachment.file)

      attachments.value[idx].dataUrl = dataUrl
      // Only set preview for images
      if (isImage(attachment.file)) {
        attachments.value[idx].preview = dataUrl
      }
      attachments.value[idx].status = 'ready'
    } catch (err) {
      attachments.value[idx].status = 'error'
      attachments.value[idx].error = (err as Error).message
    }
  }

  // Remove a file
  function removeFile(id: string) {
    const idx = attachments.value.findIndex(a => a.id === id)
    if (idx !== -1) {
      attachments.value.splice(idx, 1)
    }
  }

  // Clear all files
  function clearAll() {
    attachments.value = []
  }

  // Convert to message parts for API
  function toMessageParts(): Array<{ type: 'file'; mime: string; filename: string; url: string }> {
    return attachments.value
      .filter(a => a.status === 'ready' && a.dataUrl)
      .map(a => ({
        type: 'file' as const,
        mime: a.mime,
        filename: a.filename,
        url: a.dataUrl!
      }))
  }

  return {
    attachments,
    isProcessing,
    hasReady,
    addFiles,
    removeFile,
    clearAll,
    toMessageParts,
    isImage,
    isDocument,
    isSupported
  }
}
