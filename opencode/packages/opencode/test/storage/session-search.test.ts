import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

const filename = path.join(Global.Path.cache, "session-search-v1.sqlite")
const projectID = "search-cache-test"
const sessionKey = ["session", projectID, "ses_cache_test"]
const info = { id: "ses_cache_test", title: "cache recovery needle", time: { updated: 1 } }
const search = () => Storage.searchSessions({ projectID, q: "needle" })

afterEach(async () => {
  await Storage.remove(sessionKey)
  await Storage.rebuildSessionSearch()
})

describe("session search cache recovery", () => {
  test("rebuilds a missing cache while open and a damaged SQLite file before open", async () => {
    await Storage.write(sessionKey, info)
    expect((await search()).results).toHaveLength(1)
    await fs.unlink(filename)
    expect((await search()).results).toHaveLength(1)
    await Storage.rebuildSessionSearch()
    await Bun.write(filename, "this is not a sqlite file")
    expect((await search()).results).toHaveLength(1)
  })

  test("rebuilds query-time FTS corruption without changing source records", async () => {
    await Storage.write(sessionKey, info)
    expect((await search()).results).toHaveLength(1)
    const db = new Database(filename)
    db.exec("DROP TABLE document_fts")
    db.close()
    expect((await search()).results).toHaveLength(1)
    expect(await Storage.read<typeof info>(sessionKey)).toEqual(info)
  })

  test("cannot block source writes when the index path is unusable", async () => {
    await Storage.rebuildSessionSearch()
    await fs.mkdir(filename)
    try {
      await Storage.write(sessionKey, info)
      expect(await Storage.read<typeof info>(sessionKey)).toEqual(info)
      await Storage.update<typeof info>(sessionKey, (draft) => {
        draft.title = "updated needle"
      })
      expect((await Storage.read<typeof info>(sessionKey)).title).toBe("updated needle")
    } finally {
      await fs.rm(filename, { recursive: true, force: true })
    }
    expect((await search()).results[0].session.title).toBe("updated needle")
  })
})

for (const scenario of ["backfill-live-writer", "writer-finishes-late", "cache-replacement-storage"]) {
  test(`canonical reconciliation across processes: ${scenario}`, async () => {
    const root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "search-race-"))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", `${scenario}.ts`)], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, SEARCH_RACE_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 15000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, errors: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, errors: "" })
    } finally {
      clearTimeout(timer)
      child.kill()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 20000)
}
