import { afterEach, beforeEach, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { Server } from "../../src/server/server"
import { Plugin } from "../../src/plugin"
import { SessionRequest } from "../../src/session/request"
import { Bus } from "../../src/bus"
import { RuntimeControllerEvents } from "../../src/runtime/controller/events"
import { RunLease } from "../../src/session/run-lease"
import { tmpdir } from "../fixture/fixture"

let previous: NodeJS.ProcessEnv
beforeEach(() => {
  previous = { ...process.env }
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
  Object.assign(process.env, previous)
})
async function fixture(fn: (session: Session.Info) => Promise<void>) {
  await using tmp = await tmpdir({ config: { model: "test/model" } })
  process.env.OPENCODE_CONFIG = tmp.path + "/opencode.json"
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fn(await Session.create({}))
    },
  })
}

test("the same accepted request replays without duplicate parts, including after instance reload", async () => {
  await fixture(async (session) => {
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      noReply: true,
      model: { providerID: "test", modelID: "model" },
      parts: [{ type: "text" as const, text: "retry me" }],
    }
    await SessionPrompt.promptAsync(input)
    expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
    const messages = await Session.messages({ sessionID: session.id })
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toHaveLength(1)
    await Instance.dispose()
    await Instance.provide({
      directory: session.directory,
      fn: async () => {
        expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
        expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
      },
    })
  })
})

test("the same ID with different content or another session is rejected", async () => {
  await fixture(async (session) => {
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      noReply: true,
      parts: [{ type: "text" as const, text: "original" }],
    }
    await SessionPrompt.promptAsync(input)
    await expect(
      SessionPrompt.promptAsync({ ...input, parts: [{ type: "text", text: "changed" }] }),
    ).rejects.toMatchObject({ status: 409 })
    const other = await Session.create({})
    await expect(SessionPrompt.promptAsync({ ...input, sessionID: other.id })).rejects.toMatchObject({ status: 409 })
    expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
    expect(await Session.messages({ sessionID: other.id })).toHaveLength(0)
  })
})

test("concurrent submissions cannot create duplicate parts", async () => {
  await fixture(async (session) => {
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      noReply: true,
      parts: [{ type: "text" as const, text: "once" }],
    }
    const results = await Promise.allSettled([SessionPrompt.promptAsync(input), SessionPrompt.promptAsync(input)])
    expect(results.some((result) => result.status === "fulfilled")).toBe(true)
    expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
  })
})

test("controller replay returns the original turn identity even while another turn holds the lease", async () => {
  await fixture(async (session) => {
    const send = (body: unknown) =>
      Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory },
        body: JSON.stringify(body),
      })
    const body = { messageID: Identifier.ascending("message"), noReply: true, parts: [{ type: "text", text: "once" }] }
    const first = await send(body)
    expect(first.status).toBe(202)
    const original = await first.json()
    const lease = RunLease.reserve(session.id)
    try {
      const second = await send(body)
      expect(second.status).toBe(202)
      expect((await second.json()).turnSnapshotId).toBe(original.turnSnapshotId)
      expect(RunLease.current(session.id)?.id).toBe(lease.id)
    } finally {
      RunLease.release(session.id, lease.id)
    }
    expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
  })
})

