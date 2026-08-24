import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { GitLabCiInspectTool } from "./gitlab-ci-inspect"
import { GitLabRepositoryInspectTool } from "./gitlab-repository-inspect"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { SendFileTool } from "./send-file"
import { DisplayFileTool } from "./display_file"
import {
  TerminalCreateTool,
  TerminalViewTool,
  TerminalWriteTool,
  TerminalWaitTool,
  TerminalListTool,
  TerminalCloseTool,
} from "./terminal"
import {
  BrowserStatusTool,
  BrowserLaunchTool,
  BrowserSnapshotTool,
  BrowserScreenshotTool,
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserFillTool,
  BrowserPressKeyTool,
  BrowserScrollTool,
  BrowserWaitTool,
  BrowserDialogTool,
  BrowserLocateTool,
  BrowserFindTool,
  BrowserUploadTool,
  BrowserEvaluateTool,
} from "./browser"
import { getBridgeServer } from "../browser/bridge"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  type Candidate = {
    implementation: Tool.Info
    kind: "builtin" | "custom"
  }

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    for (const dir of await Config.directories()) {
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        const mod = await import(match)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            ...ctx,
            directory: ctx.cwd,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          const result = await def.execute(args as any, pluginCtx)
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(options?: { includeCustom?: boolean }): Promise<Candidate[]> {
    const custom = options?.includeCustom === false
      ? []
      : await state().then((x) => x.custom)
    const config = await Config.get()
    const browserTools = getBridgeServer()
      ? [
        BrowserStatusTool,
        BrowserLaunchTool,
        BrowserSnapshotTool,
        BrowserScreenshotTool,
        BrowserNavigateTool,
        BrowserClickTool,
        BrowserFillTool,
        BrowserPressKeyTool,
        BrowserScrollTool,
        BrowserWaitTool,
        BrowserDialogTool,
        BrowserLocateTool,
        BrowserFindTool,
        BrowserUploadTool,
        BrowserEvaluateTool,
      ]
      : []

    const builtin = [
      InvalidTool,
      ...(["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      GitLabCiInspectTool,
      GitLabRepositoryInspectTool,
      TodoWriteTool,
      TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      SendFileTool,
      DisplayFileTool,
      TerminalCreateTool,
      TerminalViewTool,
      TerminalWriteTool,
      TerminalWaitTool,
      TerminalListTool,
      TerminalCloseTool,
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool, PlanEnterTool] : []),
      ...browserTools,
    ]
    return [
      ...builtin.map((implementation) => ({ implementation, kind: "builtin" as const })),
      ...custom.map((implementation) => ({ implementation, kind: "custom" as const })),
    ]
  }

  async function catalog(options?: { includeCustom?: boolean }) {
    const candidates = await all(options)
    const counts = new Map<string, number>()
    for (const candidate of candidates) {
      const id = candidate.implementation.id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const conflicts = [...counts]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right))
    const conflictIDs = new Set(conflicts)
    return {
      candidates: candidates.filter((candidate) => !conflictIDs.has(candidate.implementation.id)),
      conflicts,
      declaredIDs: [...counts.keys()].sort((left, right) => left.localeCompare(right)),
    }
  }

  export async function ids() {
    return catalog().then((x) => x.candidates.map((candidate) => candidate.implementation.id))
  }

  export async function resolve(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    options?: Pick<Tool.InitContext, "skills"> & { includeCustom?: boolean },
  ) {
    const resolved = await catalog(options)
    const tools = await Promise.all(
      resolved.candidates
        .filter(({ implementation: t }) => {
          // Enable websearch/codesearch for zen users OR via enable flag
          if (t.id === "codesearch" || t.id === "websearch") {
            return model.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async ({ implementation, kind }) => {
          const t = implementation
          using _ = log.time(t.id)
          return {
            id: t.id,
            requireExplicitEnable: t.requireExplicitEnable,
            provenance: { kind, implementation },
            ...(await t.init({ agent, skills: options?.skills })),
          }
        }),
    )
    return {
      tools,
      conflicts: resolved.conflicts,
      declaredIDs: resolved.declaredIDs,
    }
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    options?: Pick<Tool.InitContext, "skills"> & { includeCustom?: boolean },
  ) {
    const resolved = await resolve(model, agent, options)
    return resolved.tools.map(({ provenance: _provenance, ...tool }) => tool)
  }
}
