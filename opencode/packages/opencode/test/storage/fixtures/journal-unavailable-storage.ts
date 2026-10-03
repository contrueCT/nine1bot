import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
const base = process.env.SEARCH_RACE_DIR!
for (const key of ["DATA", "CACHE", "CONFIG", "STATE"])
  process.env[`XDG_${key}_HOME`] = path.join(base, key.toLowerCase())
process.env.HOME = path.join(base, "home")
process.env.OPENCODE_TEST_HOME = process.env.HOME
const data = path.join(base, "data", "opencode")
await Bun.write(path.join(base, "cache", "opencode", "version"), "19")
await Bun.write(path.join(data, "storage", "migration"), "2")
const journal = path.join(data, "session-search-journal-v1.sqlite")
await fs.mkdir(journal)
const { Storage } = await import("../../../src/storage/storage")
const key = ["session", "project", "session-1"]
const info = { id: "session-1", title: "initial", time: { created: 1, updated: 1 } }
const search = () => Storage.searchSessions({ projectID: "project", q: "updated" })
await Storage.write(key, info)
await Storage.update<typeof info>(key, (draft) => {
  draft.title = "updated"
})
assert.equal((await Storage.read<typeof info>(key)).title, "updated")
await assert.rejects(search())
// Clearing this deliberately unusable fresh test path restores indexing; JSON survived.
await fs.rmdir(journal)
const target = path.join(data, "storage", ...key) + ".json"
const file = Bun.file
let reads = 0
Bun.file = ((...args: any[]) => {
  if (String(args[0]) === target) reads++
  return (file as (...values: any[]) => any)(...args)
}) as typeof Bun.file
assert.equal((await search()).results.length, 1)
const recovered = reads
// One canonical dirty-key reconciliation plus the first project backfill.
assert.equal(recovered, 2)
assert.equal((await search()).results.length, 1)
assert.equal(reads, recovered)
Bun.file = file
