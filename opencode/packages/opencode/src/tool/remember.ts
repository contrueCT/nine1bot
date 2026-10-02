import z from "zod"
import { Tool } from "./tool"
import { rememberPermissionDescription } from "../preferences/permission"
import { Preferences } from "../preferences"
import { Project } from "../project/project"
import { Instance } from "../project/instance"

export const RememberTool = Tool.define("remember", {
  description: "Save a preference only when the user explicitly asks you to remember it. Specify global for all projects or project for this session's project. Do not save credentials or secrets. Ask the user if the scope is unclear. Uses the local preference store without HTTP or server credentials.",
  parameters: z.object({
    content: Preferences.Content.describe("The preference explicitly requested by the user, without secrets"),
    scope: z.enum(["global", "project"]).describe("Required scope: all projects or this session's project"),
  }),
  async execute(input, ctx) {
    if (!Preferences.enabled()) throw new Error("Preferences are only available in Nine1Bot")
    // cwd is supplied by the session executor, never by model arguments.
    const directory = await Instance.normalizeDirectory(ctx.cwd)
    const { project } = await Project.fromDirectory(directory)
    const context = { projectID: project.id, directory: project.rootDirectory, workingDirectory: directory }
    const content = Preferences.Content.parse(input.content)
    const metadata = { content, scope: input.scope, directory: context.directory }
    await ctx.ask({
      permission: "remember",
      patterns: [input.scope === "global" ? "global" : `project:${project.id}`],
      always: [input.scope === "global" ? "global" : `project:${project.id}`],
      metadata: { ...metadata, description: rememberPermissionDescription(metadata) },
    })
    const preference = await Preferences.add({ ...input, content, source: "ai" }, context)
    return { title: "Preference saved", output: JSON.stringify(preference), metadata: { preference } }
  },
})
