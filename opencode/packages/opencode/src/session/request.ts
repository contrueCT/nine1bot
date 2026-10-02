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
  type Receipt = {
    sessionID: string
    hash: string
    turnSnapshotId?: string
    messageID?: string
    state?: "reserved" | "accepted" // absent on legacy message-ID receipts
  }
  const key = (messageID: string) => ["message_request", messageID]
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const requestKey = (requestID: string) => ["client_message_request", digest(requestID)]
  const originKey = (messageID: string) => ["message_request_origin", messageID]
  const inputKey = (input: Pick<SessionPrompt.PromptInput, "messageID" | "requestID">) =>
    input.requestID ? requestKey(input.requestID) : input.messageID ? key(input.messageID) : undefined

  async function read<T>(key: string[]) {
    return Storage.read<T>(key).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
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
  function hash(input: SessionPrompt.PromptInput) {
    const { parts, model, agent, system, tools, variant, noReply, context } = input
    return createHash("sha256")
      .update(JSON.stringify(stable({ parts, model, agent, system, tools, variant, noReply, context })))
      .digest("hex")
  }
  export function assertIdentity(input: { messageID?: string; requestID?: string }) {
    if (input.messageID !== undefined && input.requestID !== undefined) {
      throw new HTTPException(400, { message: "Provide requestID or messageID, not both" })
    }
  }
  function verify(input: SessionPrompt.PromptInput, receipt: Receipt) {
    if (receipt.sessionID !== input.sessionID || receipt.hash !== hash(input)) {
      throw new HTTPException(409, {
        message: "Request ID already belongs to another request; reload the conversation before retrying",
      })
    }
  }
  export async function replay(input: SessionPrompt.PromptInput) {
    const target = inputKey(input)
    if (!target) return undefined
    const receipt = await read<Receipt>(target)
    if (!receipt) return undefined
    verify(input, receipt)
    return receipt.state === "reserved" ? undefined : receipt
  }
  export async function isAccepted(sessionID: string, messageID?: string, requestID?: string) {
    const target = inputKey({ messageID, requestID })
    if (!target) return false
    const receipt = await read<Receipt>(target)
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
    const previous = await read<Receipt>(target)
    if (previous) {
      verify(input, previous)
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
    await Storage.write<Receipt>(target, {
      sessionID: input.sessionID,
      hash: hash(input),
      messageID,
      turnSnapshotId: input.runtimeTurnSnapshotId,
      state: "reserved",
    })
    await Storage.write(originKey(messageID), { requestID: input.requestID })
    return messageID
  }

  export async function accept(input: SessionPrompt.PromptInput) {
    const target = inputKey(input)
    if (!target) return
    await Storage.write<Receipt>(target, {
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
      const receipt = await read<Receipt>(target)
      if (receipt?.messageID === messageID) await Storage.remove(target)
      await Storage.remove(originKey(messageID))
    }
    await Storage.remove(key(messageID))
  }
}
