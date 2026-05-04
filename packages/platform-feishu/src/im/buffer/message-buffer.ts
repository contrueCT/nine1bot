import type { FeishuIMIncomingMessage } from '../types'
import type { FeishuIMRouteKey } from '../route'

export type FeishuIMBufferedBatch = {
  routeKey: FeishuIMRouteKey
  routeKeyString: string
  messages: FeishuIMIncomingMessage[]
}

export type FeishuIMBufferSnapshotEntry = {
  routeKey: FeishuIMRouteKey
  routeKeyString: string
  messageCount: number
  firstMessageId?: string
  lastMessageId?: string
}

type BufferEntry = FeishuIMBufferedBatch & {
  flushTimer?: ReturnType<typeof setTimeout>
  maxTimer?: ReturnType<typeof setTimeout>
}

export class FeishuIMMessageBuffer {
  private readonly entries = new Map<string, BufferEntry>()

  constructor(
    private readonly options: {
      messageBufferMs: number
      maxBufferMs: number
      onDue?: (routeKeyString: string) => void | Promise<void>
    },
  ) {}

  enqueue(input: {
    routeKey: FeishuIMRouteKey
    routeKeyString: string
    message: FeishuIMIncomingMessage
  }): { status: 'ready' | 'buffered'; messageCount: number } {
    if (this.options.messageBufferMs <= 0) {
      this.entries.set(input.routeKeyString, {
        routeKey: input.routeKey,
        routeKeyString: input.routeKeyString,
        messages: [input.message],
      })
      return { status: 'ready', messageCount: 1 }
    }

    const entry = this.entries.get(input.routeKeyString) ?? {
      routeKey: input.routeKey,
      routeKeyString: input.routeKeyString,
      messages: [],
    }
    entry.messages.push(input.message)
    this.resetFlushTimer(entry)
    if (!entry.maxTimer) {
      entry.maxTimer = setTimeout(() => {
        void this.options.onDue?.(input.routeKeyString)
      }, this.options.maxBufferMs)
      entry.maxTimer.unref?.()
    }
    this.entries.set(input.routeKeyString, entry)
    return {
      status: 'buffered',
      messageCount: entry.messages.length,
    }
  }

  drain(routeKeyString: string): FeishuIMBufferedBatch | undefined {
    const entry = this.entries.get(routeKeyString)
    if (!entry) return undefined
    this.entries.delete(routeKeyString)
    if (entry.flushTimer) clearTimeout(entry.flushTimer)
    if (entry.maxTimer) clearTimeout(entry.maxTimer)
    return {
      routeKey: entry.routeKey,
      routeKeyString: entry.routeKeyString,
      messages: [...entry.messages],
    }
  }

  discard(routeKeyString: string): FeishuIMBufferedBatch | undefined {
    return this.drain(routeKeyString)
  }

  get(routeKeyString: string): FeishuIMBufferedBatch | undefined {
    const entry = this.entries.get(routeKeyString)
    if (!entry) return undefined
    return {
      routeKey: entry.routeKey,
      routeKeyString: entry.routeKeyString,
      messages: [...entry.messages],
    }
  }

  routeCount(): number {
    return this.entries.size
  }

  messageCount(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      count += entry.messages.length
    }
    return count
  }

  snapshot(): FeishuIMBufferSnapshotEntry[] {
    return [...this.entries.values()].map((entry) => ({
      routeKey: entry.routeKey,
      routeKeyString: entry.routeKeyString,
      messageCount: entry.messages.length,
      firstMessageId: entry.messages[0]?.messageId,
      lastMessageId: entry.messages.at(-1)?.messageId,
    }))
  }

  clear() {
    for (const key of this.entries.keys()) {
      this.drain(key)
    }
  }

  private resetFlushTimer(entry: BufferEntry) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer)
    entry.flushTimer = setTimeout(() => {
      void this.options.onDue?.(entry.routeKeyString)
    }, this.options.messageBufferMs)
    entry.flushTimer.unref?.()
  }
}
