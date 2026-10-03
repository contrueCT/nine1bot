import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import { SearchJournal } from "../../src/storage/search-journal"
import os from "node:os"
import path from "node:path"
import { SessionSearch } from "../../src/storage/session-search"

const indexes: SessionSearch.Index[] = []
const directories: string[] = []
afterEach(async () => {
  indexes.splice(0).forEach((index) => index.close())
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function fixture(filename = ":memory:") {
  const records = new Map<string, unknown>()
  let reads = 0
  const source: SessionSearch.Source = {
    list: async (prefix) =>
      [...records.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((key) => prefix.every((item, i) => key[i] === item)),
    read: async (key) => {
      reads++
      return records.get(JSON.stringify(key))
    },
  }
  const index = new SessionSearch.Index(filename, source)
  indexes.push(index)
  const write = (key: string[], value: unknown) => {
    index.begin(key)
    if (value === undefined) records.delete(JSON.stringify(key))
    else records.set(JSON.stringify(key), value)
    index.finish(key, value)
  }
  const session = (id: string, title = "Ordinary title", extra = {}) =>
    write(["session", "project", id], {
      id,
      title,
      projectID: "project",
      directory: "/project",
      slug: id,
      version: "1",
      time: { created: 1, updated: Number(id.replace(/\D/g, "")) || 1 },
      ...extra,
    })
  const message = (sessionID: string, id: string, text: string, extra = {}) => {
    write(["message", sessionID, id], { id, sessionID, role: "user" })
    write(["part", id, `part-${id}`], { id: `part-${id}`, sessionID, messageID: id, type: "text", text, ...extra })
  }
  return {
    index,
    source,
    records,
    write,
    session,
    message,
    reads: () => reads,
    search: (q: string, extra = {}) => index.search({ q, projectID: "project", ...extra }),
  }
}

describe("session full-text index", () => {
  test("finds English, Chinese, emoji and literal code substrings with accurate message IDs", async () => {
    const f = fixture()
    f.session("session-1")
    f.message("session-1", "msg-1", 'Here is 你好世界, const getUser = (a) => a?.profile; 😀🚀 and "quoted" 100%_value')
    for (const q of ["GETUSER", "你好", "好世界", "a?.profile", "=>", "😀🚀", '"quoted"', "100%_", "%", "_"]) {
      const result = await f.search(q)
      expect(result.results.map((row) => row.messageID)).toEqual(["msg-1"])
      expect(result.results[0].snippet).toContain("你好世界")
    }
    expect((await f.search("missing")).results).toEqual([])
    expect((await f.search(" ")).results).toEqual([])
  })

  test("prefers title hit, deduplicates sessions and uses deterministic newest message hit", async () => {
    const f = fixture()
    f.session("session-1", "Needle title")
    f.message("session-1", "msg-1", "needle first")
    f.message("session-1", "msg-2", "needle second")
    expect((await f.search("needle")).results).toHaveLength(1)
    expect((await f.search("needle")).results[0].messageID).toBeUndefined()
    f.session("session-1", "Changed title")
    expect((await f.search("needle")).results[0].messageID).toBe("msg-2")
  })

  test("excludes hidden content, tools, attachments, reasoning, summary and orphan parts", async () => {
    const f = fixture()
    f.session("session-1")
    for (const [i, extra] of [
      { synthetic: true },
      { ignored: true },
      { type: "reasoning" },
      { type: "tool" },
      { type: "file", url: "secret" },
      { metadata: { hidden: true } },
    ].entries()) {
      f.message("session-1", `msg-${i}`, "secret", extra)
    }
    f.message("session-1", "msg-summary", "secret")
    f.write(["message", "session-1", "msg-summary"], {
      id: "msg-summary",
      sessionID: "session-1",
      role: "assistant",
      summary: true,
    })
    f.write(["part", "msg-orphan", "part-orphan"], {
      id: "part-orphan",
      sessionID: "session-1",
      messageID: "msg-orphan",
      type: "text",
      text: "secret",
    })
    expect((await f.search("secret")).results).toEqual([])
  })

  test("filters projects, roots, automation and client source before result limit", async () => {
    const f = fixture()
    for (let i = 1; i <= 60; i++) f.session(`session-${i}`, "needle", { client: { source: "web" } })
    f.session("session-extension", "needle", { client: { source: "browser-extension" } })
    f.session("child", "needle", { parentID: "session-1" })
    f.session("schedule", "needle", { client: { source: "schedule" } })
    f.session("webhook", "needle", { client: { source: "webhook" } })
    f.write(["session", "other", "other-session"], { id: "other-session", title: "needle", time: { updated: 99 } })
    const result = await f.search("needle", { limit: 50 })
    expect(result.results).toHaveLength(50)
    expect(result.hasMore).toBe(true)
    expect(result.results[0].session.id).toBe("session-60")
    const extension = await f.search("needle", { limit: 1, clientSource: "browser-extension" })
    expect(extension.results.map((row) => row.session.id)).toEqual(["session-extension"])
    expect(extension.hasMore).toBe(false)
    expect((await f.search("needle", { projectID: "other" })).results.map((row) => row.session.id)).toEqual([
      "other-session",
    ])
  })

  test("incremental edits, role changes, part/message/session deletion remove stale hits", async () => {
    const f = fixture()
    f.session("session-1")
    f.message("session-1", "msg-1", "before")
    expect((await f.search("before")).results).toHaveLength(1)
    f.message("session-1", "msg-1", "after")
    expect((await f.search("before")).results).toEqual([])
    expect((await f.search("after")).results).toHaveLength(1)
    f.write(["message", "session-1", "msg-1"], { id: "msg-1", sessionID: "session-1", role: "system" })
    expect((await f.search("after")).results).toEqual([])
    f.message("session-1", "msg-1", "after")
    f.write(["part", "msg-1", "part-msg-1"], undefined)
    expect((await f.search("after")).results).toEqual([])
    f.message("session-1", "msg-1", "after")
    f.write(["message", "session-1", "msg-1"], undefined)
    expect((await f.search("after")).results).toEqual([])
    f.message("session-1", "msg-1", "after")
    f.write(["session", "project", "session-1"], undefined)
    expect((await f.search("after")).results).toEqual([])
  })

  test("revert hides undone messages and parts and undo makes them searchable again", async () => {
    const f = fixture()
    f.session("session-1")
    f.message("session-1", "msg-1", "needle one")
    f.message("session-1", "msg-2", "needle two")
    f.session("session-1", "Title", { revert: { messageID: "msg-2" } })
    expect((await f.search("needle")).results[0].messageID).toBe("msg-1")
    f.session("session-1", "Title", { revert: { messageID: "msg-1", partID: "part-msg-1" } })
    expect((await f.search("needle")).results).toEqual([])
    f.session("session-1")
    expect((await f.search("needle")).results[0].messageID).toBe("msg-2")
  })

  test("backfills historical JSON once, persists ready index across restarts, repairs interrupted mutation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-"))
    directories.push(dir)
    const filename = path.join(dir, "search.sqlite")
    const f = fixture(filename)
    f.records.set(JSON.stringify(["session", "project", "session-1"]), {
      id: "session-1",
      title: "Historical",
      time: { updated: 1 },
    })
    f.records.set(JSON.stringify(["message", "session-1", "msg-1"]), {
      id: "msg-1",
      sessionID: "session-1",
      role: "assistant",
    })
    const partKey = ["part", "msg-1", "part-1"]
    const part = { id: "part-1", messageID: "msg-1", sessionID: "session-1", type: "text", text: "Old history" }
    f.records.set(JSON.stringify(partKey), part)
    expect((await f.search("history")).results[0].messageID).toBe("msg-1")
    const reads = f.reads()
    await f.search("old")
    expect(f.reads()).toBe(reads)
    f.index.begin(partKey)
    f.records.set(JSON.stringify(partKey), { ...part, text: "Recovered text" })
    // Simulate the journal owner having exited, rather than a live same-process writer.
    const { Database } = await import("bun:sqlite")
    const journal = new Database(`${filename}.journal`)
    journal.query("UPDATE writers SET pid = 2147483647").run()
    journal.close()
    f.index.close()
    indexes.splice(indexes.indexOf(f.index), 1)
    const reopened = new SessionSearch.Index(filename, f.source)
    indexes.push(reopened)
    expect((await reopened.search({ projectID: "project", q: "Recovered" })).results[0].messageID).toBe("msg-1")
    expect((await reopened.search({ projectID: "project", q: "history" })).results).toEqual([])
    expect(f.reads()).toBe(reads + 1)
  })

  test("backfill cannot overwrite a newer concurrent mutation", async () => {
    const f = fixture()
    const key = ["session", "project", "session-1"]
    f.records.set(JSON.stringify(key), { id: "session-1", title: "before", time: { updated: 1 } })
    const read = f.source.read
    let once = true
    f.source.read = async (input) => {
      const value = await read(input)
      if (once) {
        once = false
        f.session("session-1", "after")
      }
      return value
    }
    expect((await f.search("after")).results).toHaveLength(1)
    expect((await f.search("before")).results).toEqual([])
  })
})

