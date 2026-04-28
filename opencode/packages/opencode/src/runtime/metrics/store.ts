import { GlobalBus } from "@/bus/global"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { mkdirSync, readFileSync } from "fs"
import { appendFile, rm, stat, writeFile } from "fs/promises"
import path from "path"
import { RuntimeMetricsNormalizer } from "./normalizer"
import type { RuntimeMetricEvent } from "./types"

type StoredEvent = {
  directory?: string
  event: RuntimeMetricEvent
}

const log = Log.create({ service: "runtime.metrics.store" })
const MAX_EVENTS = 10000
const MAX_PERSISTED_EVENTS = 15000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const FLUSH_INTERVAL_MS = 2000
const FLUSH_BATCH_SIZE = 50

function metricsFilePath() {
  const dir = path.join(Global.Path.state, "metrics")
  mkdirSync(dir, { recursive: true })
  return path.join(dir, "events.jsonl")
}

function loadPersistedEvents(file: string) {
  try {
    const text = readFileSync(file, "utf8")
    if (!text.trim()) return [] as StoredEvent[]
    const cutoff = Date.now() - RETENTION_WINDOW_MS
    const parsed: StoredEvent[] = []
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as StoredEvent
        if (item?.event?.recordedAt && item.event.recordedAt >= cutoff) {
          parsed.push(item)
        }
      } catch (error) {
        log.warn("failed to parse persisted metrics event", { error })
      }
    }
    if (parsed.length > MAX_PERSISTED_EVENTS) {
      return parsed.slice(-MAX_PERSISTED_EVENTS)
    }
    return parsed
  } catch {
    return [] as StoredEvent[]
  }
}

export const RuntimeMetricsStore = lazy(() => {
  const file = metricsFilePath()
  const events: StoredEvent[] = loadPersistedEvents(file)
  let pending: StoredEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let persistedCount = events.length
  let flushChain = Promise.resolve()
  let compacting = false

  const push = (entry: StoredEvent) => {
    events.push(entry)
    trimEvents(events, MAX_EVENTS)
    queuePersist(entry)
  }

  const queuePersist = (entry: StoredEvent) => {
    pending.push(entry)
    if (pending.length >= FLUSH_BATCH_SIZE) {
      void flush()
      return
    }
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_INTERVAL_MS)
  }

  const flush = () => {
    if (!pending.length) return flushChain
    const batch = pending
    pending = []
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushChain = flushChain.then(async () => {
      try {
        const payload = batch.map((item) => JSON.stringify(item)).join("\n") + "\n"
        await appendFile(file, payload, "utf8")
        persistedCount += batch.length
        await maybeCompact()
      } catch (error) {
        pending = [...batch, ...pending].slice(-MAX_PERSISTED_EVENTS)
        log.warn("failed to persist metrics batch", {
          error,
          batchSize: batch.length,
        })
      }
    })
    return flushChain
  }

  const maybeCompact = async () => {
    if (compacting) return
    if (persistedCount <= MAX_PERSISTED_EVENTS) {
      const size = await stat(file)
        .then((result) => result.size)
        .catch(() => 0)
      if (size <= MAX_FILE_BYTES) return
    }
    compacting = true
    try {
      const snapshot = events.slice(-MAX_PERSISTED_EVENTS)
      trimEvents(snapshot, MAX_PERSISTED_EVENTS)
      if (!snapshot.length) {
        await rm(file, { force: true }).catch(() => undefined)
        persistedCount = 0
        return
      }
      const payload = snapshot.map((item) => JSON.stringify(item)).join("\n") + "\n"
      await writeFile(file, payload, "utf8")
      persistedCount = snapshot.length
    } catch (error) {
      log.warn("failed to compact metrics store", { error })
    } finally {
      compacting = false
    }
  }

  GlobalBus.on("event", (input) => {
    try {
      const normalized = RuntimeMetricsNormalizer.normalize(input.payload)
      for (const event of normalized) {
        push({
          directory: input.directory,
          event,
        })
      }
    } catch (error) {
      log.warn("failed to normalize metrics event", {
        type: input.payload?.type,
        error,
      })
    }
  })

  return {
    list(input?: { directory?: string; windowMs?: number }) {
      const cutoff = input?.windowMs ? Date.now() - input.windowMs : undefined
      return events.filter((item) => {
        if (input?.directory && item.directory !== input.directory) return false
        if (cutoff && item.event.recordedAt < cutoff) return false
        return true
      })
    },
    flush() {
      return flush()
    },
    clear() {
      events.length = 0
      pending = []
      persistedCount = 0
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flushChain = flushChain.then(() => rm(file, { force: true }).catch(() => undefined))
    },
  }
})

function trimEvents(items: StoredEvent[], maxEvents: number) {
  const cutoff = Date.now() - RETENTION_WINDOW_MS
  let removeCount = 0
  while (removeCount < items.length && items[removeCount].event.recordedAt < cutoff) {
    removeCount += 1
  }
  if (removeCount) items.splice(0, removeCount)
  if (items.length > maxEvents) {
    items.splice(0, items.length - maxEvents)
  }
}
