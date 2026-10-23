import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { RunLease } from "../../src/session/run-lease"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

const initialEnv = { ...process.env }
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in initialEnv)) delete process.env[key]
  Object.assign(process.env, initialEnv)
})
async function setup() {
  const tmp = await tmpdir()
  const runtime = path.join(tmp.path, "runtime.json")
  await fs.writeFile(runtime, JSON.stringify({ model: "test/model" }))
  Object.assign(process.env, {
    OPENCODE_CONFIG: runtime,
    NINE1BOT_PROJECT_ENV_DIR: path.join(process.env.XDG_DATA_HOME!, "project-env"),
    OPENCODE_DISABLE_GLOBAL_CONFIG: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL: "true",
  })
  const session = await Instance.provide({ directory: tmp.path, fn: () => Session.create({}) })
  return { directory: tmp.path, session }
}
const inDir = <T>(directory: string, fn: () => T) => Instance.provide({ directory, fn })

test("busy summarize leaves history unchanged", async () => {
  const { directory, session } = await setup()
  const message = await inDir(directory, () => Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
    role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } }))
  await inDir(directory, () => Session.update(session.id, draft => { draft.revert = { messageID: message.id } }))
  const lease = await inDir(directory, () => RunLease.reserve(session.id))
  try {
    const before = await inDir(directory, () => Session.messages({ sessionID: session.id }))
    const response = await Server.App().request(`/session/${session.id}/summarize`, {
      method: "POST",
      headers: { "x-opencode-directory": directory, "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "test", modelID: "model" }),
    })
    const after = await inDir(directory, () => Session.messages({ sessionID: session.id }))
    expect(response.status).toBe(409)
    expect(after).toEqual(before)
    expect((await inDir(directory, () => Session.get(session.id))).revert).toEqual({ messageID: message.id })
  } finally {
    await inDir(directory, () => RunLease.release(session.id, lease.id))
  }
})

test("overlapping same-name uploads own independent files", async () => {
  const { directory, session } = await setup()
  const boundary = "audit-upload-boundary"
  const encode = (value: string) => new TextEncoder().encode(value)
  let finishFirst!: () => void
  const firstBody = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\nFIRST`))
    finishFirst = () => {
      controller.enqueue(encode(`\r\n--${boundary}--\r\n`))
      controller.close()
    }
  } })
  const firstPromise = Server.App().request(`/session/${session.id}/upload`, {
    method: "POST",
    headers: { "x-opencode-directory": directory, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: firstBody,
    duplex: "half",
  } as RequestInit)
  const uploads = Session.uploadsDirectory(session)
  for (let attempt = 0; attempt < 100; attempt++) {
    const folders = await fs.readdir(uploads).catch(() => [])
    const pending = await Promise.all(folders.map(folder => fs.stat(path.join(uploads, folder, ".upload.part")).then(() => true).catch(() => false)))
    if (pending.some(Boolean)) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const secondBody = new FormData()
  secondBody.append("file", new Blob(["SECOND"], { type: "text/plain" }), "report.txt")
  const second = await Server.App().request(`/session/${session.id}/upload`, {
    method: "POST", headers: { "x-opencode-directory": directory }, body: secondBody,
  })
  const secondResult = await second.json()
  finishFirst()
  const first = await firstPromise
  const firstResult = await first.json()
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(firstResult.url).not.toBe(secondResult.url)
  const disk = await fs.readFile(new URL(secondResult.url), "utf8")
  expect(disk).toBe("SECOND")
  expect(await fs.readFile(new URL(firstResult.url), "utf8")).toBe("FIRST")
})

test("forked attachments survive deletion of their source session", async () => {
  const { directory, session } = await setup()
  const form = new FormData()
  form.append("file", new Blob(["SOURCE"], { type: "text/plain" }), "source.txt")
  const response = await Server.App().request(`/session/${session.id}/upload`, {
    method: "POST", headers: { "x-opencode-directory": directory }, body: form,
  })
  expect(response.status).toBe(200)
  const uploaded = await response.json()
  await inDir(directory, async () => {
    const message = await Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
      role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } })
    await Session.updatePart({ id: Identifier.ascending("part"), messageID: message.id, sessionID: session.id,
      type: "file", mime: uploaded.mime, filename: uploaded.filename, url: uploaded.url })
    const fork = await Session.fork({ sessionID: session.id })
    const forkMessages = await Session.messages({ sessionID: fork.id })
    const part = forkMessages[0].parts[0]
    expect(part.type).toBe("file")
    if (part.type !== "file") throw new Error("unexpected part")
    expect(await Bun.file(new URL(part.url)).exists()).toBe(true)
    await Session.remove(session.id)
    expect((await Session.get(fork.id)).id).toBe(fork.id)
    expect(await Bun.file(new URL(part.url)).exists()).toBe(true)
    expect(await fs.readFile(new URL(part.url), "utf8")).toBe("SOURCE")
    expect(part.url).not.toBe(uploaded.url)
  })
})

test("first Git commit migrates existing directory sessions when reopening", async () => {
  const { $ } = await import("bun")
  const { Storage } = await import("../../src/storage/storage")
  const { directory, session } = await setup()
  await inDir(directory, async () => {
    const message = await Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
      role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } })
    await Session.updatePart({ id: Identifier.ascending("part"), messageID: message.id, sessionID: session.id,
      type: "text", text: "Please build a new project here" })
  })
  await $`git init`.cwd(directory).quiet()
  await $`git -c user.name=audit -c user.email=audit@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
  await Instance.disposeAll()
  const response = await Server.App().request(`/session/${session.id}`, {
    headers: { "x-opencode-directory": directory },
  })
  const list = await Server.App().request("/session", { headers: { "x-opencode-directory": directory } })
  const after = await list.json()
  const newProjectID = await inDir(directory, () => Instance.project.id)
  expect(newProjectID).not.toBe(session.projectID)
  expect(response.status).toBe(200)
  expect(after.map((item: Session.Info) => item.id)).toContain(session.id)
  expect((await Storage.read<Session.Info>(["session", newProjectID, session.id])).projectID).toBe(newProjectID)
})