test("purges derived text when a message or session is removed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-purge-"))
  directories.push(dir)
  const filename = path.join(dir, "search.sqlite")
  const f = fixture(filename)
  f.session("session-1")
  f.message("session-1", "msg-1", "private body")
  expect((await f.search("private body")).results).toHaveLength(1)
  f.write(["message", "session-1", "msg-1"], undefined)
  const { Database } = await import("bun:sqlite")
  const inspect = new Database(filename)
  expect(inspect.query("SELECT * FROM documents WHERE message_id = 'msg-1'").all()).toEqual([])
  f.message("session-1", "msg-2", "other private body")
  expect((await f.search("other private body")).results).toHaveLength(1)
  f.write(["session", "project", "session-1"], undefined)
  expect(inspect.query("SELECT * FROM documents WHERE session_id = 'session-1'").all()).toEqual([])
  expect(inspect.query("SELECT * FROM messages WHERE session_id = 'session-1'").all()).toEqual([])
  inspect.close()
})

test("a second connection cannot backfill stale data over another writer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-concurrent-"))
  directories.push(dir)
  const filename = path.join(dir, "search.sqlite")
  const f = fixture(filename)
  const key = ["session", "project", "session-1"]
  f.records.set(JSON.stringify(key), { id: "session-1", title: "before", time: { updated: 1 } })
  const second = new SessionSearch.Index(filename, f.source)
  indexes.push(second)
  const read = f.source.read
  let once = true
  f.source.read = async (input) => {
    const value = await read(input)
    if (once) {
      once = false
      second.begin(key)
      const canonical = { id: "session-1", title: "after", time: { updated: 1 } }
      f.records.set(JSON.stringify(key), canonical)
      second.finish(key, canonical)
    }
    return value
  }
  expect((await f.search("after")).results).toHaveLength(1)
  expect((await f.search("before")).results).toEqual([])
})

