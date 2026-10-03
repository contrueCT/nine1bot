import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
const root = process.env.SEARCH_RACE_DIR!
for (const kind of ["DATA", "CACHE", "CONFIG", "STATE"])
  process.env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase())
process.env.HOME = path.join(root, "home")
process.env.OPENCODE_TEST_HOME = process.env.HOME
const marker = (name: string) => path.join(root, name)
const wait = async (name: string) => {
  const deadline = Date.now() + 8000
  while (!fs.existsSync(marker(name))) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${name}`)
    await Bun.sleep(5)
  }
}
const key = ["session", "project", "session"]
const journal = path.join(root, "data", "opencode", "session-search-journal-v1.sqlite")
if (!process.argv[2]) {
  await Bun.write(path.join(root, "cache", "opencode", "version"), "19")
  await Bun.write(path.join(root, "data", "opencode", "storage", "migration"), "2")
  const options = { env: process.env, stdout: "inherit" as const, stderr: "inherit" as const }
  const reader = Bun.spawn([process.execPath, import.meta.path, "reader"], options)
  await wait("ready")
  for (const mode of ["finish", "crash"]) {
    const writer = Bun.spawn([process.execPath, import.meta.path, mode], options)
    assert.equal(await writer.exited, 0)
    fs.writeFileSync(marker(`${mode}-exited`), "")
    await wait(`${mode}-verified`)
  }
  assert.equal(await reader.exited, 0)
} else {
  const { Storage } = await import("../../../src/storage/storage")
  const search = (q: string) => Storage.searchSessions({ projectID: "project", q })
  if (process.argv[2] === "reader") {
    await Storage.write(key, { id: key[2], title: "old alpha", time: { updated: 1 } })
    assert.equal((await search("old alpha")).results.length, 1)
    fs.writeFileSync(marker("ready"), "")
    for (const mode of ["finish", "crash"]) {
      await wait(`${mode}-exited`)
      assert.equal((await search(`new beta ${mode}`)).results.length, 1)
      assert.equal((await search("old alpha")).results.length, 0)
      const db = new Database(journal)
      assert.deepEqual(db.query("SELECT * FROM pending").all(), [])
      assert.deepEqual(db.query("SELECT * FROM writers").all(), [])
      db.close()
      assert.deepEqual(fs.readdirSync(`${journal}.fallback`), [])
      fs.writeFileSync(marker(`${mode}-verified`), "")
    }
  } else {
    const exec = Database.prototype.exec
    Database.prototype.exec = function (this: Database, sql: string) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS pending"))
        throw Object.assign(new Error("transient initialization failure"), { code: "EIO" })
      return exec.call(this, sql)
    } as typeof Database.prototype.exec
    if (process.argv[2] === "crash") {
      const write = Bun.write
      Bun.write = (async (...args: any[]) => {
        const result = await (write as (...values: any[]) => any)(...args)
        if (String(args[0]).endsWith("session/project/session.json")) process.exit(0)
        return result
      }) as typeof Bun.write
    }
    await Storage.write(key, { id: key[2], title: `new beta ${process.argv[2]}`, time: { updated: 2 } })
    assert.equal((await Storage.read<{ title: string }>(key)).title, "new beta finish")
    // No query or successful journal construction in this writer process.
  }
}
