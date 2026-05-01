import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { RuntimeSourceRegistry } from "@/runtime/source/registry"
import { ConfigMarkdown } from "@/config/markdown"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { NamedError } from "@opencode-ai/util/error"
import { GlobalBus } from "@/bus/global"

export namespace Agent {
  const log = Log.create({ service: "agent" })

  export const Source = z.object({
    owner: z.object({
      id: z.string(),
      kind: z.enum(["core", "user", "project", "platform", "capability"]),
    }),
    sourceID: z.string(),
    visibility: z.enum(["declared-only", "recommendable", "user-selectable"]),
  })
  export type Source = z.infer<typeof Source>

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
      source: Source.optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>
  export type ListOptions = {
    includeRecommendable?: boolean
    includeDeclaredOnly?: boolean
  }

  export const Unavailable = BusEvent.define(
    "runtime.agent.unavailable",
    z.object({
      sessionID: z.string(),
      turnSnapshotId: z.string().optional(),
      agent: z.string(),
      owner: z.string().optional(),
      sourceID: z.string().optional(),
      status: z.literal("unavailable"),
      reason: z.enum(["disabled-by-current-config", "missing-source", "invalid-agent"]),
      message: z.string(),
      recoverable: z.boolean(),
      action: z
        .object({
          type: z.enum(["open-settings", "new-session"]),
          label: z.string(),
        })
        .optional(),
    }),
  )

  export const UnavailableError = NamedError.create(
    "AgentUnavailableError",
    z.object({
      agent: z.string(),
      reason: z.enum(["disabled-by-current-config", "missing-source", "invalid-agent"]),
      message: z.string(),
    }),
  )

  const PLATFORM_AGENT_GLOB = new Bun.Glob("**/*.agent.md")
  let cachedAgents: Record<string, Info> | undefined
  let cachedAgentKey: string | undefined

  GlobalBus.on("event", (event) => {
    if (event.payload?.type !== "server.instance.disposed") return
    cachedAgents = undefined
    cachedAgentKey = undefined
  })

  async function loadAgents(): Promise<Record<string, Info>> {
    const cfg = await Config.get()

    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        [Truncate.DIR]: "allow",
        [Truncate.GLOB]: "allow",
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      build: {
        name: "build",
        description: "The default agent. Executes tools based on configured permissions.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".opencode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      applyConfigAgent(result, key, value, defaults, user)
    }

    await scanRuntimeAgentSources(result, defaults, user)

    // Ensure Truncate.DIR is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.DIR || r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.DIR]: "allow", [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  }

  async function scanRuntimeAgentSources(
    result: Record<string, Info>,
    defaults: PermissionNext.Ruleset,
    user: PermissionNext.Ruleset,
  ) {
    for (const runtimeSource of RuntimeSourceRegistry.list().agents) {
      if (!runtimeSource.owner.enabled) continue
      if (!(await Filesystem.isDir(runtimeSource.directory))) {
        log.debug("skip missing runtime agent source directory", {
          owner: runtimeSource.owner.id,
          source: runtimeSource.id,
          directory: runtimeSource.directory,
        })
        continue
      }

      const matches = await Array.fromAsync(
        PLATFORM_AGENT_GLOB.scan({
          cwd: runtimeSource.directory,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        }),
      ).catch((error) => {
        log.error("failed runtime agent source directory scan", {
          owner: runtimeSource.owner.id,
          source: runtimeSource.id,
          directory: runtimeSource.directory,
          error,
        })
        return []
      })

      const source: Source = {
        owner: {
          id: runtimeSource.owner.id,
          kind: runtimeSource.owner.kind,
        },
        sourceID: runtimeSource.id,
        visibility: runtimeSource.visibility,
      }

      for (const match of matches) {
        const md = await ConfigMarkdown.parse(match).catch((error) => {
          log.error("failed to load runtime agent source item", { agent: match, error })
          return undefined
        })
        if (!md) continue

        const name = typeof md.data.name === "string" && md.data.name.trim()
          ? md.data.name.trim()
          : path.basename(match, ".agent.md")
        const config = {
          ...md.data,
          name,
          prompt: md.content.trim(),
        }
        const parsed = Config.Agent.safeParse(config)
        if (!parsed.success) {
          log.error("invalid runtime agent source item", { agent: match, issues: parsed.error.issues })
          continue
        }

        const existing = result[name]
        if (existing && existing.source?.owner.kind !== "platform") {
          log.debug("skip platform agent override over non-platform agent", {
            name,
            existing: existing.name,
            skipped: match,
          })
          continue
        }
        if (existing) {
          log.debug("platform agent override", {
            name,
            previous: existing.name,
            newLocation: match,
          })
        }

        applyConfigAgent(result, name, parsed.data, defaults, user, source)
      }
    }
  }

  function applyConfigAgent(
    result: Record<string, Info>,
    key: string,
    value: Config.Agent,
    defaults: PermissionNext.Ruleset,
    user: PermissionNext.Ruleset,
    source?: Source,
  ) {
    if (value.disable) {
      delete result[key]
      return
    }
    let item = result[key]
    if (!item) {
      item = result[key] = {
        name: key,
        mode: "all",
        permission: PermissionNext.merge(defaults, user),
        options: {},
        native: false,
        source,
      }
    }
    if (source) item.source = source
    if (value.model) item.model = Provider.parseModel(value.model)
    item.prompt = value.prompt ?? item.prompt
    item.description = value.description ?? item.description
    item.temperature = value.temperature ?? item.temperature
    item.topP = value.top_p ?? item.topP
    item.mode = value.mode ?? item.mode
    item.color = value.color ?? item.color
    item.hidden = value.hidden ?? item.hidden
    item.name = value.name ?? item.name
    item.steps = value.steps ?? item.steps
    item.options = mergeDeep(item.options, value.options ?? {})
    item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
  }

  async function state() {
    const cacheKey = agentCacheKey()
    if (cachedAgents && cachedAgentKey === cacheKey) return cachedAgents
    cachedAgents = await loadAgents()
    cachedAgentKey = cacheKey
    return cachedAgents
  }

  function agentCacheKey() {
    return JSON.stringify({
      directory: Instance.directory,
      worktree: Instance.worktree,
      config: RuntimeSourceRegistry.version(),
    })
  }

  function isVisible(agent: Info, options?: ListOptions) {
    const visibility = agent.source?.visibility
    if (!visibility || visibility === "user-selectable") return true
    if (visibility === "recommendable") return options?.includeRecommendable || options?.includeDeclaredOnly
    if (visibility === "declared-only") return options?.includeDeclaredOnly
    return false
  }

  function isPlatformAgent(agent: Info) {
    return agent.source?.owner.kind === "platform"
  }

  export async function get(agent: string, options?: ListOptions): Promise<Info | undefined> {
    const item = await state().then((x) => x[agent])
    if (!item) return undefined
    return isVisible(item, options) ? item : undefined
  }

  export async function mustGet(agent: string, options?: ListOptions): Promise<Info> {
    const item = await get(agent, options)
    if (!item) throw new Error(`Agent not found: ${agent}`)
    return item
  }

  export async function list(options?: ListOptions) {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      (items) => items.filter((item) => isVisible(item, options)),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"]),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (isPlatformAgent(agent)) throw new Error(`default agent "${cfg.default_agent}" is a platform agent`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find(
      (a) => a.mode !== "subagent" && a.hidden !== true && !isPlatformAgent(a),
    )
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
