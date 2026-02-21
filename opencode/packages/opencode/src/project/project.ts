import z from "zod"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { $ } from "bun"
import { createHash } from "crypto"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { Session } from "../session"
import { work } from "../util/queue"
import { fn } from "@opencode-ai/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { existsSync } from "fs"

export namespace Project {
  const log = Log.create({ service: "project" })
  export const Info = z
    .object({
      id: z.string(),
      worktree: z.string(),
      rootDirectory: z.string(),
      projectType: z.enum(["git", "directory"]),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      instructions: z.string().optional().describe("Shared system prompt instructions for all sessions in this project"),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  interface Meta {
    hidden?: boolean
    hiddenAt?: number
  }

  function directoryProjectID(directory: string) {
    const hash = createHash("sha1").update(directory).digest("hex")
    return `dir_${hash}`
  }

  async function readMeta(projectID: string): Promise<Meta> {
    return Storage.read<Meta>(["project_meta", projectID]).catch(() => ({}))
  }

  async function setHidden(projectID: string, hidden: boolean) {
    if (hidden) {
      await Storage.write<Meta>(["project_meta", projectID], {
        hidden: true,
        hiddenAt: Date.now(),
      })
      return
    }
    await Storage.remove(["project_meta", projectID]).catch(() => undefined)
  }

  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })

    const absoluteDirectory = path.resolve(directory)
    const resolvedDirectory = await fs.realpath(absoluteDirectory).catch(() => absoluteDirectory)

    const { id, sandbox, worktree, vcs, projectType, rootDirectory } = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const git = await matches.next().then((x) => x.value)
      await matches.return()
      if (git) {
        let sandbox = path.dirname(git)

        const gitBinary = Bun.which("git")

        // cached id calculation
        let id = await Bun.file(path.join(git, "opencode"))
          .text()
          .then((x) => x.trim())
          .catch(() => undefined)

        if (!gitBinary) {
          const normalized = path.resolve(sandbox)
          return {
            id: id ?? directoryProjectID(normalized),
            worktree: normalized,
            sandbox: sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            projectType: "git" as const,
            rootDirectory: normalized,
          }
        }

        // generate id from root commit
        if (!id) {
          const roots = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(sandbox)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
            .catch(() => undefined)

          if (!roots || roots.length === 0) {
            const normalized = path.resolve(sandbox)
            return {
              id: directoryProjectID(normalized),
              worktree: normalized,
              sandbox: sandbox,
              vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
              projectType: "git" as const,
              rootDirectory: normalized,
            }
          }

          id = roots[0]
          if (id) {
            void Bun.file(path.join(git, "opencode"))
              .write(id)
              .catch(() => undefined)
          }
        }

        if (!id) {
          const normalized = path.resolve(sandbox)
          return {
            id: directoryProjectID(normalized),
            worktree: normalized,
            sandbox: sandbox,
            vcs: "git",
            projectType: "git" as const,
            rootDirectory: normalized,
          }
        }

        const top = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => path.resolve(sandbox, x.trim()))
          .catch(() => undefined)

        if (!top) {
          const normalized = path.resolve(sandbox)
          return {
            id,
            sandbox,
            worktree: normalized,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            projectType: "git" as const,
            rootDirectory: normalized,
          }
        }

        sandbox = top