test("equivalent directory aliases return the same sessions", async () => {
  const { directory, session } = await setup()
  const canonical = await Server.App().request(`/session?directory=${encodeURIComponent(directory)}`)
  const alias = await Server.App().request(`/session?directory=${encodeURIComponent(directory + '/.')}`)
  const canonicalList = await canonical.json() as Session.Info[]
  const aliasList = await alias.json() as Session.Info[]
  expect(canonical.status).toBe(200)
  expect(alias.status).toBe(200)
  expect(canonicalList.map(item => item.id)).toContain(session.id)
  expect(aliasList).toEqual(canonicalList)
})

test("summarize owns admission before cleanup and releases it if preparation fails", async () => {
  const { spyOn } = await import("bun:test")
  const { SessionRevert } = await import("../../src/session/revert")
  const { directory, session } = await setup()
  const cleanup = spyOn(SessionRevert, "cleanup").mockImplementation(async () => {
    expect(RunLease.current(session.id)).toBeDefined()
    throw new Error("injected cleanup failure")
  })
  try {
    const response = await Server.App().request(`/session/${session.id}/summarize`, {
      method: "POST", headers: { "x-opencode-directory": directory, "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "test", modelID: "model" }),
    })
    expect(response.status).toBe(500)
    expect(RunLease.current(session.id)).toBeUndefined()
    expect(await inDir(directory, () => Session.messages({ sessionID: session.id }))).toEqual([])
  } finally { cleanup.mockRestore() }
})

test("fork copies encoded and legacy raw upload URLs and rewrites generated path hints", async () => {
  const { pathToFileURL, fileURLToPath } = await import("node:url")
  const { directory, session } = await setup()
  await inDir(directory, async () => {
    const message = await Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
      role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } })
    await fs.mkdir(Session.uploadsDirectory(session), { recursive: true })
    for (const [name, legacy] of [["space name.txt", false], ["literal%20#?.txt", true]] as const) {
      const filename = path.join(Session.uploadsDirectory(session), name)
      await fs.writeFile(filename, name)
      await Session.updatePart({ id: Identifier.ascending("part"), messageID: message.id, sessionID: session.id,
        type: "text", synthetic: true, text: `User uploaded a file\nFile saved to: ${filename}\n` })
      await Session.updatePart({ id: Identifier.ascending("part"), messageID: message.id, sessionID: session.id,
        type: "file", mime: "text/plain", filename: name, url: legacy ? `file://${filename}` : pathToFileURL(filename).href })
    }
    const fork = await Session.fork({ sessionID: session.id })
    await Session.remove(session.id)
    const messages = await Session.messages({ sessionID: fork.id })
    const files = messages[0].parts.filter(part => part.type === "file")
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(await fs.readFile(fileURLToPath(file.url), "utf8")).toBe(file.filename!)
      expect(messages[0].parts.some(part => part.type === "text" && part.text.includes(`File saved to: ${fileURLToPath(file.url)}\n`))).toBe(true)
    }
  })
})

