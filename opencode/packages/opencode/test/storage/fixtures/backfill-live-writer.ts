import assert from "node:assert/strict"
import { SessionSearch } from "../../../src/storage/session-search"
import fs from "node:fs"
import path from "node:path"
const dir = process.env.SEARCH_RACE_DIR!
const filename = path.join(dir, "race.sqlite")
const key = ["message", "session-1", "msg-1"]
const message = { id: "msg-1", sessionID: "session-1", role: "user" }
if (Bun.argv[2] === "writer") {
  const index = new SessionSearch.Index(filename, { list: async () => [], read: async () => undefined })
  index.begin(key)
  await Bun.write(path.join(dir, "begun"), `${process.pid}`)
  const deadline = Date.now() + 10000
  while (!fs.existsSync(path.join(dir, "finish"))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for finish")
    await Bun.sleep(5)
  }
  index.finish(key, message)
  index.close()
} else {
  const records = new Map<string, unknown>([
    [
      JSON.stringify(["session", "project", "session-1"]),
      { id: "session-1", title: "Historical", time: { updated: 1 } },
    ],
    [JSON.stringify(key), message],
    [
      JSON.stringify(["part", "msg-1", "part-1"]),
      { id: "part-1", messageID: "msg-1", sessionID: "session-1", type: "text", text: "historical needle" },
    ],
  ])
  const source = {
    list: async (prefix: string[]) =>
      [...records.keys()].map((k) => JSON.parse(k)).filter((k) => prefix.every((p, i) => k[i] === p)),
    read: async (k: string[]) => records.get(JSON.stringify(k)),
  }
  let index = new SessionSearch.Index(filename, source)
  const writer = Bun.spawn([process.execPath, import.meta.path, "writer"], { stdout: "inherit", stderr: "inherit" })
  const deadline = Date.now() + 10000
  while (!fs.existsSync(path.join(dir, "begun"))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for begin")
    await Bun.sleep(5)
  }
  console.log("writer live PID", fs.readFileSync(path.join(dir, "begun"), "utf8"))
  console.log("during first backfill", await index.search({ projectID: "project", q: "needle" }))
  await Bun.write(path.join(dir, "finish"), "")
  assert.equal(await writer.exited, 0)
  assert.equal((await index.search({ projectID: "project", q: "needle" })).results[0]?.messageID, "msg-1")
  index.close()
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(filename + suffix, { force: true })
  index = new SessionSearch.Index(filename, source)
  console.log("after cache rebuild same canonical records", await index.search({ projectID: "project", q: "needle" }))
  index.close()
}
