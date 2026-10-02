import fs from "node:fs/promises"
import path from "node:path"
import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Project } from "./project"
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { Filesystem } from "@/util/filesystem"

interface Context {
  directory: string
  worktree: string
  project: Project.Info
}
const context = Context.create<Context>("instance")
const cache = new Map<string, Promise<Context>>()

export const Instance = {
  async normalizeDirectory(directory: string) {
    const absolute = path.resolve(directory)
    return fs.realpath(absolute).catch((error) => {
      if (error.code === "ENOENT") return absolute
      throw error
    })
  },
  bind<R>(fn: () => R): () => R {
    const current = context.use()
    return () => context.provide(current, fn)
  },
  /** Read a matching context without creating an instance or skipping its bootstrap. */
  async existing(directory: string) {
    const normalized = await Instance.normalizeDirectory(directory)
    try {
      const current = context.use()
      // During init the cache promise is still pending. Use the active context
      // directly so a compatibility preference read cannot wait on its own init.
      if (current.directory === normalized) return current
    } catch (error) {
      if (!(error instanceof Context.NotFound)) throw error
    }
    return cache.get(normalized)
  },
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    const directory = await Instance.normalizeDirectory(input.directory)
    let existing = cache.get(directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory: input.directory })
      existing = iife(async () => {
        const { project, sandbox } = await Project.fromDirectory(directory)
        const ctx = {
          directory,
          worktree: sandbox,
          project,
        }
        await context.provide(ctx, async () => {
          await input.init?.()
        })
        return ctx
      })
      cache.set(directory, existing)
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    if (Filesystem.contains(Instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (Instance.worktree === "/") return false
    return Filesystem.contains(Instance.worktree, filepath)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => Instance.directory, init, dispose)
  },
  async dispose() {
    Log.Default.info("disposing instance", { directory: Instance.directory })
    await State.dispose(Instance.directory)
    cache.delete(Instance.directory)
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory: Instance.directory,
        },
      },
    })
  },
  async disposeAll() {
    Log.Default.info("disposing all instances")
    for (const [_key, value] of cache) {
      const awaited = await value.catch(() => {})
      if (awaited) {
        await context.provide(await value, async () => {
          await Instance.dispose()
        })
      }
    }
    cache.clear()
  },
}
