import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import type { Session } from "../session"

/** A disposable, derived index. JSON storage remains the source of truth. */
export namespace SessionSearch {
  export type Source = {
    list(prefix: string[]): Promise<string[][]>
    read(key: string[]): Promise<unknown | undefined>
  }
  export type Result = { session: Session.Info; messageID?: string; snippet: string }
  export type Response = { results: Result[]; hasMore: boolean }
  export type Query = { projectID: string; q: string; limit?: number; clientSource?: string }

  type Row = { info: string; message_id: string | null; text: string }
  type Record = { [key: string]: any }

  export function relevant(key: string[]) {
    return key.length === 3 && ["session", "message", "part"].includes(key[0])
  }

  function snippet(text: string, query: string) {
    const at = text.toLowerCase().indexOf(query)
    const start = Math.max(0, at - 70)
    const end = Math.min(text.length, Math.max(at + query.length + 70, start + 180))
    return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`
  }

  export class Index {
    private db: Database
    private backfills = new Map<string, Promise<void>>()
    private recovering?: Promise<void>
    private writers = new Map<string, string[]>()

    constructor(
      filename: string,
      private source: Source,
    ) {
      this.db = new Database(filename, { create: true })
      try {
        this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS sessions (
          project_id TEXT NOT NULL, id TEXT NOT NULL, info TEXT NOT NULL,
          parent_id TEXT, client_source TEXT, updated REAL NOT NULL,
          revert_message TEXT, revert_part TEXT,
          PRIMARY KEY (project_id, id)
        );
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
          project_id TEXT, message_id TEXT, part_id TEXT, text TEXT NOT NULL, normalized TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS document_session ON documents(session_id);
        CREATE INDEX IF NOT EXISTS document_message ON documents(message_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(normalized, content='documents', content_rowid='id', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS document_insert AFTER INSERT ON documents BEGIN
          INSERT INTO document_fts(rowid, normalized) VALUES (new.id, new.normalized);
        END;
        CREATE TRIGGER IF NOT EXISTS document_delete AFTER DELETE ON documents BEGIN
          INSERT INTO document_fts(document_fts, rowid, normalized) VALUES ('delete', old.id, old.normalized);
        END;
        CREATE TRIGGER IF NOT EXISTS document_update AFTER UPDATE ON documents BEGIN
          INSERT INTO document_fts(document_fts, rowid, normalized) VALUES ('delete', old.id, old.normalized);
          INSERT INTO document_fts(rowid, normalized) VALUES (new.id, new.normalized);
        END;
        CREATE TABLE IF NOT EXISTS ready (project_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY, pid INTEGER NOT NULL);
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

    /** Persist before changing JSON so a crash between writes is repaired on the next search. */
    begin(key: string[]) {
      if (!relevant(key)) return
      const serialized = JSON.stringify(key)
      const token = randomUUID()
      this.db.transaction(() => {
        this.dirty(serialized)
        this.db.query("INSERT INTO writers VALUES (?, ?, ?)").run(token, serialized, process.pid)
      })()
      const tokens = this.writers.get(serialized) ?? []
      tokens.push(token)
      this.writers.set(serialized, tokens)
      return token
    }

    private dirty(serialized: string) {
      this.db
        .query("INSERT INTO versions VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET revision = revision + 1")
        .run(serialized)
      this.db
        .query("INSERT INTO pending VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET pid = excluded.pid")
        .run(serialized, process.pid)
    }

    finish(key: string[], value?: unknown, token?: string) {
      if (!relevant(key)) return
      const serialized = JSON.stringify(key)
      const tokens = this.writers.get(serialized) ?? []
      const completed = token ?? tokens[0]
      const remaining = tokens.filter((value) => value !== completed)
      if (remaining.length) this.writers.set(serialized, remaining)
      else this.writers.delete(serialized)
      // Completion order is not JSON write order. Never publish the caller's snapshot.
      // Fence readers again, including when begin() belonged to a replaced cache.
      this.db.transaction(() => {
        this.dirty(serialized)
        if (completed) this.db.query("DELETE FROM writers WHERE id = ? AND key = ?").run(completed, serialized)
        // Eagerly purge deleted text, but retain the dirty marker: a later writer may
        // already have recreated the source, which canonical reconciliation restores.
        if (value === undefined) this.apply(key, undefined)
      })()
    }

    private hasLiveWriter(serialized: string) {
      const writers = this.db
        .query<{ id: string; pid: number }, [string]>("SELECT id, pid FROM writers WHERE key = ?")
        .all(serialized)
      let live = false
      for (const writer of writers) {
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

    private apply(key: string[], value?: unknown) {
      const record = value && typeof value === "object" ? (value as Record) : undefined
      const serialized = JSON.stringify(key)
      if (key[0] === "session") {
        // The physical project namespace is authoritative, including imported historical records.
        if (!record || record.id !== key[2] || typeof record.title !== "string") {
          this.db.query("DELETE FROM sessions WHERE project_id = ? AND id = ?").run(key[1], key[2])
          this.db.query("DELETE FROM documents WHERE key = ?").run(serialized)
          if (!this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(key[2])) {
            this.db.query("DELETE FROM documents WHERE session_id = ?").run(key[2])
            this.db.query("DELETE FROM messages WHERE session_id = ?").run(key[2])
          }
          return
        }
        this.db
          .query(
            `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, id) DO UPDATE SET info=excluded.info, parent_id=excluded.parent_id,
          client_source=excluded.client_source, updated=excluded.updated,
          revert_message=excluded.revert_message, revert_part=excluded.revert_part`,
          )
          .run(
            key[1],
            key[2],
            JSON.stringify({ ...record, projectID: key[1] }),
            record.parentID ?? null,
            record.client?.source ?? null,
            record.time?.updated ?? 0,
            record.revert?.messageID ?? null,
            record.revert?.partID ?? null,
          )
        this.document(serialized, key[2], key[1], null, null, record.title)
        return
      }
      if (key[0] === "message") {
        if (
          !record ||
          record.id !== key[2] ||
          record.sessionID !== key[1] ||
          !["user", "assistant"].includes(record.role) ||
          record.summary === true
        ) {
          this.db.query("DELETE FROM messages WHERE id = ? AND session_id = ?").run(key[2], key[1])
          this.db.query("DELETE FROM documents WHERE message_id = ? AND session_id = ?").run(key[2], key[1])
          return
        }
        this.db
          .query(
            `INSERT INTO messages VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, role=excluded.role`,
          )
          .run(key[2], key[1], record.role)
        return
      }
      if (
        !record ||
        record.id !== key[2] ||
        record.messageID !== key[1] ||
        typeof record.sessionID !== "string" ||
        record.type !== "text" ||
        record.synthetic ||
        record.ignored ||
        record.metadata?.hidden === true ||
        typeof record.text !== "string"
      ) {
        this.db.query("DELETE FROM documents WHERE key = ?").run(serialized)
        return
      }
      if (
        !this.db.query("SELECT 1 FROM messages WHERE id = ? AND session_id = ?").get(key[1], record.sessionID) ||
        !this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(record.sessionID)
      ) {
        this.db.query("DELETE FROM documents WHERE key = ?").run(serialized)
        return
      }
      this.document(serialized, record.sessionID, null, key[1], key[2], record.text)
    }

    private document(
      key: string,
      sessionID: string,
      projectID: string | null,
      messageID: string | null,
      partID: string | null,
      text: string,
    ) {
      this.db
        .query(
          `INSERT INTO documents(key, session_id, project_id, message_id, part_id, text, normalized)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET session_id=excluded.session_id,
        project_id=excluded.project_id, message_id=excluded.message_id, part_id=excluded.part_id,
        text=excluded.text, normalized=excluded.normalized`,
        )
        .run(key, sessionID, projectID, messageID, partID, text, text.toLowerCase())
    }

    private version(key: string) {
      return (
        this.db.query<{ revision: number }, [string]>("SELECT revision FROM versions WHERE key = ?").get(key)
          ?.revision ?? 0
      )
    }

    private async load(key: string[], refreshChildren = false) {
      const serialized = JSON.stringify(key)
      for (;;) {
        const revision = this.version(serialized)
        const value = await this.source.read(key)
        const applied = this.db.transaction(() => {
          // A begin OR finish after our read invalidates this snapshot. Retrying
          // canonical JSON also handles late finish payloads and cache replacement.
          if (this.version(serialized) !== revision) return undefined
          const existed =
            key[0] === "session"
              ? this.db.query("SELECT 1 FROM sessions WHERE project_id = ? AND id = ?").get(key[1], key[2])
              : key[0] === "message"
                ? this.db.query("SELECT 1 FROM messages WHERE session_id = ? AND id = ?").get(key[1], key[2])
                : true
          this.apply(key, value)
          // Keep the journal while any writer is still active. A reader may run
          // between that writer's begin and actual JSON write, followed by a crash.
          if (!this.hasLiveWriter(serialized)) this.db.query("DELETE FROM pending WHERE key = ?").run(serialized)
          return { children: refreshChildren || !existed }
        })()
        if (!applied) continue
        // A parent first seen during an active write must not permanently lose
        // already existing descendants merely because they were visited too early.
        if (applied.children && key[0] !== "part") {
          const prefix = key[0] === "session" ? ["message", key[2]] : ["part", key[2]]
          for (const child of await this.source.list(prefix)) {
            if (relevant(child)) await this.load(child, true)
          }
        }
        return
      }
    }

    private async recover() {
      if (this.recovering) return this.recovering
      this.recovering = (async () => {
        const pending = this.db
          .query<{ key: string }, []>(
            `SELECT key FROM pending
          ORDER BY CASE json_extract(key, '$[0]') WHEN 'session' THEN 0 WHEN 'message' THEN 1 ELSE 2 END`,
          )
          .all()
        for (const row of pending) {
          if (this.db.query("SELECT 1 FROM pending WHERE key = ?").get(row.key)) await this.load(JSON.parse(row.key))
        }
      })().finally(() => {
        this.recovering = undefined
      })
      return this.recovering
    }

    private async ensureProject(projectID: string) {
      if (this.db.query("SELECT 1 FROM ready WHERE project_id = ?").get(projectID)) return
      const existing = this.backfills.get(projectID)
      if (existing) return existing
      const backfill = (async () => {
        for (const session of await this.source.list(["session", projectID])) {
          if (!relevant(session)) continue
          await this.load(session, true)
        }
        this.db.query("INSERT OR IGNORE INTO ready VALUES (?)").run(projectID)
      })().finally(() => {
        this.backfills.delete(projectID)
      })
      this.backfills.set(projectID, backfill)
      return backfill
    }

    async search(input: Query): Promise<Response> {
      const q = input.q.trim().toLowerCase()
      if (!q) return { results: [], hasMore: false }
      const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)))
      await this.recover()
      await this.ensureProject(input.projectID)
      await this.recover()
      // Trigrams retain punctuation and CJK. One/two-character searches use a literal substring
      // scan of the local index; they never deserialize the conversation history per keystroke.
      const trigram = Array.from(q).length >= 3 && !q.includes("\0")
      const match = trigram ? "d.id IN (SELECT rowid FROM document_fts WHERE document_fts MATCH ?)" : "1"
      const bindings = [
        input.projectID,
        ...(trigram ? [`"${q.replaceAll('"', '""')}"`] : []),
        q,
        input.clientSource ?? null,
        input.clientSource ?? null,
        limit + 1,
      ]
      const rows = this.db
        .query<Row, (string | number | null)[]>(
          `
        WITH matches AS (
          SELECT s.info, s.id AS session_id, s.updated, d.message_id, d.text,
            row_number() OVER (PARTITION BY s.id ORDER BY d.message_id IS NOT NULL, d.message_id DESC, d.part_id) AS rank
          FROM documents d JOIN sessions s ON s.id = d.session_id
          LEFT JOIN messages m ON m.id = d.message_id AND m.session_id = s.id
          WHERE s.project_id = ? AND s.parent_id IS NULL
            AND (s.client_source IS NULL OR s.client_source NOT IN ('webhook', 'schedule'))
            AND (d.project_id IS NULL OR d.project_id = s.project_id)
            AND (d.message_id IS NULL OR m.role IN ('user', 'assistant'))
            AND (d.message_id IS NULL OR s.revert_message IS NULL OR d.message_id < s.revert_message
              OR (d.message_id = s.revert_message AND s.revert_part IS NOT NULL AND d.part_id < s.revert_part))
            AND ${match} AND instr(d.normalized, ?) > 0
            AND (? IS NULL OR s.client_source = ?)
        ) SELECT info, message_id, text FROM matches WHERE rank = 1 ORDER BY updated DESC, session_id LIMIT ?
      `,
        )
        .all(...bindings)
      return {
        results: rows.slice(0, limit).map((row) => ({
          session: JSON.parse(row.info),
          ...(row.message_id ? { messageID: row.message_id } : {}),
          snippet: snippet(row.text, q),
        })),
        hasMore: rows.length > limit,
      }
    }
  }
}
