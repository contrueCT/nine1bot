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
  export type Context = { projectID: string; directory: string }
  export type State = {
    preferences: Info[]
    global: Info[]
    project: Info[]
    unresolved: Info[]
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
  async function localFile(context: Context) {
    for (const name of [".nine1bot/preferences.json", "nine1bot.preferences.json"]) {
      const file = path.join(context.directory, name)
      const exists = await fs.stat(file).then(() => true).catch((error) => {
        if (error.code === "ENOENT") return false
        throw error
      })
      if (exists) return file
    }
  }

  async function files(context: Context, globalPath: string) {
    const local = await localFile(context)
    // A custom global path may intentionally point at the legacy local file.
    if (!local || await JsonFile.canonical(local) === await JsonFile.canonical(globalPath)) return [globalPath]
    return [globalPath, local]
  }

  function localEntries(data: JsonFile.Object, context: Context) {
    return entries(data).map((preference) => ({ ...preference, scope: "project" as const, projectID: context.projectID }))
  }

  export async function list(context: Context, globalPath = filename()): Promise<State> {
    const documents = await Promise.all((await files(context, globalPath)).map(JsonFile.read))
    const central = entries(documents[0].data)
    const global = central.filter((preference) => preference.scope === "global")
    const project = [
      ...central.filter((preference) => preference.scope === "project" && active(preference, context)),
      ...(documents[1] ? localEntries(documents[1].data, context) : []),
    ]
    return {
      preferences: [...project, ...global],
      global,
      project,
      unresolved: central.filter(unresolved),
      projectID: context.projectID,
      directory: context.directory,
    }
  }

  export async function add(input: z.infer<typeof Add>, context: Context, globalPath = filename()): Promise<Info> {
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
    })
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
      for (const [index, document] of documents.entries()) {
        const preferences = entries(document.data)
        const found = preferences.findIndex((preference) => preference.id === id &&
          (index > 0 || active(preference, context) || unresolved(preference)))
        if (found === -1) continue
        const preference = index === 0 ? preferences[found] : localEntries(document.data, context)[found]
        const updated = edit(preference, index === 0 && unresolved(preference))
        if (updated) preferences[found] = updated
        else preferences.splice(found, 1)
        document.data.preferences = preferences
        result = updated ?? preference
        break
      }
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
