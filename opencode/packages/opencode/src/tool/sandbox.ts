import path from "path"
import os from "os"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { Wildcard } from "../util/wildcard"
import { Log } from "../util/log"

const log = Log.create({ service: "sandbox" })

export namespace Sandbox {
  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  function normalizePath(filepath: string): string {
    return path.normalize(filepath).replace(/\\/g, "/")
  }

  export async function isEnabled(): Promise<boolean> {
    const config = await Config.get()
    return config.sandbox?.enabled !== false
  }

  export async function getRoot(): Promise<string> {
    const config = await Config.get()
    return config.sandbox?.directory || Instance.directory
  }

  export async function isAllowed(filepath: string): Promise<boolean> {
    const config = await Config.get()

    // If sandbox is disabled, allow all paths
    if (config.sandbox?.enabled === false) {
      return true
    }

    const normalizedPath = normalizePath(filepath)
    const sandboxRoot = normalizePath(config.sandbox?.directory || Instance.directory)

    // Check deny patterns first (highest priority)
    const denyPaths = config.sandbox?.denyPaths || []
    for (const pattern of denyPaths) {
      const expandedPattern = expand(pattern)
      if (Wildcard.match(normalizedPath, expandedPattern) || Wildcard.match(path.basename(filepath), pattern)) {
        log.info("denied by denyPaths", { filepath, pattern })
        return false
      }
    }

    // Check if path is within sandbox root
    const resolvedPath = normalizePath(path.resolve(filepath))
    const resolvedRoot = normalizePath(path.resolve(sandboxRoot))
    if (resolvedPath.startsWith(resolvedRoot + "/") || resolvedPath === resolvedRoot) {
      return true
    }

    // Check additional allowed paths
    const allowedPaths = config.sandbox?.allowedPaths || []
    for (const pattern of allowedPaths) {
      const expandedPattern = normalizePath(expand(pattern))
      if (Wildcard.match(resolvedPath, expandedPattern)) {
        log.info("allowed by allowedPaths", { filepath, pattern })
        return true
      }
    }

    log.info("denied - outside sandbox", { filepath, sandboxRoot })
    return false
  }

  export async function assertPath(ctx: Tool.Context, filepath: string): Promise<void> {
    if (!filepath) return

    const allowed = await isAllowed(filepath)
    if (!allowed) {
      throw new SandboxViolationError(filepath)
    }
  }

  export async function assertPaths(ctx: Tool.Context, filepaths: string[]): Promise<void> {
    for (const filepath of filepaths) {
      await assertPath(ctx, filepath)
    }
  }

  export class SandboxViolationError extends Error {
    constructor(public readonly filepath: string) {
      super(
        `Sandbox violation: Access to "${filepath}" is not allowed. ` +
          `The file is outside the sandbox directory and not in the allowed paths list.`,
      )
    }
  }
}