test("cancellation from the real chat.message hook preserves complete text and a replay receipt after reload", async () => {
  await fixture(async (session) => {
    const controller = new AbortController()
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      runtimeTurnSnapshotId: "turn_cancelled_during_admission",
      model: { providerID: "test", modelID: "model" },
      parts: [
        { type: "text" as const, text: "Keep this first part" },
        { type: "text" as const, text: "And this second part" },
      ],
    }
    let hookCalls = 0
    const hook = {
      "chat.message": async () => {
        hookCalls++
        controller.abort(new Error("cancelled in chat.message"))
      },
    }
    const hooks = await Plugin.list()
    hooks.push(hook)
    const terminal: string[] = []
    const unsubscribe = Bus.subscribe(RuntimeControllerEvents.TurnCancelled, (event) => {
      if (event.properties.turnSnapshotId) terminal.push(event.properties.turnSnapshotId)
    })
    try {
      await expect(SessionPrompt.prompt(input, controller.signal)).rejects.toThrow("cancelled in chat.message")
      expect(RunLease.current(session.id)).toBeUndefined()
      expect(await SessionRequest.isAccepted(session.id, input.messageID)).toBe(true)
      expect(terminal).toEqual([input.runtimeTurnSnapshotId])
      const persisted = await Session.messages({ sessionID: session.id })
      expect(persisted).toHaveLength(1)
      expect(persisted[0].parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual(
        input.parts.map((part) => part.text),
      )
      expect((await SessionPrompt.prompt(input)).info.id).toBe(input.messageID)
      expect(hookCalls).toBe(1)
      await Instance.dispose()
      await Instance.provide({
        directory: session.directory,
        fn: async () => {
          expect(await SessionRequest.isAccepted(session.id, input.messageID)).toBe(true)
          expect((await SessionPrompt.prompt(input)).info.id).toBe(input.messageID)
          expect(await SessionPrompt.promptAsync(input)).toEqual({
            replayed: true,
            turnSnapshotId: input.runtimeTurnSnapshotId,
          })
          const replayed = await Session.messages({ sessionID: session.id })
          expect(replayed).toHaveLength(1)
          expect(replayed[0].parts).toHaveLength(2)
          expect(RunLease.current(session.id)).toBeUndefined()
        },
      })
    } finally {
      unsubscribe()
      const index = hooks.indexOf(hook)
      if (index >= 0) hooks.splice(index, 1)
    }
  })
})

async function completeTurn(session: Session.Info, requestID: string) {
  await SessionPrompt.promptAsync({ sessionID: session.id, requestID, noReply: true, parts: [{ type: "text", text: "newer turn" }] })
  const messages = await Session.messages({ sessionID: session.id })
  const user = messages.find(message => message.info.role === "user" && message.info.requestID === requestID)!
  const assistantID = Identifier.ascending("message")
  await Session.updateMessage({
    id: assistantID, sessionID: session.id, role: "assistant", parentID: user.info.id,
    modelID: "model", providerID: "test", mode: "build", agent: "build",
    path: { cwd: session.directory, root: session.directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() }, finish: "stop",
  })
  return assistantID
}

test("late retries and either client clock skew use server chronology and reach the next turn", async () => {
  const { Bus } = await import("../../src/bus")
  const { createMessageSubmission } = await import("../../../../../web/src/api/client")
  for (const clockOffset of [0, -365 * 24 * 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000]) {
    const serverNow = Date.now
    // Build a real Web payload using the client's skewed clock, then restore server time.
    Date.now = () => serverNow() + clockOffset
    let submission: ReturnType<typeof createMessageSubmission>
    try { submission = createMessageSubmission("delayed original request", undefined, undefined, { providerID: "test", modelID: "model" }) }
    finally { Date.now = serverNow }
    const { requestID } = submission
    await fixture(async (session) => {
      const assistantID = await completeTurn(session, "req_newer_" + requestID)
      const errors: string[] = []
      const unsubscribe = Bus.subscribe(Session.Event.Error, event => errors.push(JSON.stringify(event.properties.error)))
      try {
        // Invalid local test model proves the loop reached model resolution; no provider call is possible.
        await SessionPrompt.promptAsync({ ...JSON.parse(submission.body), sessionID: session.id })
        for (let i = 0; i < 200 && RunLease.current(session.id); i++) await Bun.sleep(5)
        expect(RunLease.current(session.id)).toBeUndefined()
        const history = await Session.messages({ sessionID: session.id })
        const retried = history.find(message => message.info.role === "user" && message.info.requestID === requestID)!
        expect(retried.info.id.startsWith("msg_")).toBe(true)
        expect(retried.info.id > assistantID).toBe(true)
        expect(errors.some(error => error.includes("Model not found"))).toBe(true)
      } finally { unsubscribe() }
    })
  }
})

test("requestID replay survives reload and sync replay resolves the server-owned message", async () => {
  await fixture(async session => {
    const input = { sessionID: session.id, requestID: "req_reload", noReply: true, parts: [{ type: "text" as const, text: "once" }] }
    await SessionPrompt.promptAsync(input)
    const original = (await Session.messages({ sessionID: session.id }))[0]
    expect(original.info.id).not.toBe(input.requestID)
    expect(original.info.role === "user" && original.info.requestID).toBe(input.requestID)
    expect((await SessionPrompt.prompt(input)).info.id).toBe(original.info.id)
    await Instance.dispose()
    await Instance.provide({ directory: session.directory, fn: async () => {
      expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
    } })
  })
})

