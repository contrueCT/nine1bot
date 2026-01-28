import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import { Config } from "../config/config"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_AUTONOMOUS from "./prompt/autonomous.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import type { Provider } from "@/provider/provider"

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    const basePrompts = [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<files>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 200,
              })
            : ""
        }`,
        `</files>`,
      ].join("\n"),
    ]

    // Add autonomous and sandbox prompts based on configuration
    const modePrompts = await autonomousPrompt()
    return [...basePrompts, ...modePrompts]
  }

  export async function autonomousPrompt(): Promise<string[]> {
    const config = await Config.get()
    const prompts: string[] = []

    // Autonomous mode prompt (enabled by default)
    if (config.autonomous?.enabled !== false) {
      prompts.push(PROMPT_AUTONOMOUS)
    }

    // Sandbox environment information
    if (config.sandbox?.enabled !== false) {
      const sandboxRoot = config.sandbox?.directory || Instance.directory
      const allowedPaths = config.sandbox?.allowedPaths || []
      const denyPaths = config.sandbox?.denyPaths || []

      prompts.push(
        [
          "",
          "# Sandbox Environment",
          "",
          "IMPORTANT: You are operating in a sandboxed environment with restricted file access.",
          "",
          `- Sandbox root: ${sandboxRoot}`,
          `- Additional allowed paths: ${allowedPaths.length > 0 ? allowedPaths.join(", ") : "none"}`,
          `- Blocked paths: ${denyPaths.length > 0 ? denyPaths.join(", ") : "none"}`,
          "",
          "All file operations outside the sandbox will be blocked. Do not attempt to access restricted paths.",
        ].join("\n"),
      )
    }

    return prompts
  }
}
