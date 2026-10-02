import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { api } from '../src/api/client'

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = FakeEventSource.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener() {}

  close() {
    this.readyState = FakeEventSource.CLOSED
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.(new Event('open'))
  }

  static get latest() {
    const latest = FakeEventSource.instances.at(-1)
    if (!latest) throw new Error('No EventSource instance')
    return latest
  }
}

const NativeEventSource = globalThis.EventSource

describe('session runtime event subscription', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = NativeEventSource
  })

  it('resolves ready only after the first open', async () => {
    const subscription = api.subscribeSessionRuntimeEvents('ses_1', () => {})
    let settled = false
    void subscription.ready.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    FakeEventSource.latest.open()
    await subscription.ready
    expect(settled).toBe(true)
    expect(subscription.connectionGeneration()).toBe(1)
    subscription.close()
  })

  it('rejects ready when closed before opening', async () => {
    const subscription = api.subscribeSessionRuntimeEvents('ses_1', () => {})
    const outcome = subscription.ready.then(
      () => 'resolved',
      () => 'rejected',
    )

    subscription.close()
    expect(await outcome).toBe('rejected')
  })

  it('notifies reconnect only after a later successful open', async () => {
    const reconnects: number[] = []
    const opens: number[] = []
    const subscription = api.subscribeSessionRuntimeEvents('ses_1', () => {}, {
      onOpen(generation) {
        opens.push(generation)
      },
      onReconnect(generation) {
        reconnects.push(generation)
      },
    })

    FakeEventSource.latest.open()
    await subscription.ready
    expect(reconnects).toEqual([])
    expect(opens).toEqual([1])

    FakeEventSource.latest.open()
    expect(subscription.connectionGeneration()).toBe(2)
    expect(reconnects).toEqual([2])
    expect(opens).toEqual([1, 2])
    subscription.close()
  })

  it('disables message content on auxiliary event streams', () => {
    const directorySubscription = api.subscribeEvents(() => {})
    const directoryUrl = new URL(FakeEventSource.latest.url, 'http://localhost')
    expect(directoryUrl.searchParams.get('content')).toBe('false')
    directorySubscription.close()

    const globalSubscription = api.subscribeGlobalEvents(() => {})
    const globalUrl = new URL(FakeEventSource.latest.url, 'http://localhost')
    expect(globalUrl.searchParams.get('content')).toBe('false')
    globalSubscription.close()
  })
})
