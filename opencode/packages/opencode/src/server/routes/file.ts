import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import path from "path"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { PreviewRegistry } from "../../tool/display_file"

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          directory: z.string().optional(),
        }),
      ),
      async (c) => {
        const { path, directory } = c.req.valid("query")
        const content = await File.list(path, { directory })
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          directory: z.string().optional(),
        }),
      ),
      async (c) => {
        const { path, directory } = c.req.valid("query")
        const content = await File.read(path, { directory })
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
        }),
      ),
      async (c) => {
        const { directory } = c.req.valid("query")
        const content = await File.status({ directory })
        return c.json(content)
      },
    )
    .get(
      "/file/preview/:id",
      describeRoute({
        summary: "Get file for preview",
        description: "Get file content for preview panel by preview ID (for large files).",
        operationId: "file.preview",
        responses: {
          200: {
            description: "File content",
          },
          404: {
            description: "Preview not found",
          },
        },
      }),
      async (c) => {
        const previewId = c.req.param("id")
        const preview = PreviewRegistry.get(previewId)
        if (!preview) {
          return c.json({ error: "Preview not found" }, 404)
        }

        const file = Bun.file(preview.path)
        if (!(await file.exists())) {
          PreviewRegistry.delete(previewId)
          return c.json({ error: "File not found" }, 404)
        }

        return c.body(await file.arrayBuffer(), {
          headers: {
            "Content-Type": preview.mime,
            "Content-Disposition": `inline; filename="${preview.filename}"`,
          },
        })
      },
    )
    .get(
      "/file/upload",
      describeRoute({
        summary: "Serve uploaded file",
        description: "Serve an uploaded file by its path. Only files within uploads directories are allowed.",
        operationId: "file.upload",
        responses: {
          200: { description: "File content" },
          400: { description: "Missing path parameter" },
          403: { description: "Access denied - path outside uploads directory" },
          404: { description: "File not found" },
        },
      }),
      async (c) => {
        const filePath = c.req.query("path")
        if (!filePath) {
          return c.json({ error: "Missing path" }, 400)
        }

        const normalized = path.resolve(filePath)
        const sep = path.sep
        const isUploadsDir =
          normalized.includes(`${sep}.nine1bot${sep}uploads${sep}`) ||
          normalized.includes(`${sep}.opencode${sep}uploads${sep}`)
        if (!isUploadsDir) {
          return c.json({ error: "Access denied" }, 403)
        }

        const file = Bun.file(normalized)
        if (!(await file.exists())) {
          return c.json({ error: "File not found" }, 404)
        }

        return c.body(await file.arrayBuffer(), {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "Content-Disposition": `inline; filename="${path.basename(normalized)}"`,
          },
        })
      },
    )
    .get(
      "/file/preview-by-path",
      describeRoute({
        summary: "Get file preview content by path",
        description: "Get file content for preview panel by file path. Returns base64 encoded content for rendering.",
        operationId: "file.previewByPath",
        responses: {
          200: {
            description: "Preview info with base64 content",
          },
          404: {
            description: "File not found",
          },
          400: {
            description: "Unsupported file type",
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          interactive: z.enum(["true", "false"]).optional(),
        }),
      ),
      async (c) => {
        const path = await import("path")
        const filepath = c.req.valid("query").path
        const interactive = c.req.valid("query").interactive === "true"

        // Resolve path
        let fullPath = filepath
        if (!path.isAbsolute(filepath)) {
          fullPath = path.resolve(Instance.directory, filepath)
        }

        const file = Bun.file(fullPath)
        if (!(await file.exists())) {
          return c.json({ error: "File not found" }, 404)
        }

        const filename = path.basename(fullPath)
        const ext = path.extname(fullPath).toLowerCase()
        const stat = await file.stat()
        const size = stat.size

        // MIME type mapping
        const MIME_TYPES: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
          ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".md": "text/markdown", ".html": "text/html", ".htm": "text/html",
          ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml",
          ".css": "text/css", ".js": "text/javascript", ".ts": "text/typescript",
          ".tsx": "text/typescript", ".jsx": "text/javascript", ".vue": "text/x-vue",
          ".py": "text/x-python", ".rs": "text/x-rust", ".go": "text/x-go",
          ".txt": "text/plain", ".log": "text/plain",
        }

        const mime = MIME_TYPES[ext] || file.type || "application/octet-stream"

        // Check if supported
        const isSupported = mime.startsWith("image/") || mime.startsWith("text/") ||
          mime === "application/json" || mime.includes("wordprocessingml")

        if (!isSupported) {
          return c.json({ error: `Unsupported file type: ${ext}` }, 400)
        }

        // Read file content (limit to 10MB for safety)
        const MAX_SIZE = 10 * 1024 * 1024
        if (size > MAX_SIZE) {
          return c.json({ error: "File too large for preview" }, 400)
        }

        const bytes = await file.bytes()
        const content = Buffer.from(bytes).toString("base64")

        return c.json({
          path: fullPath,
          filename,
          mime,
          content,
          size,
          interactive,
        })
      },
    )
    .get(
      "/file/download",
      describeRoute({
        summary: "Download file",
        description: "Download a file by path. Used for files sent via send_file tool.",
        operationId: "file.download",
        responses: {
          200: {
            description: "File content",
          },
          404: {
            description: "File not found",
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = await import("path")
        const filepath = c.req.valid("query").path

        // Normalize path for security
        const normalizedPath = path.normalize(filepath)

        const file = Bun.file(normalizedPath)
        if (!(await file.exists())) {
          return c.json({ error: "File not found" }, 404)
        }

        const filename = path.basename(normalizedPath)
        const mime = file.type || "application/octet-stream"

        return c.body(await file.arrayBuffer(), {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
            "Content-Length": String(file.size),
          },
        })
      },
    )
    .get(
      "/browse",
      describeRoute({
        summary: "Browse directory",
        description: "Browse any directory on the filesystem. Used for directory selection UI.",
        operationId: "file.browse",
        responses: {
          200: {
            description: "Directory contents",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    path: z.string(),
                    parent: z.string().nullable(),
                    items: z.array(
                      z.object({
                        name: z.string(),
                        path: z.string(),
                        type: z.enum(["file", "directory"]),
                        size: z.number().optional(),
                        modified: z.number().optional(),
                      })
                    ),
                  })
                ),
              },
            },
          },
          404: {
            description: "Directory not found",
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string().optional().default("~"),
        }),
      ),
      async (c) => {
        const path = await import("path")
        const fs = await import("fs/promises")
        const os = await import("os")

        let dirPath = c.req.valid("query").path

        // Handle home directory shortcut
        if (dirPath === "~" || dirPath.startsWith("~/")) {
          dirPath = dirPath.replace("~", os.homedir())
        }

        // Resolve to absolute path
        dirPath = path.resolve(dirPath)

        try {
          const stat = await fs.stat(dirPath)
          if (!stat.isDirectory()) {
            return c.json({ error: "Path is not a directory" }, 400)
          }

          const entries = await fs.readdir(dirPath, { withFileTypes: true })
          const items: Array<{
            name: string
            path: string
            type: "file" | "directory"
            size?: number
            modified?: number
          }> = []

          for (const entry of entries) {
            // Skip hidden files by default
            if (entry.name.startsWith(".")) continue

            const entryPath = path.join(dirPath, entry.name)
            const isDir = entry.isDirectory()

            try {
              const entryStat = await fs.stat(entryPath)
              items.push({
                name: entry.name,
                path: entryPath,
                type: isDir ? "directory" : "file",
                size: isDir ? undefined : entryStat.size,
                modified: entryStat.mtimeMs,
              })
            } catch {
              // Skip inaccessible entries
            }
          }

          // Sort: directories first, then alphabetically
          items.sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === "directory" ? -1 : 1
            }
            return a.name.localeCompare(b.name)
          })

          const parent = dirPath === "/" ? null : path.dirname(dirPath)

          return c.json({
            path: dirPath,
            parent,
            items,
          })
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return c.json({ error: "Directory not found" }, 404)
          }
          if (err.code === "EACCES") {
            return c.json({ error: "Permission denied" }, 403)
          }
          throw err
        }
      },
    ),
)