test("concurrent requestID submissions replay inside the same lock without duplicate messages or parts", async () => {
  await fixture(async session => {
    const input = { sessionID: session.id, requestID: "req_concurrent", noReply: true, parts: [{ type: "text" as const, text: "once" }] }
    const results = await Promise.all([SessionPrompt.promptAsync(input), SessionPrompt.promptAsync(input)])
    expect(results.filter(result => result?.replayed)).toHaveLength(1)
    const history = await Session.messages({ sessionID: session.id })
    expect(history).toHaveLength(1)
    expect(history[0].parts).toHaveLength(1)
  })
})

test("requestID rejects changed payloads and reuse in a different session", async () => {
  await fixture(async session => {
    const input = { sessionID: session.id, requestID: "req_collision", noReply: true, parts: [{ type: "text" as const, text: "once" }] }
    await SessionPrompt.promptAsync(input)
    await expect(SessionPrompt.promptAsync({ ...input, parts: [{ type: "text", text: "changed" }] })).rejects.toMatchObject({ status: 409 })
    const other = await Session.create({})
    await expect(SessionPrompt.promptAsync({ ...input, sessionID: other.id })).rejects.toMatchObject({ status: 409 })
    expect(await Session.messages({ sessionID: other.id })).toHaveLength(0)
  })
})

test("a failed reservation can be retried after a later turn without reusing an old chronological ID", async () => {
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async session => {
    const input = { sessionID: session.id, requestID: "req_failed_reservation", noReply: true, parts: [{ type: "text" as const, text: "original" }] }
    const originalWrite = Storage.writeAtomic
    let failed = false
    Storage.writeAtomic = async (key, value) => {
      // Fail the second reservation write, after the request mapping is already durable.
      if (!failed && key[0] === "message_request_origin") { failed = true; throw new Error("reservation disk failure") }
      return originalWrite(key, value)
    }
    try { await expect(SessionPrompt.promptAsync(input)).rejects.toThrow("reservation disk failure") }
    finally { Storage.writeAtomic = originalWrite }
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    const assistantID = await completeTurn(session, "req_after_reservation_failure")
    await SessionPrompt.promptAsync(input)
    const original = (await Session.messages({ sessionID: session.id })).find(message => message.info.role === "user" && message.info.requestID === input.requestID)!
    expect(original.info.id > assistantID).toBe(true)
    expect(original.parts).toHaveLength(1)
  })
})

test("an accepted-receipt write failure keeps the mapping and blocks duplicate creation across reload", async () => {
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async session => {
    const input = { sessionID: session.id, requestID: "req_receipt_failure", noReply: true, parts: [{ type: "text" as const, text: "once" }] }
    const originalWrite = Storage.writeAtomic
    Storage.writeAtomic = async (key, value: any) => {
      if (key[0] === "client_message_request" && value.state === "accepted") throw new Error("receipt disk failure")
      return originalWrite(key, value)
    }
    try { await expect(SessionPrompt.promptAsync(input)).rejects.toThrow("receipt disk failure") }
    finally { Storage.writeAtomic = originalWrite }
    const history = await Session.messages({ sessionID: session.id })
    expect(history).toHaveLength(1)
    expect(history[0].parts).toHaveLength(1)
    const originalID = history[0].info.id
    await Instance.dispose()
    await Instance.provide({ directory: session.directory, fn: async () => {
      await expect(SessionPrompt.promptAsync(input)).rejects.toMatchObject({ status: 409 })
      const after = await Session.messages({ sessionID: session.id })
      expect(after).toHaveLength(1)
      expect(after[0].info.id).toBe(originalID)
      expect(after[0].parts).toHaveLength(1)
    } })
  })
})

