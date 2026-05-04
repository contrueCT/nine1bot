export class FeishuEventDeduplicator {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 2_000,
  ) {}

  accept(key: string | undefined, now = Date.now()): boolean {
    if (!key) return true
    this.prune(now)
    if (this.seen.has(key)) return false
    this.seen.set(key, now)
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest) this.seen.delete(oldest)
    }
    return true
  }

  clear() {
    this.seen.clear()
  }

  private prune(now: number) {
    for (const [key, at] of this.seen) {
      if (now - at <= this.ttlMs) continue
      this.seen.delete(key)
    }
  }
}
