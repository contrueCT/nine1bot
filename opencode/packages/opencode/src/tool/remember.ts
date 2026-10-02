import z from "zod"
import { Tool } from "./tool"
import { rememberPermissionDescription } from "../preferences/permission"
import { Preferences } from "../preferences"
import { preferenceContext } from "../preferences/context"

export const RememberTool = Tool.define("remember", {
  description: "Save a preference only when the user explicitly asks you to remember it. Specify global for all projects or project for this session's project. Do not save credentials or secrets. Ask the user if the scope is unclear. Uses the local preference store without HTTP or server credentials.",
  parameters: z.object({
    content: Preferences.Content.describe("The preference explicitly requested by the user, without secrets"),
    scope: z.enum(["global", "project"]).describe("Required scope: all projects or this session's project"),
  }),
  async execute(input, ctx) {
    ctx.abort.throwIfAborted()
    if (!Preferences.enabled()) throw new Error("Preferences are only available in Nine1Bot")
    // cwd is supplied by the session executor, never by model arguments.
    // Re-discovery after a first Git commit can change the ID mid-session.
    const context = await preferenceContext(ctx.cwd)
    ctx.abort.throwIfAborted()
    const content = Preferences.Content.parse(input.content)
    const metadata = { content, scope: input.scope, directory: context.directory }
    await ctx.ask({
      permission: "remember",
      patterns: [input.scope === "global" ? "global" : `project:${context.projectID}`],
      always: [input.scope === "global" ? "global" : `project:${context.projectID}`],
      metadata: { ...metadata, description: rememberPermissionDescription(metadata) },
    })
    ctx.abort.throwIfAborted()
    const preference = await Preferences.add({ ...input, content, source: "ai" }, context, undefined, ctx.abort)
    return { title: "Preference saved", output: JSON.stringify(preference), metadata: { preference } }
  },
})
