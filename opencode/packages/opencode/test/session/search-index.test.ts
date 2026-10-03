import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
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
  f.write(["message", "session-1", "msg-1"], undefined)
  const { Database } = await import("bun:sqlite")
  const inspect = new Database(filename)
  expect(inspect.query("SELECT * FROM documents WHERE message_id = 'msg-1'").all()).toEqual([])
  f.message("session-1", "msg-2", "other private body")
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
  f.source.read = async (input) => {
    const value = await read(input)
    second.begin(key)
    second.finish(key, { id: "session-1", title: "after", time: { updated: 1 } })
    return value
  }
  expect((await f.search("after")).results).toHaveLength(1)
  expect((await f.search("before")).results).toEqual([])
})
