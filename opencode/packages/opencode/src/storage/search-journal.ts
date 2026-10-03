import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"

/** Durable mutation provenance. Never discard this file when rebuilding derived search data. */
export class SearchJournal {
  private db: Database
  private writers = new Map<string, string[]>()

  constructor(filename: string) {
    this.db = new Database(filename, { create: true })
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS writers (id TEXT PRIMARY KEY, key TEXT NOT NULL, pid INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS writer_key ON writers(key);
        CREATE TABLE IF NOT EXISTS versions (key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  private dirty(key: string) {
    this.db.query("INSERT INTO versions VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET revision = revision + 1").run(key)
    this.db.query("INSERT OR IGNORE INTO pending VALUES (?)").run(key)
  }

  begin(key: string[]) {
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
    const tokens = this.writers.get(serialized) ?? []
    const completed = token ?? tokens[0]
    this.db
      .transaction(() => {
        // Fence canonical readers again: completion order is not source-write order.
        this.dirty(serialized)
        if (completed) this.db.query("DELETE FROM writers WHERE id = ? AND key = ?").run(completed, serialized)
      })
      .immediate()
    const remaining = tokens.filter((value) => value !== completed)
    if (remaining.length) this.writers.set(serialized, remaining)
    else this.writers.delete(serialized)
  }

  version(key: string) {
    return (
      this.db.query<{ revision: number }, [string]>("SELECT revision FROM versions WHERE key = ?").get(key)?.revision ??
      0
    )
  }

  pending() {
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

  reconcile<T>(key: string, revision: number, apply: () => T): T | undefined {
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
