import fs from "fs/promises"
import path from "path"
import { extname, basename } from "path"
import { Log } from "@/util/log"

const log = Log.create({ service: "project.shared-files" })

export interface SharedFileInfo {
  name: string
  relativePath: string
  size: number
  modified: number
  mime?: string
}

function isSubPath(parent: string, child: string) {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function guessMime(filepath: string) {
  const ext = extname(filepath).toLowerCase()
  switch (ext) {
    case ".md":
      return "text/markdown"
    case ".txt":
      return "text/plain"
    case ".json":
      return "application/json"
    case ".yml":
    case ".yaml":
      return "text/yaml"
    case ".pdf":
      return "application/pdf"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    default:
      return undefined
  }
}

function sanitizeFilename(name: string) {
  const normalized = basename(name || `file-${Date.now()}`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
  return normalized || `file-${Date.now()}`
}

async function uniquePath(directory: string, filename: string) {
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  let candidate = path.join(directory, filename)
  let index = 1
  while (true) {
    const stat = await fs.stat(candidate).catch(() => undefined)
    if (!stat) return candidate
    candidate = path.join(directory, `${stem}-${index}${ext}`)
    index++
  }
}

function decodeDataUrl(input: string) {
  const match = input.match(/^data:([^;,]+)?;base64,(.+)$/)
  if (!match) throw new Error("Invalid data URL payload")
  return {
    mime: match[1] || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64"),
  }
}

export namespace ProjectSharedFiles {
  export function dir(projectRoot: string) {
    return path.join(projectRoot, ".nine1bot", "projectfiles")
  }

  export async function ensureDir(projectRoot: string) {
    const folder = dir(projectRoot)
    await fs.mkdir(folder, { recursive: true })
    return folder
  }

  export async function list(projectRoot: string): Promise<SharedFileInfo[]> {
    const folder = await ensureDir(projectRoot)
    const result: SharedFileInfo[] = []

    async function walk(current: string) {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
          continue
        }
        const stat = await fs.stat(fullPath).catch(() => undefined)
        if (!stat?.isFile()) continue
        result.push({
          name: entry.name,
          relativePath: path.relative(folder, fullPath).replaceAll("\\", "/"),
          size: stat.size,
          modified: stat.mtimeMs,
          mime: guessMime(fullPath),
        })
      }
    }

    await walk(folder)
    result.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return result
  }

  export async function save(projectRoot: string, input: { filename: string; url: string; mime?: string }) {
    const folder = await ensureDir(projectRoot)
    const filename = sanitizeFilename(input.filename)
    const decoded = decodeDataUrl(input.url)
    const target = await uniquePath(folder, filename)
    await fs.writeFile(target, decoded.buffer)
    const stat = await fs.stat(target)

    return {
      name: path.basename(target),
      relativePath: path.relative(folder, target).replaceAll("\\", "/"),
      size: stat.size,
      modified: stat.mtimeMs,
      mime: input.mime || decoded.mime || guessMime(target),
    } satisfies SharedFileInfo
  }

  export async function remove(projectRoot: string, relativePath: string) {
    const folder = await ensureDir(projectRoot)
    const target = path.resolve(folder, relativePath)
    if (!isSubPath(folder, target)) {
      throw new Error("Invalid file path")
    }
    const stat = await fs.stat(target).catch(() => undefined)
    if (!stat?.isFile()) throw new Error("Shared file not found")
    await fs.unlink(target)
    log.info("shared file removed", { relativePath })
    return true
  }
}