test("ordinary metadata updates only reread their dirty keys", async () => {
  const f = fixture()
  f.session("session-1")
  for (let i = 0; i < 30; i++) f.message("session-1", `msg-${i}`, `needle ${i}`)
  await f.search("needle")
  const before = f.reads()
  f.session("session-1", "renamed")
  await f.search("needle")
  expect(f.reads() - before).toBe(1)
  const metadata = f.reads()
  f.write(["message", "session-1", "msg-1"], {
    id: "msg-1",
    sessionID: "session-1",
    role: "user",
    time: { completed: 2 },
  })
  await f.search("needle")
  expect(f.reads() - metadata).toBe(1)
  const stable = f.reads()
  await f.search("needle")
  expect(f.reads()).toBe(stable)
})

test("canonical JSON wins when an earlier-begun writer actually writes last", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-write-order-"))
  directories.push(dir)
  const filename = path.join(dir, "search.sqlite")
  const f = fixture(filename)
  f.session("session-1", "initial")
  await f.search("initial")
  const second = new SessionSearch.Index(filename, f.source)
  indexes.push(second)
  const key = ["session", "project", "session-1"]
  const a = f.index.begin(key)
  const b = second.begin(key)
  const beta = { id: "session-1", title: "beta", time: { updated: 1 } }
  f.records.set(JSON.stringify(key), beta)
  second.finish(key, beta, b)
  const alpha = { ...beta, title: "alpha actually wrote last" }
  f.records.set(JSON.stringify(key), alpha)
  f.index.finish(key, alpha, a)
  expect((await f.search("alpha")).results).toHaveLength(1)
  expect((await f.search("beta")).results).toEqual([])
})

test("a query during an unfinished write cannot consume its crash-recovery marker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-live-journal-"))
  directories.push(dir)
  const filename = path.join(dir, "search.sqlite")
  const f = fixture(filename)
  f.session("session-1", "before")
  await f.search("before")
  const key = ["session", "project", "session-1"]
  f.index.begin(key)
  expect((await f.search("before")).results).toHaveLength(1)
  f.records.set(JSON.stringify(key), { id: "session-1", title: "after crash", time: { updated: 1 } })
  const { Database } = await import("bun:sqlite")
  const journal = new Database(`${filename}.journal`)
  journal.query("UPDATE writers SET pid = 2147483647").run()
  journal.close()
  expect((await f.search("after crash")).results).toHaveLength(1)
  expect((await f.search("before")).results).toEqual([])
})

