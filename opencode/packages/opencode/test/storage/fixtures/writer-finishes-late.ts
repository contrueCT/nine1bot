import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
const base = process.env.SEARCH_RACE_DIR!
for (const key of ["DATA", "CACHE", "CONFIG", "STATE"])
  process.env[`XDG_${key}_HOME`] = path.join(base, key.toLowerCase())
process.env.HOME = path.join(base, "home")
process.env.OPENCODE_TEST_HOME = process.env.HOME
const marker = (s: string) => path.join(base, s)
const wait = async (s: string) => {
  const start = Date.now()
  while (!fs.existsSync(marker(s))) {
    if (Date.now() - start > 10000) throw Error(`timed out ${s}`)
    await Bun.sleep(5)
  }
}
const storageDir = path.join(base, "data", "opencode", "storage")
const partKey = ["part", "msg-1", "part-1"]
const partFile = path.join(storageDir, ...partKey) + ".json"
const oldPart = { id: "part-1", messageID: "msg-1", sessionID: "session-1", type: "text", text: "old needle" }
const newPart = { ...oldPart, text: "new current" }
const mode = Bun.argv[2]
if (!mode) {
  fs.mkdirSync(path.join(base, "cache", "opencode"), { recursive: true })
  await Bun.write(path.join(base, "cache", "opencode", "version"), "19")
  await Bun.write(path.join(storageDir, "migration"), "2")
  await Bun.write(
    path.join(storageDir, "session", "project", "session-1.json"),
    JSON.stringify({ id: "session-1", title: "Historical", time: { created: 1, updated: 1 } }),
  )
  await Bun.write(
    path.join(storageDir, "message", "session-1", "msg-1.json"),
    JSON.stringify({ id: "msg-1", sessionID: "session-1", role: "user" }),
  )
  await Bun.write(partFile, JSON.stringify(oldPart))
  const a = Bun.spawn([process.execPath, import.meta.path, "writer"], { stdout: "inherit", stderr: "inherit" })
  await wait("write-begun")
  const b = Bun.spawn([process.execPath, import.meta.path, "rebuild"], { stdout: "inherit", stderr: "inherit" })
  await wait("b-finished")
  await Bun.write(marker("write-release"), "")
  await wait("write-finished")
  await Bun.write(marker("read-release"), "")
  assert.equal(await a.exited, 0)
  assert.equal(await b.exited, 0)
  console.log("canonical text", (await Bun.file(partFile).json()).text)
} else {
  const { Storage } = await import("../../../src/storage/storage")
  const search = (q: string) => Storage.searchSessions({ projectID: "project", q })
  if (mode === "writer") {
    await search("old needle")
    const original = Bun.write
    Bun.write = (async (...args: any[]) => {
      const bytes = await (original as (...values: any[]) => any)(...args)
      if (args[0] === partFile) {
        await original(marker("write-begun"), "")
        await wait("write-release")
      }
      return bytes
    }) as any
    await Storage.write(partKey, newPart)
    Bun.write = original
    await original(marker("write-finished"), "")
    await wait("read-release")
  } else {
    await Storage.write(partKey, { ...oldPart, text: "latest beta" })
    await Bun.write(marker("b-finished"), "")
    await wait("read-release")
    assert.equal((await search("latest beta")).results[0]?.messageID, "msg-1")
    assert.equal((await search("new current")).results.length, 0)
    const { Database } = await import("bun:sqlite")
    const db = new Database(path.join(base, "data", "opencode", "session-search-journal-v1.sqlite"))
    console.log("new cache versions", db.query("SELECT * FROM versions").all())
    db.close()
  }
}