test("failed fork attachment copy removes the incomplete fork and keeps its source", async () => {
  const { pathToFileURL } = await import("node:url")
  const { directory, session } = await setup()
  await inDir(directory, async () => {
    const message = await Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
      role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } })
    await Session.updatePart({ id: Identifier.ascending("part"), messageID: message.id, sessionID: session.id,
      type: "file", mime: "text/plain", filename: "missing.txt", url: pathToFileURL(path.join(Session.uploadsDirectory(session), "missing.txt")).href })
    await expect(Session.fork({ sessionID: session.id })).rejects.toThrow()
    expect((await Array.fromAsync(Session.list())).map(item => item.id)).toEqual([session.id])
    expect(RunLease.current(session.id)).toBeUndefined()
  })
})

test("Git discovery keeps an active directory instance stable until it is reopened", async () => {
  const { $ } = await import("bun")
  const { Project } = await import("../../src/project/project")
  const { directory, session } = await setup()
  await $`git init`.cwd(directory).quiet()
  await $`git -c user.name=regression -c user.email=regression@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
  expect((await Project.fromDirectory(directory)).project.id).toBe(session.projectID)
  await inDir(directory, () => Session.update(session.id, draft => { draft.title = "changed while still open" }))
  await Instance.disposeAll()
  const restored = await inDir(directory, () => Session.get(session.id))
  expect(restored.projectID).not.toBe(session.projectID)
  expect(restored.title).toBe("changed while still open")
})

test("migration recovers previously split projects, dependent state and automation references without overwriting target settings", async () => {
  const { $ } = await import("bun")
  const { Project } = await import("../../src/project/project")
  const { ProjectEnvironment } = await import("../../src/project/environment")
  const { Storage } = await import("../../src/storage/storage")
  const { SessionRuntimeProfile } = await import("../../src/runtime/session/profile")
  const { RuntimeContextEvents } = await import("../../src/runtime/context/events")
  const { Schedule } = await import("../../src/schedule/schedule")
  const { directory, session } = await setup()
  const source = await inDir(directory, () => Project.update({ projectID: session.projectID, name: "source name", instructions: "source instruction" }))
  const searchTerm = `migration-search-${session.id}`
  await inDir(directory, () => Session.update(session.id, draft => { draft.title = searchTerm }))
  expect((await Storage.searchSessions({ projectID: source.id, q: searchTerm })).results.map(item => item.session.id)).toEqual([session.id])
  const profile = await SessionRuntimeProfile.read(session)
  await ProjectEnvironment.setAll(source.id, { SOURCE_ONLY: "source", SHARED: "source" })
  const task = await Schedule.createTask({ name: "Migration task", enabled: false, projectID: source.id,
    timezone: "UTC", schedule: { type: "daily", timeOfDay: "09:00" } })
  const prepared = await inDir(directory, () => RuntimeContextEvents.preparePageEvent({ sessionID: session.id,
    page: { platform: "generic", title: "migration context", url: "https://example.com" } }))
  await inDir(directory, () => RuntimeContextEvents.commitPageEvent({ sessionID: session.id, prepared: prepared! }))
  await $`git init`.cwd(directory).quiet()
  await $`git -c user.name=regression -c user.email=regression@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
  const targetID = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
  await Storage.write(["project", targetID], { ...source, id: targetID, name: "target name", instructions: undefined })
  const targetSession = { ...session, id: Identifier.descending("session"), projectID: targetID, title: "existing target history" }
  await Storage.write(["session", targetID, targetSession.id], targetSession)
  await ProjectEnvironment.setAll(targetID, { TARGET_ONLY: "target", SHARED: "target" })
  await Instance.disposeAll()
  try {
    const migrated = await inDir(directory, () => Session.get(session.id))
    expect(migrated.projectID).toBe(targetID)
    expect((await Storage.searchSessions({ projectID: targetID, q: searchTerm })).results.map(item => item.session.id)).toEqual([session.id])
    expect((await Storage.searchSessions({ projectID: source.id, q: searchTerm })).results).toEqual([])
    expect(await SessionRuntimeProfile.read(migrated)).toEqual(profile)
    expect(await RuntimeContextEvents.readState({ projectID: targetID, sessionID: session.id })).toEqual(prepared!.state)
    expect((await RuntimeContextEvents.list({ projectID: targetID, sessionID: session.id })).map(event => event.id)).toEqual([prepared!.event!.id])
    expect((await Project.get(source.id)).id).toBe(targetID)
    expect(await ProjectEnvironment.getAll(targetID)).toEqual({ SOURCE_ONLY: "source", TARGET_ONLY: "target", SHARED: "target" })
    expect((await Project.get(targetID)).name).toBe("target name")
    expect((await Project.get(targetID)).instructions).toBe("source instruction")
    expect((await Schedule.getTask(task.id)).projectID).toBe(targetID)
    expect((await inDir(directory, () => Array.fromAsync(Session.list()))).map(item => item.id).sort()).toEqual([session.id, targetSession.id].sort())
    expect((await Project.list()).some(project => project.id === source.id)).toBe(false)
    expect((await Storage.read<Session.Info>(["project_migration_backup", source.id, targetID, "session", source.id, session.id])).id).toBe(session.id)
    await ProjectEnvironment.remove(targetID, "SOURCE_ONLY")
    await Project.fromDirectory(directory)
    expect(await ProjectEnvironment.getAll(targetID)).toEqual({ TARGET_ONLY: "target", SHARED: "target" })
    const staleList = await Server.App().request(`/project/${source.id}/session`, { headers: { "x-opencode-directory": directory } })
    expect((await staleList.json() as Session.Info[]).map(item => item.id).sort()).toEqual([session.id, targetSession.id].sort())
  } finally { await Storage.remove(["scheduled_task", task.id]) }
})

