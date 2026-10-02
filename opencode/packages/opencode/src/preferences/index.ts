import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import z from "zod"
import { JsonFile } from "../util/json-file"

/** One store shared by HTTP routes, prompt injection, the remember tool and the launcher. */
export namespace Preferences {
  export const Info = z.object({
    id: z.string(),
    content: z.string(),
    source: z.enum(["user", "ai"]),
    createdAt: z.number(),
    scope: z.enum(["global", "project"]),
    projectID: z.string().min(1).optional(),
  }).passthrough()
  export type Info = z.infer<typeof Info>
  // Presentation-only provenance; it is never written back into legacy files.
  export const Listed = Info.extend({ origin: z.string(), ambiguous: z.boolean() })
  export type Listed = z.infer<typeof Listed>
  export class AmbiguousError extends Error {
    constructor() {
      super("偏好 ID 重复，已阻止修改。请在所示源文件中为重复记录设置不同 ID，然后重新加载。")
      this.name = "AmbiguousPreferenceError"
    }
  }
  export const Content = z.string().trim().min(1).max(4096)
  export const Add = z.object({
    content: Content,
    source: z.enum(["user", "ai"]).optional(),
    scope: z.enum(["global", "project"]).optional(),
  })
  export const Update = z.object({
    content: Content.optional(),
    assignToCurrentProject: z.literal(true).optional(),
  }).refine((input) => input.content !== undefined || input.assignToCurrentProject, "No update provided")
  export type Context = { projectID: string; directory: string; workingDirectory?: string }
  export type State = {
    preferences: Listed[]
    global: Listed[]
    project: Listed[]
    unresolved: Listed[]
    projectID: string
    directory: string
  }

  export function enabled() {
    return !!(process.env.NINE1BOT_PREFERENCES_PATH || process.env.NINE1BOT_PREFERENCES_MODULE)
  }

  export function filename() {
    return process.env.NINE1BOT_PREFERENCES_PATH || path.join(os.homedir(), ".nine1bot", "preferences.json")
  }

  function entries(data: JsonFile.Object): Info[] {
    if (data.version !== undefined && data.version !== 1) throw new Error("Unsupported preferences file version")
    return z.array(Info).parse(data.preferences === undefined ? [] : data.preferences)
  }

  function active(preference: Info, context: Context) {
    return preference.scope === "global" || preference.projectID === context.projectID
  }

  function unresolved(preference: Info) {
    return preference.scope === "project" && !preference.projectID
  }

  /** Legacy project-local files already have an owner by location. Never move or discard them. */
  async function localFile(directory: string) {
    for (const name of [".nine1bot/preferences.json", "nine1bot.preferences.json"]) {
      const file = path.join(directory, name)
      const exists = await fs.stat(file).then(() => true).catch((error) => {
        if (error.code === "ENOENT") return false
        throw error
      })
      if (exists) return file
    }
  }

  async function files(context: Context, globalPath: string) {
    const paths = [globalPath]
    const seen = new Set([await JsonFile.canonical(globalPath)])
    // Historical callers stored project preferences at their exact cwd, including
    // monorepo subdirectories. Keep those sources alongside the project root.
    for (const directory of new Set([context.directory, context.workingDirectory].filter((value): value is string => !!value))) {
      const local = await localFile(directory)
      if (!local) continue
      const canonical = await JsonFile.canonical(local)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      paths.push(local)
    }
    return paths
  }

  function localEntries(data: JsonFile.Object, context: Context) {
    return entries(data).map((preference) => ({ ...preference, scope: "project" as const, projectID: context.projectID }))
  }

