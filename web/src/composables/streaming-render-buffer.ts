export type FrameDelta = {
  messageID: string
  partID: string
  field: string
  delta: string
}

export function createFrameDeltaBuffer(input: {
  apply(delta: FrameDelta): void
  schedule?: (callback: () => void) => number
  cancel?: (handle: number) => void
  maxPendingCharacters?: number
}) {
  const pending = new Map<string, FrameDelta>()
  const limit = Math.max(1, input.maxPendingCharacters ?? 64 * 1024)
  let pendingCharacters = 0
  let frame: number | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let frameIsTimeout = false
  let generation = 0

  const cancelScheduled = () => {
    generation++
    if (frame !== undefined) {
      if (input.cancel) input.cancel(frame)
      else if (frameIsTimeout) clearTimeout(frame)
      else cancelAnimationFrame(frame)
    }
    frame = undefined
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }

  const keyFor = (delta: Pick<FrameDelta, 'messageID' | 'partID' | 'field'>) =>
    `${delta.messageID}\u0000${delta.partID}\u0000${delta.field}`

  const applyPending = (partID?: string) => {
    for (const [key, delta] of pending) {
      if (partID && delta.partID !== partID) continue
      pending.delete(key)
      pendingCharacters -= delta.delta.length
      input.apply(delta)
    }
  }

  const scheduleFrame = () => {
    if (frame !== undefined) return
    const version = ++generation
    const run = () => {
      if (generation !== version) return
      cancelScheduled()
      applyPending()
    }
    if (input.schedule) {
      frame = input.schedule(run)
    } else if (typeof document !== 'undefined' && document.hidden) {
      frameIsTimeout = true
      frame = setTimeout(run, 100) as unknown as number
    } else {
      frameIsTimeout = false
      frame = requestAnimationFrame(run)
      // A tab can become hidden after requesting this frame. Keep a separate
      // deadline so that already-pending rAF cannot strand incoming deltas.
      watchdog = setTimeout(run, 100)
    }
  }

  const flush = (partID?: string) => {
    applyPending(partID)
    if (pending.size === 0) cancelScheduled()
  }

  return {
    push(delta: FrameDelta) {
      if (!delta.delta) return
      if (pendingCharacters + delta.delta.length > limit) flush()
      if (delta.delta.length >= limit) {
        input.apply(delta)
        return
      }
      const key = keyFor(delta)
      const existing = pending.get(key)
      pending.set(key, existing ? { ...delta, delta: existing.delta + delta.delta } : delta)
      pendingCharacters += delta.delta.length
      scheduleFrame()
    },
    flush,
    clear() {
      pending.clear()
      pendingCharacters = 0
      cancelScheduled()
    },
  }
}