test("partial message writes cannot create another message on retry; explicit cleanup permits recovery", async () => {
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async session => {
    const input = { sessionID: session.id, requestID: "req_partial_parts", noReply: true, parts: [{ type: "text" as const, text: "one" }, { type: "text" as const, text: "two" }] }
    const originalWrite = Storage.write
    let parts = 0
    Storage.write = async (key, value) => {
      if (key[0] === "part" && ++parts === 2) throw new Error("part disk failure")
      return originalWrite(key, value)
    }
    try { await expect(SessionPrompt.promptAsync(input)).rejects.toThrow("part disk failure") }
    finally { Storage.write = originalWrite }
    await expect(SessionPrompt.promptAsync(input)).rejects.toMatchObject({ status: 409 })
    const history = await Session.messages({ sessionID: session.id })
    expect(history).toHaveLength(1)
    expect(history[0].parts).toHaveLength(1)
    await Session.removePart({ sessionID: session.id, messageID: history[0].info.id, partID: history[0].parts[0].id })
    await SessionPrompt.promptAsync(input)
    const recovered = await Session.messages({ sessionID: session.id })
    expect(recovered).toHaveLength(1)
    expect(recovered[0].info.id).not.toBe(history[0].info.id)
    expect(recovered[0].parts).toHaveLength(2)
  })
})

test("controller validates request identities and keeps accepted requestID replay independent of another turn", async () => {
  await fixture(async session => {
    const send = (body: unknown) => Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory }, body: JSON.stringify(body),
    })
    const body = { requestID: "req_controller", noReply: true, parts: [{ type: "text", text: "once" }] }
    for (const requestID of ["req_../../escape", "req_" + "a".repeat(125), "", "bad/id"]) {
      expect((await send({ ...body, requestID })).status).toBe(400)
    }
    expect((await send({ ...body, messageID: Identifier.ascending("message") })).status).toBe(400)
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    const first = await send(body)
    expect(first.status).toBe(202)
    const firstResponse = await first.json()
    const lease = RunLease.reserve(session.id)
    try {
      const repeated = await send(body)
      expect(repeated.status).toBe(202)
      expect((await repeated.json()).turnSnapshotId).toBe(firstResponse.turnSnapshotId)
      expect(RunLease.current(session.id)?.id).toBe(lease.id)
    } finally { RunLease.release(session.id, lease.id) }
    const history = await Session.messages({ sessionID: session.id })
    expect(history).toHaveLength(1)
    expect(history[0].info.role === "user" && history[0].info.requestID).toBe(body.requestID)
  })
})

test("truncated temporary receipt writes preserve the reservation through repeated retries and reload", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const { Global } = await import("../../src/global")
  const { createHash } = await import("node:crypto")
  for (const mode of ["throw", "short-write"] as const) {
    await fixture(async session => {
      const requestID = `req_torn_${mode}`
      const input = { sessionID: session.id, requestID, noReply: true, parts: [{ type: "text" as const, text: "only once" }] }
      const originalWrite = Bun.write
      Bun.write = (async (target: any, content: any, options?: any) => {
        const value = Buffer.isBuffer(content) ? content.toString() : String(content)
        if (String(target).includes("client_message_request") && value.includes('"accepted"')) {
          // A real partial write lands on disk, rather than throwing before persistence.
          await originalWrite(target, "{")
          if (mode === "throw") throw new Error("interrupted receipt replacement")
          return 1
        }
        return originalWrite(target, content, options)
      }) as typeof Bun.write
      try { await expect(SessionPrompt.promptAsync(input)).rejects.toThrow() }
      finally { Bun.write = originalWrite }
      const before = await Session.messages({ sessionID: session.id })
      expect(before).toHaveLength(1)
      const target = path.join(Global.Path.data, "storage", "client_message_request", createHash("sha256").update(requestID).digest("hex") + ".json")
      expect((await Bun.file(target).json()).state).toBe("reserved")
      expect((await fs.readdir(path.dirname(target))).some(name => name.endsWith(".tmp"))).toBe(false)
      for (let attempt = 0; attempt < 3; attempt++) {
        await Instance.dispose()
        await Instance.provide({ directory: session.directory, fn: async () => {
          await expect(SessionPrompt.promptAsync(input)).rejects.toMatchObject({ status: 409 })
          const history = await Session.messages({ sessionID: session.id })
          expect(history).toHaveLength(1)
          expect(history[0].info.id).toBe(before[0].info.id)
          expect(history[0].parts).toHaveLength(1)
        } })
      }
    })
  }
})