test("interrupted migration retains originals and retries after a failed instance initialization", async () => {
  const { $ } = await import("bun")
  const { spyOn } = await import("bun:test")
  const { Storage } = await import("../../src/storage/storage")
  const { directory, session } = await setup()
  await Storage.write(["context_state", session.projectID, session.id], { digest: "retained" })
  await $`git init`.cwd(directory).quiet()
  await $`git -c user.name=regression -c user.email=regression@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
  const targetID = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
  await Instance.disposeAll()
  const write = Storage.writeAtomic
  const injected = spyOn(Storage, "writeAtomic").mockImplementation(async (key, value) => {
    if (key[0] === "context_state" && key[1] === targetID) throw new Error("injected migration disk failure")
    return write(key, value)
  })
  try {
    await expect(inDir(directory, () => Session.get(session.id))).rejects.toThrow("injected migration disk failure")
    expect((await Storage.read<Session.Info>(["session", session.projectID, session.id])).id).toBe(session.id)
    expect(await Storage.read<{ digest: string }>(["context_state", session.projectID, session.id])).toEqual({ digest: "retained" })
  } finally { injected.mockRestore() }
  const restored = await inDir(directory, () => Session.get(session.id))
  expect(restored.projectID).toBe(targetID)
  expect(await Storage.read<{ digest: string }>(["context_state", targetID, session.id])).toEqual({ digest: "retained" })
  expect((await inDir(directory, () => Array.fromAsync(Session.list()))).map(item => item.id)).toEqual([session.id])
})

test("migration retries after its final checkpoint fails without duplicating or resurrecting removed history", async () => {
  const { $ } = await import("bun")
  const { spyOn } = await import("bun:test")
  const { Storage } = await import("../../src/storage/storage")
  const { directory, session } = await setup()
  await $`git init`.cwd(directory).quiet()
  await $`git -c user.name=regression -c user.email=regression@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
  const targetID = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
  await Instance.disposeAll()
  const write = Storage.writeAtomic
  const injected = spyOn(Storage, "writeAtomic").mockImplementation(async (key, value) => {
    if (key[0] === "project_migration") throw new Error("injected checkpoint failure")
    return write(key, value)
  })
  try {
    await expect(inDir(directory, () => Session.get(session.id))).rejects.toThrow("injected checkpoint failure")
    expect((await Storage.read<Session.Info>(["session", targetID, session.id])).id).toBe(session.id)
    await expect(Storage.read(["session", session.projectID, session.id])).rejects.toThrow()
    await Storage.remove(["session", targetID, session.id])
  } finally { injected.mockRestore() }
  expect(await inDir(directory, () => Array.fromAsync(Session.list()))).toEqual([])
  expect((await Storage.read<Session.Info>(["project_migration_backup", session.projectID, targetID, "session", session.projectID, session.id])).id).toBe(session.id)
})

