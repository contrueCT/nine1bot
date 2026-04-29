import { GlobalBus } from "@/bus/global"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { mkdirSync, readFileSync } from "fs"
import { appendFile, rm, stat, writeFile } from "fs/promises"
import path from "path"
import { RuntimeMetricsNormalizer } from "./normalizer"
import type { RuntimeMetricEvent } from "./types"

export type StoredEvent = {
  directory?: string
  event: RuntimeMetricEvent
}

type PersistedLoadResult = {
  events: StoredEvent[]
  needsCompact: boolean
}

type RuntimeMetricsStoreDeps = {
  file: string
  now: () => number
  readTextFile: (file: string) => string
  appendTextFile: (file: string, payload: string) => Promise<void>
  writeTextFile: (file: string, payload: string) => Promise<void>
  removeFile: (file: string) => Promise<void>
  statFile: (file: string) => Promise<{ size: number }>
  onBusEvent?: (handler: (input: { directory?: string; payload: { type: string; properties?: unknown } }) => void) => void
}

type RuntimeMetricsStoreApi = {
  list(input?: { directory?: string; windowMs?: number }): StoredEvent[]
  flush(): Promise<void>
  clear(): Promise<void>
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

function loadPersistedEvents(file: string, now: () => number, readTextFile: (file: string) => string): PersistedLoadResult {
  try {
    const text = readTextFile(file)
    if (!text.trim()) return { events: [], needsCompact: false }
    const cutoff = now() - RETENTION_WINDOW_MS
    const parsed: StoredEvent[] = []
    let parseFailures = 0
    let expiredCount = 0
    let invalidCount = 0
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as StoredEvent
        if (!item?.event?.recordedAt) {
          invalidCount += 1
          continue
        }
        if (item.event.recordedAt < cutoff) {
          expiredCount += 1
          continue
        }
        parsed.push(item)
      } catch (error) {
        parseFailures += 1
        log.warn("failed to parse persisted metrics event", { error })
      }
    }

    const trimmed = parsed.length > MAX_PERSISTED_EVENTS
    return {
      events: trimmed ? parsed.slice(-MAX_PERSISTED_EVENTS) : parsed,
      needsCompact: trimmed || parseFailures > 0 || expiredCount > 0 || invalidCount > 0,
    }
  } catch {
    return { events: [], needsCompact: false }
  }
}

export function createRuntimeMetricsStore(deps: RuntimeMetricsStoreDeps): RuntimeMetricsStoreApi {
  const { file, now, readTextFile, appendTextFile, writeTextFile, removeFile, statFile, onBusEvent } = deps
  const loaded = loadPersistedEvents(file, now, readTextFile)
  const events: StoredEvent[] = loaded.events
  let pending: StoredEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let persistedCount = events.length
  let flushChain = Promise.resolve()
  let compacting = false

  const push = (entry: StoredEvent) => {
    events.push(entry)
    trimEvents(events, MAX_EVENTS, now)
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

  const needsCompaction = async () => {
    if (loaded.needsCompact) return true
    if (persistedCount > MAX_PERSISTED_EVENTS) return true
    const size = await statFile(file)
      .then((result) => result.size)
      .catch(() => 0)
    return size > MAX_FILE_BYTES
  }

  const maybeCompact = async () => {
    if (compacting) return
    if (!(await needsCompaction())) return

    compacting = true
    try {
      const snapshot = events.slice(-MAX_PERSISTED_EVENTS)
      trimEvents(snapshot, MAX_PERSISTED_EVENTS, now)
      if (!snapshot.length) {
        await removeFile(file).catch(() => undefined)
        persistedCount = 0
        return
      }
      const payload = snapshot.map((item) => JSON.stringify(item)).join("\n") + "\n"
      await writeTextFile(file, payload)
      persistedCount = snapshot.length
      loaded.needsCompact = false
    } catch (error) {
      log.warn("failed to compact metrics store", { error })
    } finally {
      compacting = false
    }
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
        await appendTextFile(file, payload)
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

  flushChain = flushChain.then(() => maybeCompact())

  onBusEvent?.((input) => {
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
    list(input) {
      const cutoff = input?.windowMs ? now() - input.windowMs : undefined
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
      loaded.needsCompact = false
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flushChain = flushChain.then(() => removeFile(file).catch(() => undefined))
      return flushChain
    },
  }
}

export const RuntimeMetricsStore = lazy(() =>
  createRuntimeMetricsStore({
    file: metricsFilePath(),
    now: () => Date.now(),
    readTextFile: (file) => readFileSync(file, "utf8"),
    appendTextFile: (file, payload) => appendFile(file, payload, "utf8"),
    writeTextFile: (file, payload) => writeFile(file, payload, "utf8"),
    removeFile: (file) => rm(file, { force: true }),
    statFile: (file) => stat(file),
    onBusEvent: (handler) => {
      GlobalBus.on("event", handler)
    },
  }),
)

function trimEvents(items: StoredEvent[], maxEvents: number, now: () => number) {
  const cutoff = now() - RETENTION_WINDOW_MS
  let removeCount = 0
  while (removeCount < items.length && items[removeCount].event.recordedAt < cutoff) {
    removeCount += 1
  }
  if (removeCount) items.splice(0, removeCount)
  if (items.length > maxEvents) {
    items.splice(0, items.length - maxEvents)
  }
}