test("already-corrupted or invalid receipt JSON is retained and can never become a new request on retry", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const { Global } = await import("../../src/global")
  const { createHash } = await import("node:crypto")
  for (const [index, corrupted] of ["{", "null", "{}"].entries()) {
    await fixture(async session => {
      const requestID = `req_corrupted_${index}`
      const input = { sessionID: session.id, requestID, noReply: true, parts: [{ type: "text" as const, text: "once" }] }
      await SessionPrompt.promptAsync(input)
      const target = path.join(Global.Path.data, "storage", "client_message_request", createHash("sha256").update(requestID).digest("hex") + ".json")
      await fs.writeFile(target, corrupted)
      for (let attempt = 0; attempt < 3; attempt++) {
        await Instance.dispose()
        await Instance.provide({ directory: session.directory, fn: async () => {
          await expect(SessionPrompt.promptAsync(input)).rejects.toThrow()
          expect(await Bun.file(target).text()).toBe(corrupted)
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
        } })
      }
    })
  }
})

test("controller replays the immutable wire request before changed server prompt or enrichment can reinterpret it", async () => {
  const fs = await import("node:fs/promises")
  await fixture(async session => {
    process.env.NINE1BOT_CONFIG_PATH = session.directory + "/nine1bot.config.json"
    const send = (body: unknown) => Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory }, body: JSON.stringify(body),
    })
    const body = { requestID: "req_server_prompt_drift", noReply: true, model: { providerID: "test", modelID: "model" }, entry: { source: "browser-extension", mode: "browser-sidepanel" }, parts: [{ type: "text", text: "once" }] }
    await fs.writeFile(process.env.NINE1BOT_CONFIG_PATH, JSON.stringify({ browser: { sidepanel: { prompt: "original prompt" } } }))
    const original = await send(body)
    expect(original.status).toBe(202)
    const originalResponse = await original.json()
    await fs.writeFile(process.env.NINE1BOT_CONFIG_PATH, JSON.stringify({ browser: { sidepanel: { prompt: "changed prompt" } } }))
    const replay = await send(body)
    expect(replay.status).toBe(202)
    expect((await replay.json()).turnSnapshotId).toBe(originalResponse.turnSnapshotId)
    const changedBody = await send({ ...body, parts: [{ type: "text", text: "different client content" }] })
    expect(changedBody.status).toBe(409)
    expect((await changedBody.json()).error.code).toBe("REQUEST_CONFLICT")
    const history = await Session.messages({ sessionID: session.id })
    expect(history).toHaveLength(1)
    expect(history[0].info.role === "user" && history[0].info.system).not.toContain("changed prompt")
  })
})

test("directory MIME normalization cannot change the requestID fingerprint for identical controller or direct retries", async () => {
  const { pathToFileURL } = await import("node:url")
  await fixture(async session => {
    const body = { requestID: "req_directory_normalization", noReply: true, parts: [{ type: "file" as const, mime: "text/plain", filename: "folder", url: pathToFileURL(session.directory).href }] }
    const send = () => Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory }, body: JSON.stringify(body),
    })
    expect((await send()).status).toBe(202)
    expect((await send()).status).toBe(202)
    const direct = { ...body, sessionID: session.id, requestID: "req_direct_directory" }
    await SessionPrompt.promptAsync(direct)
    expect((await SessionPrompt.promptAsync(direct))?.replayed).toBe(true)
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(2)
  })
})

test("deleting accepted history preserves an idempotency tombstone instead of authorizing replay execution", async () => {
  const { SessionRequest } = await import("../../src/session/request")
  for (const mode of ["last-part", "message"] as const) {
    await fixture(async session => {
      const input = { sessionID: session.id, requestID: `req_deleted_${mode}`, noReply: true, parts: [{ type: "text" as const, text: "already accepted" }] }
      await SessionPrompt.promptAsync(input)
      const original = (await Session.messages({ sessionID: session.id }))[0]
      if (mode === "last-part") await Session.removePart({ sessionID: session.id, messageID: original.info.id, partID: original.parts[0].id })
      if (mode === "message") await Session.removeMessage({ sessionID: session.id, messageID: original.info.id })
      expect(await SessionRequest.isAccepted(session.id, undefined, input.requestID)).toBe(true)
      expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      expect(RunLease.current(session.id)).toBeUndefined()
      await Instance.dispose()
      await Instance.provide({ directory: session.directory, fn: async () => {
        expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        const other = await Session.create({})
        await expect(SessionPrompt.promptAsync({ ...input, sessionID: other.id })).rejects.toMatchObject({ status: 409 })
      } })
    })
  }
})

