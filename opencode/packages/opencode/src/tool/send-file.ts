import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"

export const SendFileTool = Tool.define("send_file", {
  description: `Send a file to the user for download.

Use this tool to share files with the user, such as:
- Generated files (reports, exports, processed data)
- Code files or configurations
- Any file the user might want to download

The file will be made available for download in the user's browser.

Usage notes:
- For large files (>5MB), consider compressing them first (e.g., create a zip archive)
- The file must exist on the filesystem
- Binary files and text files are both supported
- The user will see a download button in the chat interface

Example:
- Send a generated report: send_file({ path: "./output/report.pdf" })
- Send with description: send_file({ path: "./data.csv", description: "Exported user data" })`,
  parameters: z.object({
    path: z.string().describe("The path to the file to send to the user"),
    description: z.string().optional().describe("Optional description of the file for the user"),
  }),
  async execute(params, ctx) {
    let filepath = params.path
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(ctx.cwd, filepath)
    }

    const filename = path.basename(filepath)
    const title = `Send file: ${filename}`

    // External directory check
    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    // Check file exists
    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filepath}`)
    }

    // Get file metadata without reading content
    const mime = file.type || "application/octet-stream"
    const size = file.size

    // Format size for display
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    const output = params.description
      ? `${params.description}\n\nFile: ${filename} (${formatSize(size)})`
      : `File ready for download: ${filename} (${formatSize(size)})`

    // Store file path instead of base64 content to save storage space
    // The file will be served via /file/download endpoint when user downloads
    return {
      title,
      output,
      metadata: {
        path: filepath,
        filename,
        size,
        mime,
        preview: output,
      },
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime,
          filename,
          url: `file://${filepath}`,
        },
      ],
    }
  },
})