        const worktree = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => {
            const dirname = path.dirname(x.trim())
            if (dirname === ".") return sandbox
            return dirname
          })
          .catch(() => undefined)

        if (!worktree) {
          const normalized = path.resolve(sandbox)
          return {
            id,
            sandbox,
            worktree: normalized,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            projectType: "git" as const,
            rootDirectory: normalized,
          }
        }

        return {
          id,
          sandbox,
          worktree,
          vcs: "git",
          projectType: "git" as const,
          rootDirectory: path.resolve(sandbox),
        }
      }

      return {
        id: directoryProjectID(resolvedDirectory),
        worktree: resolvedDirectory,
        sandbox: resolvedDirectory,
        vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
        projectType: "directory" as const,
        rootDirectory: resolvedDirectory,
      }
    })

    let existing = await Storage.read<Info>(["project", id]).catch(() => undefined)
    if (!existing) {
      existing = {
        id,
        worktree,
        rootDirectory,
        projectType,
        vcs: vcs as Info["vcs"],
        sandboxes: [],
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      if (id !== "global") {
        await migrateFromGlobal(id, worktree)
      }
    }

    // migrate old projects before sandboxes
    if (!existing.sandboxes) existing.sandboxes = []
    if (!existing.rootDirectory) existing.rootDirectory = existing.worktree
    if (!existing.projectType) existing.projectType = existing.vcs === "git" ? "git" : "directory"

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(existing)

    const result: Info = {
      ...existing,
      worktree,
      rootDirectory,
      projectType,
      vcs: vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    const normalizedSandbox = path.resolve(sandbox)
    if (normalizedSandbox !== result.worktree && !result.sandboxes.includes(normalizedSandbox)) {
      result.sandboxes.push(normalizedSandbox)
    }
    result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
    await Storage.write<Info>(["project", id], result)
    await setHidden(id, false)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox: normalizedSandbox }
  }

  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const glob = new Bun.Glob("**/{favicon}.{ico,png,svg,jpg,jpeg,webp}")
    const matches = await Array.fromAsync(
      glob.scan({
        cwd: input.worktree,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      }),
    )
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const file = Bun.file(shortest)
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    const mime = file.type || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  async function migrateFromGlobal(newProjectID: string, worktree: string) {
    const globalProject = await Storage.read<Info>(["project", "global"]).catch(() => undefined)
    if (!globalProject) return

    const globalSessions = await Storage.list(["session", "global"]).catch(() => [])
    if (globalSessions.length === 0) return

    log.info("migrating sessions from global", { newProjectID, worktree, count: globalSessions.length })

    await work(10, globalSessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session) return
      if (session.directory && session.directory !== worktree) return

      session.projectID = newProjectID
      log.info("migrating session", { sessionID, from: "global", to: newProjectID })
      await Storage.write(["session", newProjectID, sessionID], session)
      await Storage.remove(key)
    }).catch((error) => {
      log.error("failed to migrate sessions from global to project", { error, projectId: newProjectID })
    })
  }

  export async function setInitialized(projectID: string) {
    await Storage.update<Info>(["project", projectID], (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function list() {
    const keys = await Storage.list(["project"])
    const projects = await Promise.all(keys.map((x) => Storage.read<Info>(x).catch(() => undefined)))
    const result: Info[] = []
    for (const project of projects) {
      if (!project) continue
      const hidden = await readMeta(project.id).then((x) => x.hidden === true)
      if (hidden) continue
      result.push({
        ...project,
        rootDirectory: project.rootDirectory || project.worktree,
        projectType: project.projectType || (project.vcs === "git" ? "git" : "directory"),
        sandboxes: project.sandboxes?.filter((x) => existsSync(x)),
      })
    }
    return result
  }

  export async function get(projectID: string) {
    const project = await Storage.read<Info>(["project", projectID])
    return {
      ...project,
      rootDirectory: project.rootDirectory || project.worktree,
      projectType: project.projectType || (project.vcs === "git" ? "git" : "directory"),
      sandboxes: project.sandboxes?.filter((x) => existsSync(x)),
    } satisfies Info
  }

  export async function forget(projectID: string) {
    await setHidden(projectID, true)
    return true
  }

  export const update = fn(
    z.object({
      projectID: z.string(),
      name: z.string().optional(),
      instructions: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
    }),
    async (input) => {
      const result = await Storage.update<Info>(["project", input.projectID], (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.instructions !== undefined) draft.instructions = input.instructions
        if (input.icon !== undefined) {
          draft.icon = {
            ...draft.icon,
          }
          if (input.icon.url !== undefined) draft.icon.url = input.icon.url
          if (input.icon.override !== undefined) draft.icon.override = input.icon.override || undefined
          if (input.icon.color !== undefined) draft.icon.color = input.icon.color
        }

        if (input.commands?.start !== undefined) {
          const start = input.commands.start || undefined
          draft.commands = {
            ...(draft.commands ?? {}),
          }
          draft.commands.start = start
          if (!draft.commands.start) draft.commands = undefined
        }

        draft.time.updated = Date.now()
      })
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: result,
        },
      })
      return result
    },
  )

  export async function sandboxes(projectID: string) {
    const project = await Storage.read<Info>(["project", projectID]).catch(() => undefined)
    if (!project?.sandboxes) return []
    const valid: string[] = []
    for (const dir of project.sandboxes) {
      const stat = await fs.stat(dir).catch(() => undefined)
      if (stat?.isDirectory()) valid.push(dir)
    }
    return valid
  }

  export async function addSandbox(projectID: string, directory: string) {
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      const sandboxes = draft.sandboxes ?? []
      if (!sandboxes.includes(directory)) sandboxes.push(directory)
      draft.sandboxes = sandboxes
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }

  export async function removeSandbox(projectID: string, directory: string) {
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      const sandboxes = draft.sandboxes ?? []
      draft.sandboxes = sandboxes.filter((sandbox) => sandbox !== directory)
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }
}
