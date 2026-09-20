import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FOG_MAX_BYTES, type FogSeed } from './fog-report'

export type FogState = 'waiting_publication' | 'waiting_ci' | 'waiting_config' | 'ready' | 'retry' | 'blocked' | 'sent'
export type FogRecord = {
  runId: string
  idempotencyKey: string
  seed: FogSeed
  destination: string
  state: FogState
  diagnostic: string
  published: boolean
  createdAt: number
  updatedAt: number
  nextAt: number
  attempts: number
  payload?: string
  receipt?: { workItemId: string; reportId: string }
}

type Row = { data: string }
const LEASE_MS = 120_000

export class FogOutbox {
  private readonly db: Database

  constructor(path: string, private readonly limit = 1000) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true })
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS fog_reports (
      run_id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, next_at INTEGER NOT NULL,
      lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS fog_due ON fog_reports(state, next_at);`)
  }

  enqueue(seed: FogSeed, destination: string, now = Date.now()) {
    if (Buffer.byteLength(JSON.stringify(seed)) > FOG_MAX_BYTES) throw new Error('fog_seed_too_large')
    return this.db.transaction(() => {
      const existing = this.get(seed.runId)
      if (existing) {
        if (existing.seed.generation !== seed.generation || existing.seed.payloadHash !== seed.payloadHash) throw new Error('fog_seed_conflict')
        return existing
      }
      const count = this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM fog_reports').get()!.count
      if (count >= this.limit) throw new Error('fog_outbox_full')
      const record: FogRecord = {
        runId: seed.runId, idempotencyKey: randomUUID(), seed, destination,
        state: 'waiting_publication', diagnostic: '', published: false,
        createdAt: now, updatedAt: now, nextAt: now, attempts: 0,
      }
      this.db.query('INSERT INTO fog_reports(run_id,data,state,next_at) VALUES (?,?,?,?)')
        .run(record.runId, JSON.stringify(record), record.state, record.nextAt)
      return record
    }).immediate()
  }

  get(runId: string): FogRecord | undefined {
    const row = this.db.query<Row, [string]>('SELECT data FROM fog_reports WHERE run_id=?').get(runId)
    return row ? JSON.parse(row.data) as FogRecord : undefined
  }

  confirmPublication(runId: string, generation: string, payloadHash: string) {
    this.db.transaction(() => {
      const record = this.get(runId)
      if (!record) return
      if (record.seed.generation !== generation || record.seed.payloadHash !== payloadHash) throw new Error('fog_seed_conflict')
      record.published = true
      this.db.query('UPDATE fog_reports SET data=? WHERE run_id=?').run(JSON.stringify(record), runId)
    }).immediate()
  }

  list(limit = 100, offset = 0) {
    return this.db.query<Row, [number, number]>('SELECT data FROM fog_reports ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset).map((row) => JSON.parse(row.data) as FogRecord)
  }

  claim(now: number): { record: FogRecord; lease: string } | undefined {
    return this.db.transaction(() => {
      const row = this.db.query<Row, [number, number]>(`SELECT data FROM fog_reports
        WHERE state NOT IN ('sent','blocked') AND next_at<=? AND lease_until<=? ORDER BY next_at,rowid LIMIT 1`).get(now, now)
      if (!row) return undefined
      const record = JSON.parse(row.data) as FogRecord
      const lease = randomUUID()
      this.db.query('UPDATE fog_reports SET lease=?,lease_until=? WHERE run_id=?').run(lease, now + LEASE_MS, record.runId)
      return { record, lease }
    }).immediate()
  }

  save(record: FogRecord, lease: string, release = true) {
    if (Buffer.byteLength(JSON.stringify(record)) > 2 * FOG_MAX_BYTES + 16_384) throw new Error('fog_record_too_large')
    this.db.transaction(() => {
      // Publication may be confirmed while a worker awaits I/O. Never undo that confirmation.
      if (this.get(record.runId)?.published) record.published = true
      const result = this.db.query(`UPDATE fog_reports SET data=?,state=?,next_at=?,lease=?,lease_until=?
        WHERE run_id=? AND lease=? AND lease_until>?`).run(
        JSON.stringify(record), record.state, record.nextAt, release ? null : lease,
        release ? 0 : Date.now() + LEASE_MS, record.runId, lease, Date.now(),
      )
      if (!result.changes) throw new Error('fog_lease_lost')
    }).immediate()
  }

  retry(runId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const record = this.get(runId)
      if (!record || record.state === 'sent') return false
      record.state = record.published ? 'ready' : 'waiting_publication'
      record.diagnostic = ''
      record.updatedAt = now
      record.nextAt = now
      record.attempts = 0
      return this.db.query(`UPDATE fog_reports SET data=?,state=?,next_at=? WHERE run_id=? AND lease_until<=?`)
        .run(JSON.stringify(record), record.state, now, runId, now).changes > 0
    }).immediate()
  }

  close() { this.db.close() }
}
