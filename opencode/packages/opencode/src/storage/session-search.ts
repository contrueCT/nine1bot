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
      this.db.transaction(() => {
        this.db
          .query("INSERT INTO versions VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET revision = revision + 1")
          .run(serialized)
        this.db
          .query("INSERT INTO pending VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET pid = excluded.pid")
          .run(serialized, process.pid)
      })()
    }

    finish(key: string[], value?: unknown) {
      if (!relevant(key)) return
      this.db.transaction(() => {
        this.apply(key, value)
        this.db.query("DELETE FROM pending WHERE key = ?").run(JSON.stringify(key))
      })()
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

    private otherWriter(key: string) {
      const row = this.db.query<{ pid: number }, [string]>("SELECT pid FROM pending WHERE key = ?").get(key)
      if (!row || row.pid === process.pid) return false
      try {
        process.kill(row.pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH"
      }
    }

    private async load(key: string[]) {
      const serialized = JSON.stringify(key)
      if (this.otherWriter(serialized)) return
      const revision = this.version(serialized)
      const value = await this.source.read(key)
      this.db.transaction(() => {
        // Persistent revisions also protect against a different server process updating shared storage.
        if (this.version(serialized) !== revision || this.otherWriter(serialized)) return
        this.apply(key, value)
        this.db.query("DELETE FROM pending WHERE key = ?").run(serialized)
      })()
    }

    private async recover() {
      if (this.recovering) return this.recovering
      this.recovering = (async () => {
        const pending = this.db.query<{ key: string }, []>("SELECT key FROM pending").all()
        // load() leaves a live cross-process writer alone until its JSON write has finished.
        for (const row of pending) await this.load(JSON.parse(row.key))
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
          await this.load(session)
          for (const message of await this.source.list(["message", session[2]])) {
            if (!relevant(message)) continue
            await this.load(message)
            for (const part of await this.source.list(["part", message[2]])) {
              if (relevant(part)) await this.load(part)
            }
          }
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
