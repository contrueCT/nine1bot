import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { PreviewRegistry } from "../../tool/preview-file"

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
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
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
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
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
      async (c) => {
        const content = await File.status()
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
    ),
)
