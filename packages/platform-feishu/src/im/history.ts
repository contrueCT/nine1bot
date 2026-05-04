import type { FeishuIMIncomingMessage } from './types'

export type FeishuIMHistoryEntry = {
  message: FeishuIMIncomingMessage
  recordedAt: number
}

export class FeishuIMHistoryStore {
  private readonly entries = new Map<string, FeishuIMHistoryEntry[]>()

  constructor(
    private readonly options: {
      limit?: number
      ttlMs?: number
      now?: () => number
    } = {},
  ) {}

  record(routeKeyString: string, message: FeishuIMIncomingMessage) {
    const now = this.now()
    const existing = this.entries.get(routeKeyString) ?? []
    const next = [...existing, { message, recordedAt: now }]
      .filter((entry) => now - entry.recordedAt <= this.ttlMs())
      .slice(-this.limit())
    this.entries.set(routeKeyString, next)
  }

  list(routeKeyString: string): FeishuIMIncomingMessage[] {
    const now = this.now()
    const next = (this.entries.get(routeKeyString) ?? [])
      .filter((entry) => now - entry.recordedAt <= this.ttlMs())
      .slice(-this.limit())
    this.entries.set(routeKeyString, next)
    return next.map((entry) => entry.message)
  }

  clear(routeKeyString?: string) {
    if (routeKeyString) {
      this.entries.delete(routeKeyString)
      return
    }
    this.entries.clear()
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  private limit() {
    return this.options.limit ?? 20
  }

  private ttlMs() {
    return this.options.ttlMs ?? 10 * 60_000
  }
}
