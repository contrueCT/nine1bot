import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { assertExternalDirectory } from "./external-directory"
import { Sandbox } from "./sandbox"

// 定义 SSE 事件
export const FilePreviewEvent = {
  Open: BusEvent.define(
    "file-preview.open",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      path: z.string(),
      filename: z.string(),
      mime: z.string(),
      content: z.string().optional(), // 小文件 base64
      size: z.number(),
      interactive: z.boolean().optional(),
    }),
  ),
  Close: BusEvent.define(
    "file-preview.close",
    z.object({
      id: z.string(),
    }),
  ),
}

// 大文件预览注册表（用于 HTTP 端点获取）
export const PreviewRegistry = new Map<
  string,
  {
    path: string
    filename: string
    mime: string
  }
>()

// MIME 类型映射（暂不支持 PPTX 和 .doc）
const MIME_TYPES: Record<string, string> = {
  // 图片
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  // Office (仅 DOCX)
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Markdown
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  // HTML
  ".html": "text/html",
  ".htm": "text/html",
  // 数据格式
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "text/xml",
  ".toml": "text/toml",
  // 样式
  ".css": "text/css",
  ".scss": "text/scss",
  ".sass": "text/sass",
  ".less": "text/less",
  // JavaScript/TypeScript
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  // 其他编程语言
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".c": "text/x-c",
  ".cpp": "text/x-cpp",
  ".h": "text/x-c",
  ".hpp": "text/x-cpp",
  ".cs": "text/x-csharp",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".swift": "text/x-swift",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".ps1": "text/x-powershell",
  ".sql": "text/x-sql",
  // 配置文件
  ".txt": "text/plain",
  ".log": "text/plain",
  ".conf": "text/plain",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".dockerignore": "text/plain",
  ".editorconfig": "text/plain",
}

// 大文件阈值 (5MB)
const MAX_INLINE_SIZE = 5 * 1024 * 1024

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 检查是否支持预览
function isPreviewSupported(mime: string, ext: string): boolean {
  // 图片
  if (mime.startsWith("image/")) return true
  // 文本/代码
  if (mime.startsWith("text/")) return true
  // JSON/XML
  if (mime === "application/json") return true
  // Office 文档 (仅 DOCX)
  if (mime.includes("wordprocessingml")) return true
  // 通用检查
  return ext in MIME_TYPES
}

export const PreviewFileTool = Tool.define("preview_file", {
  description: `Show a file preview to the user in the web interface.

Use this tool to display files visually to the user, such as:
- Images (PNG, JPG, WebP, GIF, SVG)
- Word documents (.docx only, not .doc or .pptx)
- Code files with syntax highlighting
- Markdown rendered as HTML
- HTML pages (optionally interactive in an iframe)

The file will be displayed in a preview panel on the right side of the interface.

Parameters:
- path: File path to preview (absolute or relative to project root)
- interactive: For HTML files, whether to enable full interaction (default: false)
- title: Optional title for the preview panel

Example:
- Preview an image: preview_file({ path: "./output/chart.png" })
- Preview code: preview_file({ path: "./src/App.vue" })
- Interactive HTML: preview_file({ path: "./dist/index.html", interactive: true })`,
  parameters: z.object({
    path: z.string().describe("The path to the file to preview"),
    interactive: z.boolean().optional().describe("For HTML files, enable full interaction"),
    title: z.string().optional().describe("Optional title for the preview panel"),
  }),
  async execute(params, ctx) {
    let filepath = params.path
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }

    const filename = path.basename(filepath)
    const ext = path.extname(filepath).toLowerCase()
    const title = params.title || `Preview: ${filename}`

    // 安全检查
    await Sandbox.assertPath(ctx, filepath)
    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    // 检查文件是否存在
    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filepath}`)
    }

    const stat = await file.stat()
    const size = stat.size
    const mime = MIME_TYPES[ext] || file.type || "application/octet-stream"

    // 检查是否支持预览
    if (!isPreviewSupported(mime, ext)) {
      throw new Error(`File type not supported for preview: ${ext} (${mime})`)
    }

    // 生成预览 ID
    const previewId = Identifier.ascending("preview")

    // 小文件内联，大文件注册到 Registry
    let content: string | undefined
    if (size <= MAX_INLINE_SIZE) {
      const bytes = await file.bytes()
      content = Buffer.from(bytes).toString("base64")
    } else {
      PreviewRegistry.set(previewId, { path: filepath, filename, mime })
    }

    // 发送 SSE 事件
    await Bus.publish(FilePreviewEvent.Open, {
      id: previewId,
      sessionID: ctx.sessionID,
      path: filepath,
      filename,
      mime,
      content,
      size,
      interactive: params.interactive,
    })

    return {
      title,
      output: `File preview opened: ${filename} (${formatSize(size)})`,
      metadata: {
        previewId,
        path: filepath,
        filename,
        mime,
        size,
        interactive: params.interactive,
      },
    }
  },
})
