import { Slug } from "@opencode-ai/util/slug"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SessionUploads } from "./uploads"
import { Filesystem } from "../util/filesystem"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Identifier } from "../id/id"
import { Installation } from "../installation"

import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { SessionPrompt } from "./prompt"
import { RunLease } from "./run-lease"
import { SessionRequest } from "./request"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Global } from "@/global"
import { RuntimeFeatureFlags } from "@/runtime/config/feature-flags"
import { SessionProfileCompiler } from "@/runtime/session/profile-compiler"
import { SessionRuntimeProfile } from "@/runtime/session/profile"
import type { SessionProfileSnapshot } from "@/runtime/protocol/agent-run-spec"
import { RuntimeContextEvents } from "@/runtime/context/events"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"

export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  export const Client = z.object({
    source: z.enum(["web", "browser-extension", "feishu", "api", "webhook", "schedule"]).optional(),
    mode: z.string().optional(),
    platform: z.string().optional(),
  })
  export type Client = z.output<typeof Client>

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      slug: z.string(),
      projectID: z.string(),
      directory: z.string(),
      client: Client.optional(),
      parentID: Identifier.schema("session").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      runtime: SessionRuntimeProfile.Summary.optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const ShareInfo = z
    .object({
      secret: z.string(),
      url: z.string(),
    })
    .meta({
      ref: "SessionShare",
    })
  export type ShareInfo = z.output<typeof ShareInfo>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
        directory: z.string().optional().meta({
          description: "Working directory for the session. Defaults to server's current directory if not specified.",
        }),
      })
      .optional(),
    async (input) => {
      // Use provided directory or fall back to Instance.directory
      const directory = input?.directory || Instance.directory
      return createNext({
        parentID: input?.parentID,
        directory,
        title: input?.title,
        permission: input?.permission,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      // Keep source deletion/execution out of the attachment snapshot window.
      const lease = RunLease.reserve(input.sessionID)
      try {
        return await forkSession(input)
      } finally {
        RunLease.release(input.sessionID, lease.id)
      }
    },
  )

  async function forkSession(input: { sessionID: string; messageID?: string }) {
    const parentSession = await get(input.sessionID)
    const childID = Identifier.descending("session")
    let runtimeProfile: SessionProfileSnapshot | undefined
    let runtimeCurrentModel: SessionRuntimeProfile.CurrentModel | undefined
    if (await RuntimeFeatureFlags.profileSnapshotEnabled()) {
      const forked = await SessionRuntimeProfile.cloneForFork(parentSession, {
        id: childID,
        projectID: parentSession.projectID,
      })
      if (forked) {
        runtimeProfile = forked.snapshot
        runtimeCurrentModel = forked.summary.currentModel
      } else {
        runtimeProfile = await SessionProfileCompiler.compile({
          session: { ...parentSession, id: childID, runtime: undefined },
          directory: parentSession.directory,
          permission: parentSession.permission,
          source: "legacy-resumed",
        })
      }
    }
    const session = await createNext({
      id: childID,
      directory: parentSession.directory,
      permission: parentSession.permission,
      client: parentSession.client,
      runtimeProfile,
      runtimeCurrentModel,
    })
    try {
      const msgs = (await messages({ sessionID: input.sessionID }))
        .filter((msg) => !input.messageID || msg.info.id < input.messageID)
      const uploadsRoot = path.join(parentSession.directory, ".nine1bot", "uploads")
      const copies = new Map<string, string>()
      const sourcePaths = new Map<string, string>()
      const fileTools = new Set(["preview_file", "display_file", "send_file"])
      const copyUpload = async (source: string, filename?: string) => {
        if (!Filesystem.contains(uploadsRoot, source) || copies.has(source)) return
        const target = await SessionUploads.createTarget(uploadsDirectory(session), filename ?? path.basename(source))
        await fs.copyFile(source, target.tempFilePath)
        await fs.rename(target.tempFilePath, target.filePath)
        copies.set(source, target.filePath)
      }
      const references = msgs.flatMap((msg) => msg.parts.flatMap((part) =>
        part.type === "file" ? [part] : part.type === "tool" && part.state.status === "completed"
          ? part.state.attachments ?? [] : [],
      ))
      for (const part of references) {
        if (!part.url.startsWith("file:")) continue
        const raw = part.url.startsWith("file:///") ? part.url.slice(7) : undefined
        let decoded: string | undefined
        try { decoded = fileURLToPath(part.url) } catch {}
        // Older writers concatenated file:// with a raw path. The filename
        // disambiguates literal %20/#/? from correctly encoded new references.
        const legacy = raw && part.filename === path.basename(raw) && Filesystem.contains(uploadsRoot, raw)
          && await fs.stat(raw).then((stat) => stat.isFile()).catch(() => false)
        const source = legacy ? raw : decoded
        if (!source) throw new Error(`Invalid attachment URL: ${part.url}`)
        sourcePaths.set(part.url, source)
        // Include references made by older forks into another session's uploads.
        await copyUpload(source, part.filename)
      }
      for (const part of msgs.flatMap(msg => msg.parts)) {
        if (part.type !== "tool" || part.state.status !== "completed" || !fileTools.has(part.tool.toLowerCase())) continue
        const source = part.state.metadata?.path
        if (typeof source !== "string") continue
        const filename = part.state.metadata?.filename
        await copyUpload(path.resolve(parentSession.directory, source), typeof filename === "string" ? filename : undefined)
      }
      const cloneFile = (part: MessageV2.FilePart): MessageV2.FilePart => {
        const source = sourcePaths.get(part.url)
        const target = source ? copies.get(source) : undefined
        return target ? {
          ...part,
          url: pathToFileURL(target).href,
          ...(part.source?.type === "file" && part.source.path === source
            ? { source: { ...part.source, path: target } } : {}),
        } : part
      }
      const idMap = new Map<string, string>()
      for (const msg of msgs) {
        const newID = Identifier.ascending("message")
        idMap.set(msg.info.id, newID)
        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })
        for (const original of msg.parts) {
          let part = original.type === "file" ? cloneFile(original) : structuredClone(original)
          if (part.type === "tool" && part.state.status === "completed" && part.state.attachments) {
            part.state.attachments = part.state.attachments.map((attachment) => ({
              ...cloneFile(attachment),
              id: Identifier.ascending("part"),
              messageID: cloned.id,
              sessionID: session.id,
            }))
          }
          if (part.type === "tool" && part.state.status === "completed" && fileTools.has(part.tool.toLowerCase())) {
            const source = part.state.metadata?.path
            const target = typeof source === "string" ? copies.get(path.resolve(parentSession.directory, source)) : undefined
            if (target) {
              part.state.metadata = { ...part.state.metadata, path: target }
              // Preview registry tokens belong to the original live preview.
              // Forked history reopens its independent file via metadata.path.
              delete part.state.metadata.previewId
            }
            const inputPath = part.state.input.path
            const inputTarget = typeof inputPath === "string" ? copies.get(path.resolve(parentSession.directory, inputPath)) : undefined
            if (inputTarget) part.state.input = { ...part.state.input, path: inputTarget }
          }
          if (part.type === "text" && part.synthetic) {
            for (const [source, target] of copies) {
              part.text = part.text.replaceAll(`File saved to: ${source}\n`, `File saved to: ${target}\n`)
            }
          }
          await updatePart({ ...part, id: Identifier.ascending("part"), messageID: cloned.id, sessionID: session.id })
        }
      }
      return session
    } catch (error) {
      // A failed copy must not leave a visible, partially cloned conversation.
      await remove(session.id)
      throw error
    }
  }

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
    runtimeProfile?: SessionProfileSnapshot
    runtimeCurrentModel?: SessionRuntimeProfile.CurrentModel
    runtimeAgentName?: string
    client?: Client
  }) {
    const result: Info = {
      id: Identifier.descending("session", input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: await Instance.normalizeDirectory(input.directory),
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    if (input.client) result.client = input.client
    if (await RuntimeFeatureFlags.profileSnapshotEnabled()) {
      const profile =
        input.runtimeProfile ??
        (await SessionProfileCompiler.compile({
          session: result,
          directory: result.directory,
          permission: result.permission,
          source: "new-session",
          agentName: input.runtimeAgentName,
        }))
      result.runtime = await SessionRuntimeProfile.initialize(result, profile, {
        currentModel: input.runtimeCurrentModel,
      })
    }
    log.info("created", result)
    await Storage.write(["session", Instance.project.id, result.id], result)
    Bus.publish(Event.Created, {
      info: result,
    })
    const cfg = await Config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
      share(result.id)
        .then((share) => {
          update(result.id, (draft) => {
            draft.share = share
          })
        })
        .catch(() => {
          // Silently ignore sharing errors during session creation
        })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode", "plans")
      : path.join(Global.Path.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export function uploadsDirectory(session: Pick<Info, "id" | "directory">) {
    return path.join(session.directory, ".nine1bot", "uploads", session.id)
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const read = await Storage.read<Info>(["session", Instance.project.id, id])
    return read as Info
  })

  export const getShare = fn(Identifier.schema("session"), async (id) => {
    return Storage.read<ShareInfo>(["share", id])
  })

  export const share = fn(Identifier.schema("session"), async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)
    await update(
      id,
      (draft) => {
        draft.share = {
          url: share.url,
        }
      },
      { touch: false },
    )
    return share
  })

  export const unshare = fn(Identifier.schema("session"), async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)
    await update(
      id,
      (draft) => {
        draft.share = undefined
      },
      { touch: false },
    )
  })

  export async function update(id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    const project = Instance.project
    const result = await Storage.update<Info>(["session", project.id, id], (draft) => {
      editor(draft)
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
    })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
    }),
    async (input) => {
      const result = [] as MessageV2.WithParts[]
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export async function* list() {
    const project = Instance.project
    const keys = await Storage.list(["session", project.id])
    // Preserve the storage order while reading a bounded batch concurrently.
    const batchSize = 8
    for (let index = 0; index < keys.length; index += batchSize) {
      const batch = await Promise.all(
        keys.slice(index, index + batchSize).map(async (item) => {
          try {
            return await Storage.read<Info>(item)
          } catch (e) {
            if (Storage.NotFoundError.isInstance(e) || Storage.CorruptedError.isInstance(e)) return undefined
            throw e
          }
        }),
      )
      for (const session of batch) {
        if (session) yield session
      }
    }
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const project = Instance.project
    const result = [] as Session.Info[]
    for (const item of await Storage.list(["session", project.id])) {
      const session = await Storage.read<Info>(item)
      if (session.parentID !== parentID) continue
      result.push(session)
    }
    return result
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    const project = Instance.project
    const lease = RunLease.reserve(sessionID)
    try {
      const session = await get(sessionID)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      await unshare(sessionID).catch(() => {})
      await fs.rm(uploadsDirectory(session), { recursive: true, force: true })
      for (const msg of await Storage.list(["message", sessionID])) {
        for (const part of await Storage.list(["part", msg.at(-1)!])) {
          await Storage.remove(part)
        }
        await Storage.remove(msg)
        await SessionRequest.remove(msg.at(-1)!)
      }
      await SessionRequest.removeSession(sessionID)
      await Storage.remove(["session", project.id, sessionID])
      try {
        await SessionRuntimeProfile.remove(session)
        await RuntimeContextEvents.removeAll({ sessionID, projectID: project.id })
      } finally {
        RuntimeResourceResolver.clearSessionState(sessionID)
      }
      Bus.publish(Event.Deleted, {
        info: session,
      })
    } finally {
      RunLease.release(sessionID, lease.id)
    }
  })

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    await Storage.write(["message", msg.sessionID, msg.id], msg)
    Bus.publish(MessageV2.Event.Updated, {
      info: msg,
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await Storage.remove(["message", input.sessionID, input.messageID])
      await SessionRequest.remove(input.messageID)
      Bus.publish(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await Storage.remove(["part", input.messageID, input.partID])
      Bus.publish(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })

      // 检查消息是否还有剩余 parts，如果没有则清理幽灵消息
      const remainingParts = await MessageV2.parts(input.messageID)
      if (remainingParts.length === 0) {
        let msgInfo: MessageV2.Info | undefined
        try {
          msgInfo = await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID])
        } catch {}

        // 移除无 parts 的幽灵消息 info
        await Storage.remove(["message", input.sessionID, input.messageID])
        await SessionRequest.remove(input.messageID)
        Bus.publish(MessageV2.Event.Removed, {
          sessionID: input.sessionID,
          messageID: input.messageID,
        })

        // 如果是 user 消息，级联删除其配对的 assistant 消息（防止消息交替断裂）
        if (msgInfo?.role === "user") {
          const allMessages = await Array.fromAsync(await Storage.list(["message", input.sessionID]))
          for (const item of allMessages) {
            try {
              const info = await Storage.read<MessageV2.Info>(item)
              if (info.role === "assistant" && (info as MessageV2.Assistant).parentID === input.messageID) {
                // 删除 assistant 的所有 parts
                const asstParts = await MessageV2.parts(info.id)
                for (const part of asstParts) {
                  await Storage.remove(["part", info.id, part.id])
                }
                // 删除 assistant 消息 info
                await Storage.remove(["message", input.sessionID, info.id])
                Bus.publish(MessageV2.Event.Removed, {
                  sessionID: input.sessionID,
                  messageID: info.id,
                })
              }
            } catch {}
          }
        }
      }

      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    MessageV2.Part,
    z.object({
      part: MessageV2.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ReasoningPart,
      delta: z.string(),
    }),
  ])

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined
    await Storage.write(["part", part.messageID, part.id], part)
    Bus.publish(MessageV2.Event.PartUpdated, {
      part,
      delta,
    })
    return part
  })

  export const publishPartDelta = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
      field: z.literal("text"),
      delta: z.string(),
    }),
    async (input) => {
      await Bus.publish(MessageV2.Event.PartDelta, input)
      return input
    },
  )

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const cachedInputTokens = input.usage.cachedInputTokens ?? 0
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = excludesCachedTokens
        ? (input.usage.inputTokens ?? 0)
        : (input.usage.inputTokens ?? 0) - cachedInputTokens
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }

      const tokens = {
        input: safe(adjustedInputTokens),
        output: safe(input.usage.outputTokens ?? 0),
        reasoning: safe(input.usage?.reasoningTokens ?? 0),
        cache: {
          write: safe(
            (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
              // @ts-expect-error
              input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
              0) as number,
          ),
          read: safe(cachedInputTokens),
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
