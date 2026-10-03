import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { SearchJournal } from "../../src/storage/search-journal"

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

for (const scenario of [
  "backfill-live-writer",
  "writer-finishes-late",
  "cache-replacement-storage",
  "cache-rebuild-writer-crash",
  "journal-unavailable-storage",
  "inflight-cache-replacement",
  "journal-initialization-failure",
]) {
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

const journalFilename = path.join(Global.Path.data, "session-search-journal-v1.sqlite")
function assertNoWriters() {
  const db = new Database(journalFilename)
  try {
    expect(db.query("SELECT id FROM writers WHERE key = ?").all(JSON.stringify(sessionKey))).toEqual([])
  } finally {
    db.close()
  }
}

for (const operation of ["write", "update", "writeAtomic", "remove", "corrupt-read", "corrupt-update"] as const) {
  test(`terminal ${operation} failure retires its exact writer and preserves bounded reads`, async () => {
    await Storage.write(sessionKey, info)
    await search()
    const target = path.join(Global.Path.data, "storage", ...sessionKey) + ".json"
    if (operation.startsWith("corrupt")) await Bun.write(target, "{broken")
    const write = Bun.write
    const unlink = fs.unlink
    const failure = Object.assign(new Error("simulated source failure"), { code: "ENOSPC" })
    Bun.write = (async (...args: any[]) => {
      if (
        String(args[0]) === target ||
        String(args[0]).startsWith(path.join(path.dirname(target), ".ses_cache_test.json."))
      )
        throw failure
      return (write as (...values: any[]) => any)(...args)
    }) as typeof Bun.write
    fs.unlink = (async (file: any) => {
      if (String(file) === target) throw failure
      return unlink(file)
    }) as typeof fs.unlink
    try {
      const mutation =
        operation === "write"
          ? Storage.write(sessionKey, info)
          : operation === "update"
            ? Storage.update<typeof info>(sessionKey, (draft) => {
                draft.title = "changed"
              })
            : operation === "writeAtomic"
              ? Storage.writeAtomic(sessionKey, info)
              : operation === "remove"
                ? Storage.remove(sessionKey)
                : operation === "corrupt-read"
                  ? Storage.read(sessionKey)
                  : Storage.update(sessionKey, () => {})
      await expect(mutation).rejects.toThrow()
    } finally {
      Bun.write = write
      fs.unlink = unlink
    }
    assertNoWriters()
    await Storage.write(sessionKey, info)
    await search()
    const file = Bun.file
    let reads = 0
    Bun.file = ((...args: any[]) => {
      if (String(args[0]) === target) reads++
      return (file as (...values: any[]) => any)(...args)
    }) as typeof Bun.file
    try {
      expect((await search()).results).toHaveLength(1)
      expect((await search()).results).toHaveLength(1)
      expect(reads).toBe(0)
    } finally {
      Bun.file = file
    }
  })
}

test("a temporarily failed journal finish retries retirement without retiring another active writer", async () => {
  await Storage.write(sessionKey, info)
  await search()
  const another = new SearchJournal(journalFilename)
  const activeToken = another.begin(sessionKey)
  const target = path.join(Global.Path.data, "storage", ...sessionKey) + ".json"
  const write = Bun.write
  const query = Database.prototype.query
  let blocked = false
  let attempts = 0
  const inspect = new Database(journalFilename)
  Database.prototype.query = function (this: Database, sql: any, ...args: any[]) {
    if (blocked && String(sql) === "DELETE FROM writers WHERE id = ? AND key = ?") {
      attempts++
      throw Object.assign(new Error("simulated journal disk full"), { code: "ENOSPC" })
    }
    return (query as (...values: any[]) => any).call(this, sql, ...args)
  } as typeof Database.prototype.query
  Bun.write = (async (...args: any[]) => {
    const result = await (write as (...values: any[]) => any)(...args)
    if (String(args[0]) === target) blocked = true
    return result
  }) as typeof Bun.write
  try {
    await Storage.write(sessionKey, { ...info, title: "after journal failure needle" })
    expect(attempts).toBe(1)
    expect(inspect.query("SELECT id FROM writers WHERE key = ?").all(JSON.stringify(sessionKey))).toHaveLength(2)
  } finally {
    Bun.write = write
    Database.prototype.query = query
  }
  try {
    // The owner is idle: completion recovery must not depend on another write.
    const deadline = Date.now() + 2000
    while (inspect.query("SELECT id FROM writers WHERE key = ?").all(JSON.stringify(sessionKey)).length > 1) {
      if (Date.now() > deadline) throw new Error("Finished writer was not retired after journal recovery")
      await Bun.sleep(20)
    }
    expect(inspect.query("SELECT id FROM writers WHERE key = ?").all(JSON.stringify(sessionKey))).toEqual([
      { id: activeToken },
    ])
    expect((await search()).results[0].session.title).toBe("after journal failure needle")
    another.finish(sessionKey, activeToken)
    await search()
    assertNoWriters()
    const file = Bun.file
    let reads = 0
    Bun.file = ((...args: any[]) => {
      if (String(args[0]) === target) reads++
      return (file as (...values: any[]) => any)(...args)
    }) as typeof Bun.file
    try {
      await search()
      await search()
      expect(reads).toBe(0)
    } finally {
      Bun.file = file
    }
  } finally {
    another.finish(sessionKey, activeToken)
    another.close()
    inspect.close()
  }
})

test("repeated cache invalidation during awaited IO uses one bounded retry", async () => {
  await Storage.write(sessionKey, info)
  await search()
  await Storage.write(sessionKey, { ...info, title: "new needle" })
  const target = path.join(Global.Path.data, "storage", ...sessionKey) + ".json"
  const original = Bun.file
  let reads = 0
  Bun.file = ((...args: any[]) => {
    const file = (original as (...values: any[]) => any)(...args)
    if (String(args[0]) === target) {
      const json = file.json.bind(file)
      Object.defineProperty(file, "json", {
        value: async () => {
          const value = await json()
          reads++
          await Storage.rebuildSessionSearch()
          return value
        },
      })
    }
    return file
  }) as typeof Bun.file
  try {
    await expect(search()).rejects.toThrow("cache was replaced")
    expect(reads).toBe(2)
  } finally {
    Bun.file = original
  }
  expect((await search()).results[0].session.title).toBe("new needle")
})

for (const code of ["EIO", "EACCES", "ENOENT"]) {
  test(`initial search enumeration treats ${code} truthfully`, async () => {
    const project = `${projectID}-${code}`
    const key = ["session", project, info.id]
    const query = () => Storage.searchSessions({ projectID: project, q: "needle" })
    await Bun.write(path.join(Global.Path.data, "storage", ...key) + ".json", JSON.stringify(info))
    const original = Bun.Glob.prototype.scan
    const target = path.join(Global.Path.data, "storage", "session", project)
    Bun.Glob.prototype.scan = function (this: Bun.Glob, options: any) {
      if (options.cwd === target) throw Object.assign(new Error("historical enumeration failure"), { code })
      return original.call(this, options)
    } as typeof original
    try {
      if (code === "ENOENT") expect((await query()).results).toEqual([])
      else await expect(query()).rejects.toThrow("could not read history")
      expect(await Storage.list(["session", project])).toEqual([])
    } finally {
      Bun.Glob.prototype.scan = original
    }
    if (code === "ENOENT") await Storage.rebuildSessionSearch()
    try {
      expect((await query()).results).toHaveLength(1)
      expect(await Storage.read<typeof info>(key)).toEqual(info)
    } finally {
      await Storage.remove(key)
    }
  })
}

for (const subtree of ["message", "part"] as const) {
  test(`ready project retries a newly indexed parent's failed ${subtree} enumeration`, async () => {
    // Establish project completeness before this parent's pre-existing history
    // becomes visible. Its only dirty marker is the later parent write.
    await search()
    const session = "ses_new_history"
    const message = "msg_new_history"
    const part = "prt_new_history"
    const parentKey = ["session", projectID, session]
    const messageKey = ["message", session, message]
    const partKey = ["part", message, part]
    const sourcePath = (key: string[]) => path.join(Global.Path.data, "storage", ...key) + ".json"
    await Bun.write(sourcePath(messageKey), JSON.stringify({ id: message, sessionID: session, role: "user" }))
    await Bun.write(
      sourcePath(partKey),
      JSON.stringify({ id: part, messageID: message, sessionID: session, type: "text", text: "historical needle" }),
    )
    await Storage.write(parentKey, { id: session, title: "New parent", time: { updated: 2 } })
    const target = path.join(Global.Path.data, "storage", subtree, subtree === "message" ? session : message)
    const original = Bun.Glob.prototype.scan
    let injected = 0
    Bun.Glob.prototype.scan = function (this: Bun.Glob, options: any) {
      if (options.cwd === target) {
        injected++
        throw Object.assign(new Error("child enumeration EACCES"), { code: "EACCES" })
      }
      return original.call(this, options)
    } as typeof original
    try {
      await expect(search()).rejects.toThrow("could not read history")
      expect(injected).toBe(1)
    } finally {
      Bun.Glob.prototype.scan = original
    }
    try {
      expect(
        (await search()).results.some((result) => result.session.id === session && result.messageID === message),
      ).toBe(true)
      expect((await search()).results.some((result) => result.session.id === session)).toBe(true)
      expect(await Bun.file(sourcePath(partKey)).json()).toMatchObject({ text: "historical needle" })
    } finally {
      await Storage.remove(parentKey)
      await Storage.remove(messageKey)
      await Storage.remove(partKey)
    }
  })
}

test("an obsolete source walk cannot invalidate a newer ready cache", async () => {
  await Storage.write(sessionKey, info)
  await Storage.rebuildSessionSearch()
  const started = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const original = Bun.Glob.prototype.scan
  const target = path.join(Global.Path.data, "storage", "session", projectID)
  Bun.Glob.prototype.scan = function (this: Bun.Glob, options: any) {
    if (options.cwd !== target) return original.call(this, options)
    return (async function* () {
      started.resolve()
      await resume.promise
      throw Object.assign(new Error("obsolete source walk failed"), { code: "EIO" })
    })()
  } as typeof original
  const obsolete = search().then(
    () => undefined,
    (error: unknown) => error,
  )
  await started.promise
  Bun.Glob.prototype.scan = original
  try {
    await Storage.rebuildSessionSearch()
    expect((await search()).results).toHaveLength(1)
    const db = new Database(journalFilename)
    try {
      const epoch = () => db.query("SELECT value FROM cache_epoch WHERE slot = 1").get()
      const before = epoch()
      resume.resolve()
      expect(await obsolete).toBeInstanceOf(Error)
      expect(epoch()).toEqual(before)
      expect(await Bun.file(filename).exists()).toBe(true)
      expect((await search()).results).toHaveLength(1)
    } finally {
      db.close()
    }
  } finally {
    resume.resolve()
    Bun.Glob.prototype.scan = original
    await obsolete
  }
})