test("whole-session deletion clears indexed receipts including tombstones, and old-target retries are 404 without persistence", async () => {
  const { SessionRequest } = await import("../../src/session/request")
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async session => {
    const bodies = ["req_session_deleted_visible", "req_session_deleted_tombstone"].map(requestID => ({ requestID, noReply: true, parts: [{ type: "text", text: "once" }] }))
    const send = (body: unknown) => Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory }, body: JSON.stringify(body),
    })
    for (const body of bodies) expect((await send(body)).status).toBe(202)
    const history = await Session.messages({ sessionID: session.id })
    await Session.removeMessage({ sessionID: session.id, messageID: history[1].info.id })
    expect(await Storage.list(["session_message_request", session.id])).toHaveLength(2)
    await Session.remove(session.id)
    expect(await Storage.list(["session_message_request", session.id])).toHaveLength(0)
    for (const body of bodies) {
      expect(await SessionRequest.isAccepted(session.id, undefined, body.requestID)).toBe(false)
      expect((await send(body)).status).toBe(404)
    }
    expect(await Storage.list(["session_message_request", session.id])).toHaveLength(0)
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    expect(RunLease.current(session.id)).toBeUndefined()
  })
})

test("safe legacy dot IDs remain accepted and deletable after their history is removed", async () => {
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async session => {
    const body = { messageID: "msg.external.1", noReply: true, parts: [{ type: "text", text: "legacy dot ID" }] }
    const send = () => Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory }, body: JSON.stringify(body),
    })
    expect((await send()).status).toBe(202)
    await Session.removeMessage({ sessionID: session.id, messageID: body.messageID })
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    expect(await SessionRequest.isAccepted(session.id, body.messageID)).toBe(true)
    expect((await send()).status).toBe(202)
    const deleted = await Server.App().request(`/session/${session.id}`, {
      method: "DELETE", headers: { "x-opencode-directory": session.directory },
    })
    expect(deleted.status).toBe(200)
    expect(await Storage.list(["session_message_request", session.id])).toHaveLength(0)
    expect(await SessionRequest.isAccepted(session.id, body.messageID)).toBe(false)
    expect((await send()).status).toBe(404)
  })
})

test("unsafe legacy IDs and receipt index paths fail closed without following path components", async () => {
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async session => {
    for (const messageID of ["msg/../escape", "msg\\..\\escape", "msg\u0000bad"]) {
      await expect(SessionPrompt.promptAsync({ sessionID: session.id, messageID, noReply: true, parts: [] })).rejects.toMatchObject({ status: 400 })
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      const index = ["session_message_request", session.id, "unsafe-index"]
      await Storage.writeAtomic(index, { target: ["message_request", messageID] })
      await expect(SessionRequest.removeSession(session.id)).rejects.toMatchObject({ status: 409 })
      expect(await Storage.read<{ target: string[] }>(index)).toEqual({ target: ["message_request", messageID] })
      await Storage.remove(index)
    }
    expect(await Storage.list(["session_message_request", session.id])).toHaveLength(0)
  })
})

test("read-only receipt recovery distinguishes unknown, reserved, accepted and other sessions", async () => {
  await fixture(async (session) => {
    const requestID = 'req_readonly_recovery'
    const get = (sessionID = session.id) => Server.App().request(`/nine1bot/agent/sessions/${sessionID}/requests/${requestID}`, {
      headers: { 'x-opencode-directory': session.directory },
    })
    let response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ requestID, sessionID: session.id, state: 'unknown' })
    const input = { sessionID: session.id, requestID, noReply: true, parts: [{ type: 'text' as const, text: 'original' }] }
    const messageID = await SessionRequest.prepare(input)
    response = await get()
    expect(await response.json()).toMatchObject({ requestID, sessionID: session.id, state: 'reserved', messageID })
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    await SessionRequest.accept({ ...input, messageID })
    for (let i = 0; i < 2; i++) {
      response = await get()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ requestID, sessionID: session.id, state: 'accepted', messageID })
    }
    expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    const other = await Session.create({})
    expect((await get(other.id)).status).toBe(409)
  })
})