test("concurrent first-commit discovery cannot move an instance that is still being registered", async () => {
  const { $ } = await import("bun")
  const { spyOn } = await import("bun:test")
  const { Storage } = await import("../../src/storage/storage")
  const { Lock } = await import("../../src/util/lock")
  const { directory, session } = await setup()
  const nested = path.join(directory, "nested")
  await fs.mkdir(nested)
  await Instance.disposeAll()
  let enter!: () => void
  let release!: () => void
  let queued!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const nestedQueued = new Promise<void>(resolve => { queued = resolve })
  let firstRead = true
  let discoveries = 0
  const read = Storage.read
  const lock = Lock.write
  const readSpy = spyOn(Storage, "read").mockImplementation(async (key, options) => {
    if (firstRead && key[0] === "project" && key[1] === session.projectID) {
      firstRead = false
      enter()
      await gate
    }
    return read(key, options)
  })
  const lockSpy = spyOn(Lock, "write").mockImplementation(async key => {
    if (key.startsWith("project-discovery") && ++discoveries === 2) queued()
    return lock(key)
  })
  try {
    const rootPending = inDir(directory, () => Session.get(session.id))
    await entered
    await $`git init`.cwd(directory).quiet()
    await $`git -c user.name=regression -c user.email=regression@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
    const nestedPending = inDir(nested, () => Session.get(session.id))
    await nestedQueued
    release()
    expect((await rootPending).id).toBe(session.id)
    expect((await nestedPending).id).toBe(session.id)
    expect((await inDir(directory, () => Session.get(session.id))).projectID).toBe(session.projectID)
  } finally {
    release()
    readSpy.mockRestore()
    lockSpy.mockRestore()
  }
})

test("aborted execution retains its source project until the lease actually releases", async () => {
  const { $ } = await import("bun")
  const { directory, session } = await setup()
  const lease = await inDir(directory, () => RunLease.reserve(session.id))
  try {
    await $`git init`.cwd(directory).quiet()
    await $`git -c user.name=regression -c user.email=regression@example.invalid commit --allow-empty -m ${directory}`.cwd(directory).quiet()
    await Instance.disposeAll()
    expect(lease.controller.signal.aborted).toBe(true)
    expect((await inDir(directory, () => Session.get(session.id))).projectID).toBe(session.projectID)
  } finally { RunLease.release(session.id, lease.id) }
  await Instance.disposeAll()
  expect((await inDir(directory, () => Session.get(session.id))).projectID).not.toBe(session.projectID)
})

test("forked preview and download tool metadata owns copies even without FileParts", async () => {
  const { directory, session } = await setup()
  await inDir(directory, async () => {
    await fs.mkdir(Session.uploadsDirectory(session), { recursive: true })
    const user = await Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
      role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } })
    const assistant = await Session.updateMessage({ id: Identifier.ascending("message"), sessionID: session.id,
      role: "assistant", parentID: user.id, agent: "build", mode: "build", providerID: "test", modelID: "model",
      path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() } })
    for (const tool of ["preview_file", "display_file", "send_file"]) {
      const filename = `${tool}.txt`
      const source = path.join(Session.uploadsDirectory(session), filename)
      await fs.writeFile(source, tool)
      await Session.updatePart({ id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
        type: "tool", tool, callID: `call_${tool}`, state: { status: "completed", input: { path: path.relative(directory, source) },
          output: "ready", title: filename, metadata: { path: source, filename, previewId: "old-token" }, time: { start: 1, end: 2 } } })
    }
    const fork = await Session.fork({ sessionID: session.id })
    await Session.remove(session.id)
    const parts = (await Session.messages({ sessionID: fork.id })).flatMap(message => message.parts)
    for (const part of parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const filePath = part.state.metadata.path as string
      expect(part.state.input.path).toBe(filePath)
      expect(part.state.metadata.previewId).toBeUndefined()
      // This is the metadata path and endpoint used by MessageGroup/ToolCall.
      const response = await Server.App().request(`/file/preview-by-path?path=${encodeURIComponent(filePath)}`, {
        headers: { "x-opencode-directory": directory },
      })
      expect(response.status).toBe(200)
      expect(Buffer.from((await response.json()).content, "base64").toString()).toBe(part.tool)
    }
  })
})
