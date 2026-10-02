/** Ownership of held inputs, independent of read-only commands on the page. */
interface InputLease {
  owner: object
  tabId: number
  status: 'pending' | 'pressed' | 'failed' | 'released'
  previous: Map<string, InputLease | undefined>
  settled: Promise<void>
  settle: () => void
}

function inputKeys(tabId: number, method: string, params: Record<string, unknown>): string[] {
  if (method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseReleased'].includes(String(params.type))) {
    return [`${tabId}:mouse:${params.button ?? 'none'}`]
  }
  if (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown', 'keyUp'].includes(String(params.type))) {
    // Retain each supplied identity: adding a code/virtual-key field must not
    // make the same logical key appear independent of an earlier key-only press.
    const aliases = [
      ['code', params.code], ['key', params.key || params.text],
      ['windows', params.windowsVirtualKeyCode], ['native', params.nativeVirtualKeyCode],
    ] as const
    return aliases.filter(([, value]) => typeof value === 'string' ? value.length > 0 : typeof value === 'number' && Number.isInteger(value) && value > 0)
      .map(([kind, value]) => `${tabId}:key:${kind}:${kind === 'key' ? String(value).toLowerCase() : value}`)
  }
  return []
}

function previousLiveLease(key: string, lease?: InputLease): InputLease | undefined {
  while (lease?.status === 'failed') lease = lease.previous.get(key)
  return lease?.status === 'released' ? undefined : lease
}

export class InputOwnership {
  private leases = new Map<string, InputLease>()

  async send<T>(owner: object, tabId: number, method: string, params: Record<string, unknown>, dispatch: () => Promise<T>): Promise<T> {
    const keys = inputKeys(tabId, method, params)
    if (!keys.length) return dispatch()
    const previous = new Map(keys.map(key => [key, this.leases.get(key)]))
    const press = params.type === 'mousePressed' || params.type === 'keyDown' || params.type === 'rawKeyDown'
    let lease: InputLease | undefined
    if (press) {
      let settle!: () => void
      const settled = new Promise<void>(resolve => { settle = resolve })
      lease = { owner, tabId, status: 'pending', previous, settled, settle }
      // Claim before dispatch: an older cleanup must not release a new press
      // while Chrome's acknowledgement for it is still pending.
      for (const key of keys) this.leases.set(key, lease)
    }
    try {
      const result = await dispatch()
      if (lease) {
        if (lease.status !== 'released') lease.status = 'pressed'
        lease.previous.clear()
      } else {
        const released = new Set(previous.values())
        for (const previousLease of released) if (previousLease) previousLease.status = 'released'
        for (const [key, current] of this.leases) if (released.has(current)) this.leases.delete(key)
      }
      return result
    } catch (error) {
      if (lease) {
        if (lease.status !== 'released') lease.status = 'failed'
        for (const key of keys) {
          if (this.leases.get(key) !== lease) continue
          const restored = previousLiveLease(key, previous.get(key))
          if (restored) this.leases.set(key, restored)
          else this.leases.delete(key)
        }
      }
      throw error
    } finally {
      lease?.settle()
    }
  }

  async assertOwned(owner: object, tabId: number, method: string, params: Record<string, unknown>): Promise<() => void> {
    const keys = inputKeys(tabId, method, params)
    if (!keys.length) throw new Error('Input cleanup cannot identify the held input')
    const deadline = Date.now() + 1000
    const pendingCompetitor = () => keys.map(key => this.leases.get(key)).find(lease => lease?.status === 'pending' && lease.owner !== owner)
    let lease = pendingCompetitor()
    while (lease) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Input cleanup is waiting for a newer press')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          lease.settled,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Input cleanup is waiting for a newer press')), remaining) }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      lease = pendingCompetitor()
    }
    const expected = this.leases.get(keys[0])
    const assertCurrent = () => {
      if (!expected || expected.owner !== owner || expected.status !== 'pressed' || keys.some(key => this.leases.get(key) !== expected)) {
        throw new Error('Input cleanup no longer owns this button or key')
      }
    }
    assertCurrent()
    return assertCurrent
  }

  forgetTab(tabId: number): void {
    for (const [key, lease] of this.leases) if (lease.tabId === tabId) this.leases.delete(key)
  }

  clear(): void { this.leases.clear() }
}
