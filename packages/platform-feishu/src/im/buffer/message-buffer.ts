import type { FeishuIMIncomingMessage } from '../types'
import type { FeishuIMRouteKey } from '../route'

export type FeishuIMBufferedBatch = {
  routeKey: FeishuIMRouteKey
  routeKeyString: string
  messages: FeishuIMIncomingMessage[]
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
