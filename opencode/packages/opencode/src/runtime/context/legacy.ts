import path from "path"
import { Instance } from "@/project/instance"
import { RuntimeContextPipeline } from "@/runtime/context/pipeline"
import type { ContextBlock } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimeContextLegacy {
  export function environmentBlocks(system: string[]): ContextBlock[] {
    return system.map((content, index) => {
      const isConfigPathBlock = content.includes("# Nine1Bot Configuration Paths")
      return RuntimeContextPipeline.textBlock({
        id: isConfigPathBlock ? "runtime:nine1bot-config-paths" : `base:environment-${index + 1}`,
        layer: isConfigPathBlock ? "runtime" : "base",
        source: isConfigPathBlock ? "system.environment.config-paths" : "system.environment",
        content,
        lifecycle: "loop",
        visibility: "system-required",
        priority: 100 - index,
      })
    })
  }

  export function instructionBlocks(system: string[]): ContextBlock[] {
    return system.map((content, index) => {
      const source = instructionSource(content)
      const layer = instructionLayer(source, content)
      return RuntimeContextPipeline.textBlock({
        id: `${layer}:legacy-instruction-${index + 1}`,
        layer,
        source,
        content,
        lifecycle: "loop",
        visibility: layer === "project" ? "system-required" : "developer-toggle",
        priority: 80 - index,
      })
    })
  }

  export function turnSystemBlock(system: string): ContextBlock {
    return RuntimeContextPipeline.textBlock({
      id: "runtime:legacy-turn-system",
      layer: "runtime",
      source: "legacy-user-message.system",
      content: system,
      lifecycle: "turn",
      visibility: "system-required",
      priority: 90,
    })
  }

  function instructionSource(content: string) {
    const firstLine = content.split("\n", 1)[0] ?? ""
    if (firstLine.startsWith("Instructions from: ")) return firstLine.slice("Instructions from: ".length).trim()
    if (content.startsWith("<user-preferences>")) return "nine1bot.user-preferences"
    if (content.startsWith("<project-context>")) return "nine1bot.project-context"
    return "instruction.system"
  }

  function instructionLayer(source: string, content: string): ContextBlock["layer"] {
    if (content.startsWith("<project-context>")) return "project"
    if (source.startsWith("http://") || source.startsWith("https://")) return "user"
    if (source === "nine1bot.user-preferences") return "user"
    if (source !== "instruction.system" && isInsideWorktree(source)) return "project"
    return "user"
  }

  function isInsideWorktree(filepath: string) {
    const resolved = path.resolve(filepath)
    const root = path.resolve(Instance.worktree)
    return resolved === root || resolved.startsWith(root + path.sep)
  }
}
