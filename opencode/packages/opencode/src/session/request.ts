import { createHash } from "node:crypto"
import z from "zod"
import { HTTPException } from "hono/http-exception"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { Identifier } from "../id/id"
import type { SessionPrompt } from "./prompt"

/** Client request identity is separate from the server's chronological message IDs. */
export namespace SessionRequest {
  export const ID = z.string().regex(/^req_[A-Za-z0-9_-]{1,124}$/)
  const Receipt = z.object({
    sessionID: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    turnSnapshotId: z.string().optional(),
    messageID: z.string().optional(),
    state: z.enum(["reserved", "accepted"]).optional(), // absent on legacy receipts
  })
  type Receipt = z.infer<typeof Receipt>
  const key = (messageID: string) => ["message_request", messageID]
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const requestKey = (requestID: string) => ["client_message_request", digest(requestID)]
  const originKey = (messageID: string) => ["message_request_origin", messageID]
  const indexKey = (sessionID: string, target: string[]) => ["session_message_request", sessionID, digest(target.join("/"))]
  const inputKey = (input: Pick<SessionPrompt.PromptInput, "messageID" | "requestID">) =>
    input.requestID ? requestKey(input.requestID) : input.messageID ? key(input.messageID) : undefined

  async function read<T>(key: string[]) {
    return Storage.read<T>(key, { preserveCorrupted: true }).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
  }
  function requestError(code: string, message: string) {
    return new HTTPException(409, { res: Response.json({ error: { code, message } }, { status: 409 }) })
  }
  async function readReceipt(target: string[]) {
    const value = await read<unknown>(target)
    if (value === undefined) return undefined
    const parsed = Receipt.safeParse(value)
    if (!parsed.success || (target[0] === "client_message_request" && (!parsed.data.messageID || !parsed.data.state))) {
      throw requestError("REQUEST_CORRUPTED", "请求回执已损坏，已停止重试以避免重复执行，请检查会话记录。")
    }
    return parsed.data
  }
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, stable(value)]),
      )
    return value
  }
  export function fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")
  }
  function hash(input: SessionPrompt.PromptInput) {
    if (input.requestID && input.runtimeRequestFingerprint) return input.runtimeRequestFingerprint
    const { parts, model, agent, system, tools, variant, noReply, context } = input
    return fingerprint({ parts, model, agent, system, tools, variant, noReply, context })
  }
  export function freeze(input: SessionPrompt.PromptInput): SessionPrompt.PromptInput {
    return input.requestID ? { ...input, runtimeRequestFingerprint: hash(input) } : input
  }
  export function assertIdentity(input: { messageID?: string; requestID?: string }) {
    if (input.messageID !== undefined && input.requestID !== undefined) {
      throw new HTTPException(400, { message: "Provide requestID or messageID, not both" })
    }
  }
  function verify(sessionID: string, fingerprint: string, receipt: Receipt) {
    if (receipt.sessionID !== sessionID || receipt.hash !== fingerprint) {
      throw requestError("REQUEST_CONFLICT", "Request ID already belongs to another request; reload the conversation before retrying")
    }
  }
  export async function replay(input: SessionPrompt.PromptInput) {
    const target = inputKey(input)
    if (!target) return undefined
    const receipt = await readReceipt(target)
    if (!receipt) return undefined
    verify(input.sessionID, hash(input), receipt)
    return receipt.state === "reserved" ? undefined : receipt
  }
  // The controller can replay accepted wire requests before mutable enrichment/compilation.
  export async function replayClient(sessionID: string, requestID: string, fingerprint: string) {
    const receipt = await readReceipt(requestKey(requestID))
    if (!receipt) return undefined
    verify(sessionID, fingerprint, receipt)
    return receipt.state === "accepted" ? receipt : undefined
  }
  export async function isAccepted(sessionID: string, messageID?: string, requestID?: string) {
    const target = inputKey({ messageID, requestID })
    if (!target) return false
    const receipt = await readReceipt(target)
    return receipt?.sessionID === sessionID && receipt.state !== "reserved"
  }
  export async function lock(messageID?: string, requestID?: string): Promise<Disposable> {
    const target = inputKey({ messageID, requestID })
    return target ? Lock.write(`message-request:${target.join(":")}`) : { [Symbol.dispose]() {} }
  }
  export async function assertNew(input: SessionPrompt.PromptInput) {
    if (!input.messageID) return
    const messages = await read(["message", input.sessionID, input.messageID])
    const parts = await Storage.list(["part", input.messageID])
    if (messages || parts.length)
      throw new HTTPException(409, { message: "Message ID already exists; reload the conversation before retrying" })
  }

  /** Called under the request lock and session lease, before any user-message writes. */
  export async function prepare(input: SessionPrompt.PromptInput) {
    if (!input.requestID) return input.messageID
    const target = requestKey(input.requestID)
    const previous = await readReceipt(target)
    if (previous) {
      verify(input.sessionID, hash(input), previous)
      if (previous.messageID) {
        const message = await read(["message", input.sessionID, previous.messageID])
        const parts = await Storage.list(["part", previous.messageID])
        if (message || parts.length) {
          // A crash/write failure after partial persistence is not proof of acceptance.
          // Keep the mapping and fail closed rather than creating another message.
          throw new HTTPException(409, {
            res: Response.json({ error: { code: "REQUEST_INCOMPLETE", message: "上次请求未完整保存，请检查并清理未完成消息后重试；当前重试已阻止重复提交。" } }, { status: 409 }),
          })
        }
        await Storage.remove(originKey(previous.messageID))
      }
    }
    const messageID = Identifier.ascending("message")
    await Storage.writeAtomic(indexKey(input.sessionID, target), { target })
    await Storage.writeAtomic<Receipt>(target, {
      sessionID: input.sessionID,
      hash: hash(input),
      messageID,
      turnSnapshotId: input.runtimeTurnSnapshotId,
      state: "reserved",
    })
    await Storage.writeAtomic(originKey(messageID), { requestID: input.requestID })
    return messageID
  }

  export async function accept(input: SessionPrompt.PromptInput) {
    const target = inputKey(input)
    if (!target) return
    await Storage.writeAtomic(indexKey(input.sessionID, target), { target })
    await Storage.writeAtomic<Receipt>(target, {
      sessionID: input.sessionID,
      hash: hash(input),
      messageID: input.messageID,
      turnSnapshotId: input.runtimeTurnSnapshotId,
      state: "accepted",
    })
  }
  export async function remove(messageID: string) {
    const origin = await read<{ requestID: string }>(originKey(messageID))
    if (origin) {
      const target = requestKey(origin.requestID)
      const receipt = await readReceipt(target)
      // Removing displayed history is not permission to execute an accepted request again.
      // Only an incomplete reservation can be cleared for explicit recovery.
      if (receipt?.messageID === messageID && receipt.state === "reserved") {
        await Storage.remove(target)
        await Storage.remove(indexKey(receipt.sessionID, target))
      }
      await Storage.remove(originKey(messageID))
    }
    const legacy = await readReceipt(key(messageID))
    if (!legacy || legacy.state === "reserved") await Storage.remove(key(messageID))
    else await Storage.writeAtomic(indexKey(legacy.sessionID, key(messageID)), { target: key(messageID) })
  }
  /** Whole-session deletion removes its metadata too; individual history deletion does not. */
  export async function removeSession(sessionID: string) {
    for (const entry of await Storage.list(["session_message_request", sessionID])) {
      const indexed = await read<{ target?: unknown }>(entry)
      const target = indexed?.target
      if (!Array.isArray(target) || target.length !== 2 || typeof target[1] !== "string" ||
        (!(target[0] === "client_message_request" && /^[a-f0-9]{64}$/.test(target[1])) &&
         !(target[0] === "message_request" && /^msg[A-Za-z0-9_-]*$/.test(target[1])))) {
        throw requestError("REQUEST_CORRUPTED", "会话回执索引已损坏，请检查后再删除会话。")
      }
      const receipt = await readReceipt(target)
      // A failed reservation may leave an index before a different session claims that ID.
      if (receipt?.sessionID === sessionID) {
        await Storage.remove(target)
        if (receipt.messageID) await Storage.remove(originKey(receipt.messageID))
      }
      await Storage.remove(entry)
    }
  }
}