  export async function list(context: Context, globalPath = filename()): Promise<State> {
    const documents = await Promise.all((await files(context, globalPath)).map(JsonFile.read))
    const records = documents.flatMap((document, index) => {
      const preferences = index === 0
        ? entries(document.data).filter((preference) => active(preference, context) || unresolved(preference))
        : localEntries(document.data, context)
      return preferences.map((preference) => ({ ...preference, origin: path.resolve(document.path) }))
    })
    const counts = new Map<string, number>()
    for (const preference of records) counts.set(preference.id, (counts.get(preference.id) ?? 0) + 1)
    const listed = records.map((preference) => ({ ...preference, ambiguous: counts.get(preference.id)! > 1 }))
    const global = listed.filter((preference) => preference.scope === "global")
    const project = listed.filter((preference) => preference.scope === "project" && !unresolved(preference))
    return {
      preferences: [...project, ...global],
      global,
      project,
      unresolved: listed.filter(unresolved),
      projectID: context.projectID,
      directory: context.workingDirectory ?? context.directory,
    }
  }

  export async function add(input: z.infer<typeof Add>, context: Context, globalPath = filename(), signal?: AbortSignal): Promise<Info> {
    signal?.throwIfAborted()
    const parsed = Add.parse(input)
    const scope = parsed.scope ?? "global"
    const preference: Info = {
      id: `pref_${randomUUID()}`,
      content: parsed.content,
      source: parsed.source ?? "user",
      createdAt: Date.now(),
      scope,
      ...(scope === "project" ? { projectID: context.projectID } : {}),
    }
    await JsonFile.update(globalPath, (data) => {
      const preferences = entries(data)
      data.version ??= 1
      data.preferences = [...preferences, preference]
    }, signal)
    return preference
  }

  async function mutate(
    id: string,
    context: Context,
    globalPath: string,
    edit: (preference: Info, isUnresolved: boolean) => Info | undefined,
  ) {
    let result: Info | undefined
    await JsonFile.transaction(await files(context, globalPath), (documents) => {
      const matches = documents.flatMap((document, sourceIndex) =>
        entries(document.data).flatMap((preference, recordIndex) =>
          preference.id === id && (sourceIndex > 0 || active(preference, context) || unresolved(preference))
            ? [{ document, sourceIndex, recordIndex }]
            : []))
      // Check every visible source under the same locks, including duplicate IDs
      // within one file. Traversal order must never choose what the user meant.
      if (matches.length > 1) throw new AmbiguousError()
      const match = matches[0]
      if (!match) return
      const { document, sourceIndex, recordIndex } = match
      const preferences = entries(document.data)
      const preference = sourceIndex === 0 ? preferences[recordIndex] : localEntries(document.data, context)[recordIndex]
      const updated = edit(preference, sourceIndex === 0 && unresolved(preference))
      if (updated) preferences[recordIndex] = updated
      else preferences.splice(recordIndex, 1)
      document.data.preferences = preferences
      result = updated ?? preference
    })
    return result
  }

  export async function update(id: string, input: z.infer<typeof Update>, context: Context, globalPath = filename()) {
    const parsed = Update.parse(input)
    return mutate(id, context, globalPath, (preference, isUnresolved) => {
      if (parsed.assignToCurrentProject && !isUnresolved) throw new Error("Only unassigned legacy preferences can be assigned")
      return {
        ...preference,
        ...(parsed.content !== undefined ? { content: parsed.content } : {}),
        ...(parsed.assignToCurrentProject ? { projectID: context.projectID } : {}),
      }
    })
  }

  export async function remove(id: string, context: Context, globalPath = filename()) {
    return !!await mutate(id, context, globalPath, () => undefined)
  }

  export function format(preferences: Info[]) {
    if (!preferences.length) return ""
    const items = preferences.map((preference, index) =>
      `${index + 1}. [${preference.scope}] ${preference.content}`).join("\n")
    return `<user-preferences>\n以下是用户设置的偏好，请在回复中遵循这些偏好；项目偏好仅适用于当前项目。\n\n${items}\n</user-preferences>`
  }

  export async function prompt(context: Context, globalPath = filename()) {
    return format((await list(context, globalPath)).preferences)
  }
}