test("cache ownership is checked inside journal reconciliation even with unavailable inode identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cache-epoch-"))
  directories.push(dir)
  const filename = path.join(dir, "search.sqlite")
  const fileSystem = fsSync as { statSync: typeof fsSync.statSync }
  const stat = fileSystem.statSync
  fileSystem.statSync = ((file: any, options: any) =>
    String(file) === filename
      ? { dev: 0n, ino: 0n, birthtimeNs: 0n }
      : (stat as (...values: any[]) => any)(file, options)) as typeof fsSync.statSync
  const original = SearchJournal.prototype.reconcile
  let guard: SearchJournal | undefined
  try {
    const f = fixture(filename)
    f.session("session-1")
    f.message("session-1", "msg-1", "old needle")
    await f.search("old")
    const partKey = ["part", "msg-1", "part-msg-1"]
    f.write(partKey, {
      id: "part-msg-1",
      messageID: "msg-1",
      sessionID: "session-1",
      type: "text",
      text: "new current",
    })
    guard = new SearchJournal(`${filename}.journal`)
    let replacement: SessionSearch.Index | undefined
    let once = true
    SearchJournal.prototype.reconcile = function (this: SearchJournal, ...args: any[]) {
      if (once) {
        once = false
        // This runs AFTER the reader's post-await/entry guard, before the shared
        // reconciliation lock. Only the guard inside that lock can catch it.
        guard!.replaceCache(() => {
          for (const suffix of ["", "-wal", "-shm"]) fsSync.rmSync(filename + suffix, { force: true })
        })
        replacement = new SessionSearch.Index(filename, f.source)
        indexes.push(replacement)
      }
      return (original as (...values: any[]) => any).apply(this, args)
    } as typeof SearchJournal.prototype.reconcile
    await expect(f.search("new current")).rejects.toBeInstanceOf(SessionSearch.StaleIndexError)
    expect(guard.pending()).toEqual([{ key: JSON.stringify(partKey) }])
    SearchJournal.prototype.reconcile = original
    expect((await replacement!.search({ projectID: "project", q: "new current" })).results[0].messageID).toBe("msg-1")
    expect((await replacement!.search({ projectID: "project", q: "old needle" })).results).toEqual([])
  } finally {
    SearchJournal.prototype.reconcile = original
    fileSystem.statSync = stat
    guard?.close()
  }
})

test("an index closed while awaiting canonical IO reports stale ownership and leaves provenance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-closed-owner-"))
  directories.push(dir)
  const filename = path.join(dir, "search.sqlite")
  const f = fixture(filename)
  f.session("session-1", "old")
  await f.search("old")
  f.session("session-1", "new")
  let release!: () => void
  let entered!: () => void
  const paused = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = f.source.read
  f.source.read = async (key) => {
    const value = await read(key)
    entered()
    await gate
    return value
  }
  const pending = f.search("new")
  await paused
  f.index.close()
  release()
  await expect(pending).rejects.toBeInstanceOf(SessionSearch.StaleIndexError)
  f.source.read = read
  const replacement = new SessionSearch.Index(filename, f.source)
  indexes.push(replacement)
  expect((await replacement.search({ projectID: "project", q: "new" })).results).toHaveLength(1)
})

test("fallback provenance keeps live writers and retries a temporarily failed completion", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "search-fallback-"))
  directories.push(directory)
  const filename = path.join(directory, "journal.sqlite")
  const journal = new SearchJournal(filename)
  const key = ["session", "project", "session"]
  const serialized = JSON.stringify(key)
  const first = SearchJournal.fallbackBegin(filename, key)
  const second = SearchJournal.fallbackBegin(filename, key)
  try {
    expect(journal.pending()).toEqual([{ key: serialized }])
    const revision = journal.version(serialized)
    journal.pending()
    expect(journal.version(serialized)).toBe(revision)
    journal.reconcile(serialized, revision, () => {})
    expect(journal.pending()).toHaveLength(1)
    const original = fsSync.writeFileSync
    fsSync.writeFileSync = ((...args: Parameters<typeof original>) => {
      if (String(args[0]).endsWith(`${first}.done`))
        throw Object.assign(new Error("temporary fallback completion IO error"), { code: "EIO" })
      return original(...args)
    }) as typeof original
    try {
      expect(() => SearchJournal.fallbackFinish(filename, first)).toThrow("temporary fallback")
    } finally {
      fsSync.writeFileSync = original
    }
    const deadline = Date.now() + 2000
    while (!fsSync.existsSync(path.join(`${filename}.fallback`, `${first}.done`))) {
      if (Date.now() > deadline) throw new Error("Fallback completion was not retried")
      await Bun.sleep(20)
    }
    journal.pending()
    journal.reconcile(serialized, journal.version(serialized), () => {})
    expect(journal.pending()).toHaveLength(1) // The other live writer is preserved.
    SearchJournal.fallbackFinish(filename, second)
    journal.pending()
    journal.reconcile(serialized, journal.version(serialized), () => {})
    expect(journal.pending()).toEqual([])
    expect(await fs.readdir(`${filename}.fallback`)).toEqual([])
  } finally {
    journal.close()
  }
})
