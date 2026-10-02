import { randomUUID } from "crypto"
import { Instance } from "@/project/instance"
import { Session } from "."
import { SessionStatus } from "./status"

export namespace RunLease {
  export type Info = {
    id: string
    sessionID: string
    controller: AbortController
  }

  // Session IDs are global; per-directory maps allow aliases/subdirectories to
  // execute the same persisted session concurrently.
  const active = new Map<string, { lease: Info; release: () => void }>()
  const owned = Instance.state(
    () => new Set<string>(),
    async (ids) => {
      for (const id of ids) active.get(id)?.lease.controller.abort()
    },
  )

  export function reserve(sessionID: string, signal?: AbortSignal): Info {
    signal?.throwIfAborted()
    if (active.has(sessionID)) throw new Session.BusyError(sessionID)
    const lease = { id: randomUUID(), sessionID, controller: new AbortController() }
    const onAbort = () => lease.controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    const ids = owned()
    ids.add(sessionID)
    active.set(sessionID, {
      lease,
      release: Instance.bind(() => {
        signal?.removeEventListener("abort", onAbort)
        ids.delete(sessionID)
        SessionStatus.set(sessionID, { type: "idle" })
      }),
    })
    SessionStatus.set(sessionID, { type: "busy" })
    return lease
  }

  export function current(sessionID: string) {
    return active.get(sessionID)?.lease
  }

  export function cancel(sessionID: string): boolean {
    const lease = current(sessionID)
    if (!lease) return false
    lease.controller.abort()
    return true
  }

  export function release(sessionID: string, leaseID: string): boolean {
    const entry = active.get(sessionID)
    if (!entry || entry.lease.id !== leaseID) return false
    active.delete(sessionID)
    entry.release()
    return true
  }
}
