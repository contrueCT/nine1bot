import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
const base = process.env.SEARCH_RACE_DIR!
for (const key of ["DATA", "CACHE", "CONFIG", "STATE"])
  process.env[`XDG_${key}_HOME`] = path.join(base, key.toLowerCase())
process.env.HOME = path.join(base, "home")
process.env.OPENCODE_TEST_HOME = process.env.HOME
const marker = (name: string) => path.join(base, name)
async function wait(name: string) {
  const deadline = Date.now() + 10000
  while (!fs.existsSync(marker(name))) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${name}`)
    await Bun.sleep(5)
  }
}
const storage = path.join(base, "data", "opencode", "storage")
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
}
const { Storage } = await import("../../../src/storage/storage")
const search = (q: string) => Storage.searchSessions({ projectID: "project", q })
if (Bun.argv[2] === "writer") {
  await search("old needle")
  const write = Bun.write
  Bun.write = (async (...args: any[]) => {
    if (String(args[0]) === target) {
      await write(marker("begun"), "")
      await wait("release")
      await (write as (...values: any[]) => any)(...args)
      // Simulate termination after canonical persistence but before finally/finish.
      process.exit(0)
    }
    return (write as (...values: any[]) => any)(...args)
  }) as typeof Bun.write
  await Storage.write(key, { ...part, text: "new current" })
} else {
  const writer = Bun.spawn([process.execPath, import.meta.path, "writer"], { stdout: "inherit", stderr: "inherit" })
  await wait("begun")
  const cache = new Database(path.join(base, "cache", "opencode", "session-search-v1.sqlite"))
  cache.exec("DROP TABLE document_fts")
  cache.close()
  assert.equal((await search("old needle")).results.length, 1)
  await Bun.write(marker("release"), "")
  assert.equal(await writer.exited, 0)
  assert.equal((await search("new current")).results[0]?.messageID, "msg-1")
  assert.equal((await search("old needle")).results.length, 0)
  const journal = new Database(path.join(base, "data", "opencode", "session-search-journal-v1.sqlite"))
  assert.deepEqual(journal.query("SELECT * FROM pending").all(), [])
  assert.deepEqual(journal.query("SELECT * FROM writers").all(), [])
  journal.close()
}
