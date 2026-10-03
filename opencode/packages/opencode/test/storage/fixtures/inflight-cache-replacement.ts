import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
const base = process.env.SEARCH_RACE_DIR!
for (const k of ["DATA", "CACHE", "CONFIG", "STATE"]) process.env[`XDG_${k}_HOME`] = path.join(base, k.toLowerCase())
process.env.HOME = path.join(base, "home")
process.env.OPENCODE_TEST_HOME = process.env.HOME
const marker = (n: string) => path.join(base, n)
const wait = async (n: string) => {
  const end = Date.now() + 8000
  while (!fs.existsSync(marker(n))) {
    if (Date.now() > end) throw Error(`Timed out ${n}`)
    await Bun.sleep(5)
  }
}
const storage = path.join(base, "data", "opencode", "storage")
const filename = path.join(base, "cache", "opencode", "session-search-v1.sqlite")
const journalname = path.join(base, "data", "opencode", "session-search-journal-v1.sqlite")
const key = ["part", "msg-1", "part-1"]
const target = path.join(storage, ...key) + ".json"
const part = { id: "part-1", messageID: "msg-1", sessionID: "session-1", type: "text", text: "old needle" }
if (!Bun.argv[2]) {
  await Bun.write(path.join(base, "cache", "opencode", "version"), "19")
  await Bun.write(path.join(storage, "migration"), "2")
  await Bun.write(
    path.join(storage, "session", "project", "session-1.json"),
    JSON.stringify({ id: "session-1", title: "History", time: { created: 1, updated: 1 } }),
  )
  await Bun.write(
    path.join(storage, "message", "session-1", "msg-1.json"),
    JSON.stringify({ id: "msg-1", sessionID: "session-1", role: "user" }),
  )
  await Bun.write(target, JSON.stringify(part))
  const options = { env: { ...process.env }, stdout: "inherit" as const, stderr: "inherit" as const }
  const reader = Bun.spawn([process.execPath, import.meta.path, "reader"], options)
  await wait("reader-ready")
  const writer = Bun.spawn([process.execPath, import.meta.path, "writer"], options)
  await wait("captured")
  const rebuilder = Bun.spawn([process.execPath, import.meta.path, "rebuilder"], options)
  await wait("ready")
  await Bun.write(marker("writer-release"), "")
  await wait("writer-done")
  await Bun.write(marker("reader-release"), "")
  const [a, b, c] = await Promise.all([reader.exited, writer.exited, rebuilder.exited])
  assert.equal(a, 0)
  assert.equal(b, 0)
  assert.equal(c, 0)
  assert.equal((await Bun.file(target).json()).text, "new current")
} else {
  const { Storage } = await import("../../../src/storage/storage")
  const search = (q: string) => Storage.searchSessions({ projectID: "project", q })
  if (Bun.argv[2] === "reader") {
    assert.equal((await search("old")).results.length, 1)
    await Bun.write(marker("reader-ready"), "")
    await wait("writer-begun")
    const original = Bun.file
    let once = true
    Bun.file = ((...args: any[]) => {
      const file = (original as any)(...args)
      if (args[0] === target && once) {
        once = false
        const json = file.json.bind(file)
        Object.defineProperty(file, "json", {
          value: async () => {
            const snapshot = await json()
            await Bun.write(marker("captured"), "")
            await wait("reader-release")
            return snapshot
          },
        })
      }
      return file
    }) as any
    const result = await search("new current")
    console.log("all-Storage in-flight new", result.results.length)
    assert.equal(result.results.length, 1)
    Bun.file = original
    const db = new Database(journalname)
    console.log("all-Storage pending", JSON.stringify(db.query("SELECT * FROM pending").all()))
    assert.deepEqual(db.query("SELECT * FROM pending").all(), [])
    db.close()
    await Bun.write(marker("reader-done"), "")
    await wait("checked")
  } else if (Bun.argv[2] === "writer") {
    const original = Bun.write
    Bun.write = (async (...args: any[]) => {
      if (args[0] === target) {
        await original(marker("writer-begun"), "")
        await wait("writer-release")
      }
      return (original as any)(...args)
    }) as any
    await Storage.write(key, { ...part, text: "new current" })
    Bun.write = original
    await original(marker("writer-done"), "")
  } else {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(filename + suffix, { force: true })
    assert.equal((await search("old")).results.length, 1)
    await Bun.write(marker("ready"), "")
    await wait("reader-done")
    const old = await search("old")
    const current = await search("new current")
    console.log("all-Storage replacement old hit", old.results.length, "new hit", current.results.length)
    assert.equal(old.results.length, 0)
    assert.equal(current.results.length, 1)
    await Bun.write(marker("checked"), "")
  }
}
