import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRequest } from "../../src/session/request"
import { RunLease } from "../../src/session/run-lease"
import { Storage } from "../../src/storage/storage"
import { SessionStatus } from "../../src/session/status"
import { Server } from "../../src/server/server"
import { ControllerAgentRunCompiler } from "../../src/runtime/controller/agent-run-compiler"
import { RuntimeControllerEvents } from "../../src/runtime/controller/events"
import { Bus } from "../../src/bus"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

let previous: NodeJS.ProcessEnv
beforeEach(() => { previous = { ...process.env } })
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
  await Instance.provide({ directory: tmp.path, fn: async () => fn(await Session.create({})) })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function send(session: Session.Info, body: unknown, signal?: AbortSignal) {
  return Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory },
    body: JSON.stringify(body),
    signal,
  })
}
function body(requestID: string) {
  return { requestID, noReply: true, model: { providerID: "test", modelID: "model" }, parts: [{ type: "text", text: "keep once" }] }
}
async function stop(session: Session.Info) {
  const response = await Server.App().request(`/session/${session.id}/abort`, {
    method: "POST", headers: { "x-opencode-directory": session.directory },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toBe(true)
}
function compileGate() {
  const started = deferred()
  const released = deferred()
  const original = ControllerAgentRunCompiler.compilePrompt
  const compile = spyOn(ControllerAgentRunCompiler, "compilePrompt").mockImplementation(async input => {
    started.resolve()
    await released.promise
    return original(input)
  })
  return { started, released, compile }
}

function receiptGate(namespace: string) {
  const started = deferred()
  const released = deferred()
  const original = Storage.read
  let blocked = false
  const read = spyOn(Storage, "read").mockImplementation(async (key, options) => {
    if (!blocked && key[0] === namespace) {
      blocked = true
      started.resolve()
      await released.promise
    }
    return original(key, options)
  })
  return { started, released, read }
}

test("Stop before the first receipt read returns cancels all copies without requiring an execution lease", async () => {
  await fixture(async session => {
    for (const identity of [{ requestID: "req_before_receipt" }, { messageID: Identifier.ascending("message") }]) {
      const input = { noReply: true, parts: [{ type: "text", text: "cancel receipt lookup" }], ...identity }
      const gate = receiptGate(identity.requestID ? "client_message_request" : "message_request")
      try {
        const first = send(session, input)
        await gate.started.promise
        expect(RunLease.current(session.id)).toBeUndefined()
        const duplicate = send(session, input)
        const conflict = await send(session, { ...input, parts: [{ type: "text", text: "changed" }] })
        expect(conflict.status).toBe(409)
        await stop(session)
        gate.released.resolve()
        for (const response of await Promise.all([first, duplicate])) {
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED" } })
        }
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        expect(RunLease.current(session.id)).toBeUndefined()
        expect(SessionPrompt.cancel(session.id)).toBe(false)
        expect((await send(session, input)).status).toBe(202)
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        await Session.removeMessage({ sessionID: session.id, messageID: messages[0].info.id })
      } finally { gate.released.resolve(); gate.read.mockRestore() }
    }
  })
})

test("Stop covers the session-routing await before the message handler and legacy/unkeyed calls", async () => {
  await fixture(async session => {
    for (const identity of [{ requestID: "req_before_routing" }, { messageID: Identifier.ascending("message") }, {}]) {
      const started = deferred()
      const released = deferred()
      const original = Session.get
      let calls = 0
      const get = spyOn(Session, "get").mockImplementation(async id => {
        if (id === session.id && ++calls <= 2) {
          if (calls === 2) started.resolve()
          await released.promise
        }
        return original(id)
      })
      try {
        const input = { noReply: true, parts: [{ type: "text", text: "cancel session routing" }], ...identity }
        const pending = [send(session, input), send(session, input)]
        await started.promise
        expect(RunLease.current(session.id)).toBeUndefined()
        await stop(session)
        released.resolve()
        expect((await Promise.all(pending)).map(response => response.status)).toEqual([409, 409])
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        expect(SessionPrompt.cancel(session.id)).toBe(false)
      } finally { released.resolve(); get.mockRestore() }
    }
  })
})

test("accepted receipt lookup remains a replay after Stop and never borrows an unrelated lease", async () => {
  await fixture(async session => {
    const input = body("req_replay_receipt_gate")
    const accepted = await send(session, input)
    expect(accepted.status).toBe(202)
    const turn = (await accepted.json()).turnSnapshotId
    const gate = receiptGate("client_message_request")
    const unrelated = RunLease.reserve(session.id)
    try {
      const replay = send(session, input)
      await gate.started.promise
      expect(RunLease.current(session.id)).toBe(unrelated)
      expect(unrelated.controller.signal.aborted).toBe(false)
      gate.released.resolve()
      expect((await (await replay).json()).turnSnapshotId).toBe(turn)
      expect(RunLease.current(session.id)).toBe(unrelated)
      expect(unrelated.controller.signal.aborted).toBe(false)
    } finally { gate.released.resolve(); gate.read.mockRestore(); RunLease.release(session.id, unrelated.id) }
    const stoppedGate = receiptGate("client_message_request")
    try {
      const replay = send(session, input)
      await stoppedGate.started.promise
      expect(RunLease.current(session.id)).toBeUndefined()
      await stop(session)
      stoppedGate.released.resolve()
      const response = await replay
      expect(response.status).toBe(202)
      expect((await response.json()).turnSnapshotId).toBe(turn)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(await SessionRequest.isAccepted(session.id, undefined, input.requestID)).toBe(true)
      expect(SessionPrompt.cancel(session.id)).toBe(false)
    } finally { stoppedGate.released.resolve(); stoppedGate.read.mockRestore() }
  })
})

test("disconnect during receipt lookup is not Stop and validation failures retire pending ownership", async () => {
  await fixture(async session => {
    const gate = receiptGate("client_message_request")
    const connection = new AbortController()
    try {
      const pending = send(session, body("req_receipt_disconnect"), connection.signal)
      await gate.started.promise
      connection.abort()
      gate.released.resolve()
      expect((await pending).status).toBe(202)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(SessionPrompt.cancel(session.id)).toBe(false)
      expect((await send(session, { requestID: "invalid-id", parts: [] })).status).toBe(400)
      expect(SessionPrompt.cancel(session.id)).toBe(false)
    } finally { gate.released.resolve(); gate.read.mockRestore() }
  })
})

test("Stop during compilation cancels every concurrent copy, rejects other work, and permits explicit retry", async () => {
  await fixture(async session => {
    const gate = compileGate()
    const input = body("req_controller_stop")
    try {
      const first = send(session, input)
      await gate.started.promise
      const lease = RunLease.current(session.id)!
      expect(lease).toBeDefined()
      expect(SessionStatus.get(session.id).type).toBe("busy")
      const duplicate = send(session, input)
      const busy = await send(session, { ...input, requestID: "req_other_controller" })
      expect(busy.status).toBe(409)
      expect(await busy.json()).toMatchObject({ accepted: false, busy: true })
      const conflict = await send(session, { ...input, parts: [{ type: "text", text: "different" }] })
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toMatchObject({ error: { code: "REQUEST_CONFLICT" } })
      const other = await Session.create({})
      expect((await send(other, input)).status).toBe(409)
      expect(RunLease.current(other.id)).toBeUndefined()
      await stop(session)
      expect(lease.controller.signal.aborted).toBe(true)
      gate.released.resolve()
      for (const response of await Promise.all([first, duplicate])) {
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED" } })
      }
      expect(gate.compile).toHaveBeenCalledTimes(1)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      expect(await SessionRequest.isAccepted(session.id, undefined, input.requestID)).toBe(false)
      expect(RunLease.current(session.id)).toBeUndefined()
      expect(SessionStatus.get(session.id).type).toBe("idle")
      expect((await send(session, input)).status).toBe(202)
      expect(gate.compile).toHaveBeenCalledTimes(2)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(RunLease.current(session.id)).toBeUndefined()
    } finally { gate.released.resolve(); gate.compile.mockRestore() }
  })
})

test("concurrent successful sends share acceptance; accepted replay skips compilation and another turn's lease", async () => {
  await fixture(async session => {
    const gate = compileGate()
    const input = body("req_controller_shared")
    try {
      const first = send(session, input)
      await gate.started.promise
      const duplicate = send(session, input)
      // A completed unrelated request lets both request bodies reach the handler.
      expect((await send(session, { ...input, requestID: "req_shared_busy" })).status).toBe(409)
      gate.released.resolve()
      const responses = await Promise.all([first, duplicate])
      expect(responses.map(response => response.status)).toEqual([202, 202])
      const [a, b] = await Promise.all(responses.map(response => response.json()))
      expect(a.turnSnapshotId).toBe(b.turnSnapshotId)
      expect(gate.compile).toHaveBeenCalledTimes(1)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(RunLease.current(session.id)).toBeUndefined()
      const unrelated = RunLease.reserve(session.id)
      try {
        const replay = await send(session, input)
        expect(replay.status).toBe(202)
        expect((await replay.json()).turnSnapshotId).toBe(a.turnSnapshotId)
        expect(gate.compile).toHaveBeenCalledTimes(1)
        expect(RunLease.current(session.id)).toBe(unrelated)
      } finally { RunLease.release(session.id, unrelated.id) }
    } finally { gate.released.resolve(); gate.compile.mockRestore() }
  })
})

test("a compiler failure releases admission and the same request can be retried", async () => {
  await fixture(async session => {
    const original = ControllerAgentRunCompiler.compilePrompt
    const compile = spyOn(ControllerAgentRunCompiler, "compilePrompt").mockImplementationOnce(async () => {
      throw new Error("compile failed before admission")
    }).mockImplementation(original)
    try {
      const input = body("req_controller_compile_failure")
      expect((await send(session, input)).status).toBe(500)
      expect(RunLease.current(session.id)).toBeUndefined()
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      expect((await send(session, input)).status).toBe(202)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(RunLease.current(session.id)).toBeUndefined()
    } finally { compile.mockRestore() }
  })
})

test("HTTP disconnect during preparation does not act as Stop", async () => {
  await fixture(async session => {
    const gate = compileGate()
    const connection = new AbortController()
    try {
      const pending = send(session, body("req_controller_disconnect"), connection.signal)
      await gate.started.promise
      const lease = RunLease.current(session.id)!
      connection.abort()
      expect(lease.controller.signal.aborted).toBe(false)
      gate.released.resolve()
      expect((await pending).status).toBe(202)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      expect(RunLease.current(session.id)).toBeUndefined()
    } finally { gate.released.resolve(); gate.compile.mockRestore() }
  })
})

test("legacy message IDs and unkeyed messages also acquire a cancellable preparation lease", async () => {
  await fixture(async session => {
    for (const identity of [{ messageID: Identifier.ascending("message") }, {}]) {
      const gate = compileGate()
      try {
        const pending = send(session, { ...identity, noReply: true, parts: [{ type: "text", text: "stop legacy" }] })
        await gate.started.promise
        await stop(session)
        gate.released.resolve()
        expect((await pending).status).toBe(409)
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        expect(RunLease.current(session.id)).toBeUndefined()
      } finally { gate.released.resolve(); gate.compile.mockRestore() }
    }
  })
})

test("Stop after full message persistence still accepts the canonical receipt and replays after reload", async () => {
  await fixture(async session => {
    const input = { ...body("req_controller_persist_cancel"), parts: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }
    const original = SessionRequest.accept
    const accept = spyOn(SessionRequest, "accept").mockImplementation(async canonical => {
      expect(canonical.requestID).toBe(input.requestID)
      expect(canonical.messageID).toMatch(/^msg/)
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages).toHaveLength(1)
      expect(messages[0].parts).toHaveLength(2)
      expect(SessionPrompt.cancel(session.id)).toBe(true)
      await original(canonical)
    })
    const cancelled: string[] = []
    const unsubscribe = Bus.subscribe(RuntimeControllerEvents.TurnCancelled, event => {
      if (event.properties.turnSnapshotId) cancelled.push(event.properties.turnSnapshotId)
    })
    try {
      const first = await send(session, input)
      expect(first.status).toBe(409)
      expect(await first.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED" } })
      expect(RunLease.current(session.id)).toBeUndefined()
      expect(await SessionRequest.isAccepted(session.id, undefined, input.requestID)).toBe(true)
      expect(cancelled).toHaveLength(1)
      expect(accept).toHaveBeenCalledTimes(1)
      await Instance.dispose()
      await Instance.provide({ directory: session.directory, fn: async () => {
        const replay = await send(session, input)
        expect(replay.status).toBe(202)
        expect((await replay.json()).turnSnapshotId).toBe(cancelled[0])
        expect(accept).toHaveBeenCalledTimes(1)
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0].parts).toHaveLength(2)
        expect(RunLease.current(session.id)).toBeUndefined()
      } })
    } finally { accept.mockRestore(); unsubscribe() }
  })
})

test("a normal turn hands the original lease to the loop and releases it when model resolution fails", async () => {
  await fixture(async session => {
    const gate = compileGate()
    const errors: string[] = []
    const unsubscribe = Bus.subscribe(Session.Event.Error, event => { errors.push(JSON.stringify(event.properties.error)) })
    try {
      const pending = send(session, { ...body("req_controller_loop"), noReply: false })
      await gate.started.promise
      const lease = RunLease.current(session.id)!
      expect(lease).toBeDefined()
      gate.released.resolve()
      expect((await pending).status).toBe(202)
      for (let i = 0; i < 200 && RunLease.current(session.id); i++) await Bun.sleep(5)
      expect(errors.some(error => error.includes("Model not found"))).toBe(true)
      expect(RunLease.current(session.id)).toBeUndefined()
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
    } finally { gate.released.resolve(); gate.compile.mockRestore(); unsubscribe() }
  })
})
