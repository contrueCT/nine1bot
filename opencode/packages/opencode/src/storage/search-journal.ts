import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

/** Durable mutation provenance. Never discard this file when rebuilding derived search data. */
export class SearchJournal {
  private db: Database
  private writers = new Map<string, string[]>()
  private completed = new Map<string, { key: string; token?: string }>()
  private retry?: ReturnType<typeof setTimeout>
  private retryDelay = 50
  private closed = false

  // A SQLite setup failure must not lose provenance for an otherwise successful
  // JSON write. Immutable fallback records survive the writer and are consumed
  // by any process once the journal is usable again.
  static fallbackBegin(filename: string, key: string[]) {
    const token = `fallback-${randomUUID()}`
    const directory = `${filename}.fallback`
    fs.mkdirSync(directory, { recursive: true })
    const target = path.join(directory, token)
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ key, pid: process.pid }))
    fs.renameSync(`${target}.tmp`, `${target}.json`)
    return token
  }

  private static fallbackCompletions = new Set<string>()
  private static fallbackRetry?: ReturnType<typeof setTimeout>
  private static fallbackDelay = 50

  static fallbackFinish(filename: string, token: string) {
    this.fallbackCompletions.add(path.join(`${filename}.fallback`, `${token}.done`))
    this.flushFallbackCompletions()
  }

  private static flushFallbackCompletions() {
    try {
      for (const target of this.fallbackCompletions) {
        fs.writeFileSync(target, "")
        this.fallbackCompletions.delete(target)
      }
    } catch (error) {
      if (!this.fallbackRetry) {
        this.fallbackRetry = setTimeout(() => {
          this.fallbackRetry = undefined
          try {
            this.flushFallbackCompletions()
          } catch {
            /* retry remains scheduled; the active fallback record stays durable */
          }
        }, this.fallbackDelay)
        this.fallbackRetry.unref?.()
        this.fallbackDelay = Math.min(5000, this.fallbackDelay * 2)
      }
      throw error
    }
    if (this.fallbackRetry) clearTimeout(this.fallbackRetry)
    this.fallbackRetry = undefined
    this.fallbackDelay = 50
  }

  constructor(private filename: string) {
    this.db = new Database(filename, { create: true })
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS writers (id TEXT PRIMARY KEY, key TEXT NOT NULL, pid INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS writer_key ON writers(key);
        CREATE TABLE IF NOT EXISTS versions (key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cache_epoch (slot INTEGER PRIMARY KEY CHECK(slot = 1), value TEXT NOT NULL);
      `)
      this.db.query("INSERT OR IGNORE INTO cache_epoch VALUES (1, ?)").run(randomUUID())
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.db.close()
  }

  private dirty(key: string) {
    this.db.query("INSERT INTO versions VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET revision = revision + 1").run(key)
    this.db.query("INSERT OR IGNORE INTO pending VALUES (?)").run(key)
  }

  begin(key: string[]) {
    this.flushCompleted()
    const serialized = JSON.stringify(key)
    const token = randomUUID()
    this.db
      .transaction(() => {
        this.dirty(serialized)
        this.db.query("INSERT INTO writers VALUES (?, ?, ?)").run(token, serialized, process.pid)
      })
      .immediate()
    const tokens = this.writers.get(serialized) ?? []
    tokens.push(token)
    this.writers.set(serialized, tokens)
    return token
  }

  finish(key: string[], token?: string) {
    const serialized = JSON.stringify(key)
    const completed = token ?? this.writers.get(serialized)?.[0]
    // Record terminal completion before attempting IO. A full/busy journal must
    // not make the token look active forever after storage recovers.
    this.completed.set(completed ?? `dirty:${serialized}`, { key: serialized, token: completed })
    this.flushCompleted()
  }

  private recoverFallback() {
    SearchJournal.flushFallbackCompletions()
    const directory = `${this.filename}.fallback`
    let files: string[]
    try {
      files = fs.readdirSync(directory).filter((name) => name.endsWith(".json"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error // Never answer from a cache whose provenance cannot be read.
    }
    if (!files.length) return
    const retired: string[] = []
    this.db
      .transaction(() => {
        for (const file of files) {
          const target = path.join(directory, file)
          let record: { key: string[]; pid: number }
          try {
            record = JSON.parse(fs.readFileSync(target, "utf8"))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
            throw error
          }
          const token = file.slice(0, -5)
          const key = JSON.stringify(record.key)
          let complete = fs.existsSync(path.join(directory, `${token}.done`))
          if (!complete) {
            try {
              process.kill(record.pid, 0)
            } catch (error) {
              complete = (error as NodeJS.ErrnoException).code === "ESRCH"
            }
          }
          if (complete) {
            this.dirty(key)
            this.db.query("DELETE FROM writers WHERE id = ? AND key = ?").run(token, key)
            retired.push(token)
          } else {
            const inserted = this.db.query("INSERT OR IGNORE INTO writers VALUES (?, ?, ?)").run(token, key, record.pid)
            if (inserted.changes) this.dirty(key)
          }
        }
      })
      .immediate()
    // Remove only after commit: a crash/rollback cannot erase the sole evidence.
    // Cleanup takes the same lock, so an importer cannot observe a begin record
    // and then lose its completion file before checking it. Replays are harmless.
    this.db
      .transaction(() => {
        for (const token of retired) {
          fs.rmSync(path.join(directory, `${token}.json`), { force: true })
          fs.rmSync(path.join(directory, `${token}.done`), { force: true })
        }
      })
      .immediate()
  }

  private flushCompleted() {
    this.recoverFallback()
    if (!this.completed.size) return
    const batch = [...this.completed]
    try {
      this.db
        .transaction(() => {
          for (const [, completion] of batch) {
            this.dirty(completion.key)
            if (completion.token)
              this.db.query("DELETE FROM writers WHERE id = ? AND key = ?").run(completion.token, completion.key)
          }
        })
        .immediate()
    } catch (error) {
      // Bounded retries also repair an otherwise idle server. Other processes
      // retain the durable marker until this exact token is retired.
      if (!this.retry && !this.closed) {
        this.retry = setTimeout(() => {
          this.retry = undefined
          try {
            this.flushCompleted()
          } catch {
            /* next bounded retry is scheduled */
          }
        }, this.retryDelay)
        this.retry.unref?.()
        this.retryDelay = Math.min(5000, this.retryDelay * 2)
      }
      throw error
    }
    for (const [id, completion] of batch) {
      this.completed.delete(id)
      const remaining = (this.writers.get(completion.key) ?? []).filter((token) => token !== completion.token)
      if (remaining.length) this.writers.set(completion.key, remaining)
      else this.writers.delete(completion.key)
    }
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.retryDelay = 50
  }

  version(key: string) {
    return (
      this.db.query<{ revision: number }, [string]>("SELECT revision FROM versions WHERE key = ?").get(key)?.revision ??
      0
    )
  }

  pending() {
    this.flushCompleted()
    return this.db
      .query<{ key: string }, []>(
        `SELECT key FROM pending
      ORDER BY CASE json_extract(key, '$[0]') WHEN 'session' THEN 0 WHEN 'message' THEN 1 ELSE 2 END`,
      )
      .all()
  }

  isPending(key: string) {
    return Boolean(this.db.query("SELECT 1 FROM pending WHERE key = ?").get(key))
  }

  private hasLiveWriter(key: string) {
    let live = false
    for (const writer of this.db
      .query<{ id: string; pid: number }, [string]>("SELECT id, pid FROM writers WHERE key = ?")
      .all(key)) {
      try {
        process.kill(writer.pid, 0)
        live = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          this.db.query("DELETE FROM writers WHERE id = ?").run(writer.id)
        else live = true
      }
    }
    return live
  }

  cacheEpoch() {
    return this.db.query<{ value: string }, []>("SELECT value FROM cache_epoch WHERE slot = 1").get()!.value
  }

  bindCache(identity: string) {
    this.db.query("UPDATE cache_epoch SET value = ? WHERE slot = 1 AND value != ?").run(identity, identity)
  }

  cacheLocked<T>(action: () => T): T {
    this.flushCompleted()
    return this.db.transaction(action).immediate()
  }

  replaceCache(action: () => void) {
    // Invalidation can itself be handling a failed completion. Do not recursively
    // retry that completion here; its bounded retry remains scheduled.
    this.db
      .transaction(() => {
        this.bindCache(randomUUID())
        action()
      })
      .immediate()
  }

  reconcile<T>(key: string, revision: number, apply: () => T): T | undefined {
    this.flushCompleted()
    // The journal lock covers the derived commit and marker cleanup across two DBs.
    // A derived failure leaves provenance intact; rebuilding never erases writers.
    return this.db
      .transaction(() => {
        if (this.version(key) !== revision) return undefined
        const result = apply()
        if (!this.hasLiveWriter(key)) this.db.query("DELETE FROM pending WHERE key = ?").run(key)
        return result
      })
      .immediate()
  }
}
