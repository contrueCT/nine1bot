import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Lock } from "./lock"

/** Shared by every writer of a configuration/credential file in this process. */
export namespace JsonFile {
  export type Object = Record<string, any>
  export type Document = { path: string; text: string; data: Object; existed: boolean; mode: number }

  async function requireDirectory(filename: string, allowMissing = false) {
    const stat = await fs.stat(filename).catch((error) => {
      if (allowMissing && error.code === "ENOENT") return undefined
      throw error
    })
    if (stat && !stat.isDirectory())
      throw Object.assign(new Error(`Not a directory: ${filename}`), { code: "ENOTDIR" })
  }

  export async function canonical(filename: string) {
    const absolute = path.resolve(filename)
    // The observed deleted-inode race is on Bun/Linux. Keep native path identity
    // (including Windows casing and short names) on the other platforms.
    if (process.platform !== "linux") {
      return fs.realpath(absolute).catch(async (error) => {
        if (error.code !== "ENOENT") throw error
        const parent = await fs.realpath(path.dirname(absolute)).catch(() => path.dirname(absolute))
        return path.join(parent, path.basename(absolute))
      })
    }
    const split = (name: string) => name.split(path.sep === "\\" ? /[\\/]+/ : /\/+/)
    let current = path.parse(absolute).root
    const pending = split(absolute.slice(current.length))
    let links = 0
    while (pending.length) {
      const component = pending.shift()!
      if (!component || component === "." || component === "..") {
        // Parent traversal and a trailing separator require a real directory.
        // Missing ordinary parents may be created later, but cannot be erased
        // by ".." or silently substituted for a file used as a directory.
        await requireDirectory(current)
        if (component === "..") current = path.dirname(current)
        continue
      }
      const candidate = path.join(current, component)
      const target = await fs.readlink(candidate).catch((error) => {
        if (error.code === "EINVAL" || error.code === "ENOENT") return undefined
        throw error
      })
      if (target !== undefined) {
        if (++links > 40)
          throw Object.assign(new Error(`Too many symbolic links: ${filename}`), { code: "ELOOP" })
        if (path.isAbsolute(target)) {
          current = path.parse(target).root
          pending.unshift(...split(target.slice(current.length)))
        } else pending.unshift(...split(target))
        continue
      }
      // Keep the pathname, not the leaf inode replaced by write(). Bun/Linux
      // realpath can expose the replaced inode as "filename (deleted)".
      current = candidate
      if (pending.length) await requireDirectory(current, true)
    }
    return current
  }

  export async function read(filename: string): Promise<Document> {
    const text = await fs.readFile(filename, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const errors: ParseError[] = []
    const data = parse(text ?? "{}", errors, { allowTrailingComma: true })
    if (errors.length || !isObject(data)) throw new Error(`Invalid JSON object in ${filename}`)
    const mode = await fs
      .stat(filename)
      .then((stat) => stat.mode & 0o777)
      .catch((error) => {
        if (error.code === "ENOENT") return 0o600
        throw error
      })
    return { path: filename, text: text ?? "{}\n", data, existed: text !== undefined, mode }
  }

  function isObject(value: unknown): value is Object {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  // Apply only differences, preserving unrelated comments, values and source layers.
  export function applyDiff(target: Object, before: Object, after: Object) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
      if (!(key in after)) delete target[key]
      else if ((isObject(before[key]) || before[key] === undefined) && isObject(after[key]) && isObject(target[key])) {
        applyDiff(target[key], before[key] ?? {}, after[key])
      } else target[key] = structuredClone(after[key])
    }
  }

  function render(text: string, before: Object, after: Object, prefix: string[] = []): string {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
      if (isObject(before[key]) && isObject(after[key])) text = render(text, before[key], after[key], [...prefix, key])
      else
        text = applyEdits(
          text,
          modify(text, [...prefix, key], after[key], {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
          }),
        )
    }
    return text.endsWith("\n") ? text : text + "\n"
  }

  export async function write(filename: string, text: string, mode = 0o600, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await fs.mkdir(path.dirname(filename), { recursive: true })
    // Atomic replacement would otherwise bypass the target file's read-only mode.
    // Honor an explicit chmod even when the containing directory is writable.
    const current = await fs.stat(filename).catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (current && (current.mode & 0o222) === 0) {
      throw Object.assign(new Error(`Configuration file is read-only: ${filename}`), { code: "EACCES" })
    }
    signal?.throwIfAborted()
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, text, { mode, flag: "wx", signal })
      signal?.throwIfAborted()
      await fs.rename(temporary, filename)
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }

  /** Validate/mutate all documents before committing. Roll back completed writes on I/O failure. */
  export async function transaction(filenames: string[], edit: (documents: Document[]) => void | Promise<void>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const paths = await Promise.all(filenames.map(canonical))
    if (new Set(paths).size !== paths.length) throw new Error("Configuration sources must use distinct files")
    const locks: Disposable[] = []
    try {
      for (const filename of [...paths].sort()) {
        signal?.throwIfAborted()
        locks.push(await Lock.write(filename))
        // A cancelled caller may have been waiting behind another writer.
        signal?.throwIfAborted()
      }
      const originals = await Promise.all(paths.map(read))
      signal?.throwIfAborted()
      const documents = structuredClone(originals)
      await edit(documents)
      signal?.throwIfAborted()
      const written: Document[] = []
      try {
        for (let index = 0; index < documents.length; index++) {
          const original = originals[index]
          const document = documents[index]
          if (JSON.stringify(original.data) === JSON.stringify(document.data)) continue
          await write(document.path, render(original.text, original.data, document.data), document.mode, signal)
          written.push(original)
          // If cancellation arrived during the atomic rename, roll back under
          // the same locks. Rollback deliberately ignores the cancelled signal.
          signal?.throwIfAborted()
        }
      } catch (error) {
        const rollbackErrors: unknown[] = []
        for (const original of written.reverse()) {
          try {
            if (original.existed) await write(original.path, original.text, original.mode)
            else await fs.unlink(original.path)
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError)
          }
        }
        if (rollbackErrors.length)
          throw new AggregateError([error, ...rollbackErrors], "Configuration commit and rollback failed")
        throw error
      }
      return documents.map((document) => document.data)
    } finally {
      for (const lock of locks.reverse()) lock[Symbol.dispose]()
    }
  }

  export async function update(filename: string, edit: (data: Object) => void | Promise<void>, signal?: AbortSignal) {
    const [data] = await transaction([filename], async ([document]) => {
      await edit(document.data)
    }, signal)
    return data
  }
}
