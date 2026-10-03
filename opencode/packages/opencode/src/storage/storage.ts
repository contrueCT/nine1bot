import { randomUUID } from "node:crypto"
import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { SessionSearch } from "./session-search"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { $ } from "bun"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  // This cache is rebuildable. Search failures must never prevent saving a conversation.
  const searchFilename = path.join(Global.Path.cache, "session-search-v1.sqlite")
  let searchIndex: SessionSearch.Index | undefined
  let searchIdentity: string | undefined

  function invalidateSearch(error?: unknown) {
    searchIndex?.close()
    searchIndex = undefined
    searchIdentity = undefined
    for (const suffix of ["", "-wal", "-shm"]) {
      fsSync.rmSync(searchFilename + suffix, { force: true })
    }
    if (error) log.warn("rebuilding session search index", { error })
  }

  function index() {
    const stat = fsSync.statSync(searchFilename, { throwIfNoEntry: false })
    const identity = stat ? `${stat.dev}:${stat.ino}` : undefined
    if (searchIndex && identity === searchIdentity) return searchIndex
    // The disposable cache can be removed/replaced while the server is running.
    searchIndex?.close()
    searchIndex = undefined
    const source: SessionSearch.Source = {
      list,
      read: async (key) => {
        try {
          return await read(key, { preserveCorrupted: true })
        } catch (error) {
          if (NotFoundError.isInstance(error) || CorruptedError.isInstance(error)) return undefined
          throw error
        }
      },
    }
    try {
      searchIndex = new SessionSearch.Index(searchFilename, source)
    } catch (error) {
      invalidateSearch(error)
      searchIndex = new SessionSearch.Index(searchFilename, source)
    }
    const created = fsSync.statSync(searchFilename)
    searchIdentity = `${created.dev}:${created.ino}`
    return searchIndex
  }

  function searchChange(key: string[], phase: "begin" | "finish", value?: unknown) {
    if (!SessionSearch.relevant(key)) return
    try {
      if (phase === "begin") index().begin(key)
      else index().finish(key, value)
    } catch (error) {
      try {
        invalidateSearch(error)
      } catch (cleanupError) {
        log.error("failed to reset session search index", { error: cleanupError })
      }
    }
  }

  export async function searchSessions(input: SessionSearch.Query) {
    await state()
    try {
      return await index().search(input)
    } catch (error) {
      // A corrupt FTS page may only be detected when a query actually reads it.
      const sqlite = error as { name?: string; errno?: number }
      if (sqlite.name !== "SQLiteError" || ![1, 11, 26].includes((sqlite.errno ?? 0) & 0xff)) throw error
      invalidateSearch(error)
      return index().search(input)
    }
  }

  export async function rebuildSessionSearch() {
    await state()
    invalidateSearch()
  }

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  export const CorruptedError = NamedError.create(
    "CorruptedError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      searchChange(key, "begin")
      await fs.unlink(target).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
      searchChange(key, "finish")
    })
  }

  export async function read<T>(key: string[], options: { preserveCorrupted?: boolean } = {}) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      try {
        const result = await Bun.file(target).json()
        return result as T
      } catch (e) {
        if (e instanceof SyntaxError) {
          log.warn("corrupted JSON file", { path: target, retained: Boolean(options.preserveCorrupted) })
          if (!options.preserveCorrupted) {
            searchChange(key, "begin")
            await fs.unlink(target).catch(() => {})
            searchChange(key, "finish")
          }
          throw new CorruptedError({ message: `Corrupted JSON file: ${target}` })
        }
        throw e
      }
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      let content: any
      try {
        content = await Bun.file(target).json()
      } catch (e) {
        if (e instanceof SyntaxError) {
          log.warn("corrupted JSON file, removing", { path: target })
          searchChange(key, "begin")
          await fs.unlink(target).catch(() => {})
          searchChange(key, "finish")
          throw new CorruptedError({ message: `Corrupted JSON file: ${target}` })
        }
        throw e
      }
      fn(content)
      searchChange(key, "begin")
      await Bun.write(target, JSON.stringify(content, null, 2))
      searchChange(key, "finish", content)
      return content as T
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      searchChange(key, "begin")
      await Bun.write(target, JSON.stringify(content, null, 2))
      searchChange(key, "finish", content)
    })
  }

  /** Preserve the previous complete record if writing or syncing the replacement fails. */
  export async function writeAtomic<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
      const bytes = Buffer.from(JSON.stringify(content, null, 2))
      try {
        searchChange(key, "begin")
        const written = await Bun.write(temporary, bytes)
        if (written !== bytes.length) throw new Error("Incomplete atomic storage write")
        const file = await fs.open(temporary, "r+")
        try {
          await file.sync()
        } finally {
          await file.close()
        }
        await fs.rename(temporary, target)
        searchChange(key, "finish", content)
      } finally {
        await fs.unlink(temporary).catch(() => {})
      }
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  const glob = new Bun.Glob("**/*")
  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
