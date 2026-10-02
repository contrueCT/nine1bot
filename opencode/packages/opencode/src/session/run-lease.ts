import { randomUUID } from "crypto"
import { Instance } from "@/project/instance"
import { State } from "@/project/state"
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

  export type PendingAdmission = Disposable & {
    sessionID: string
    controller: AbortController
    bindOwner(directory?: string): void
  }
  const pending = new Map<string, Set<PendingAdmission>>()
  const createPendingOwner = () => new Set<PendingAdmission>()
  const disposePendingOwner = async (admissions: Set<PendingAdmission>) => {
    for (const admission of admissions) {
      admission.controller.abort()
      admission[Symbol.dispose]()
    }
  }
  // The canonical target is known before entering its asynchronous Instance scope.
  // Register in that directory's lifecycle now, including while its body is read.
  const pendingOwned = (directory: string) => State.create(() => directory, createPendingOwner, disposePendingOwner)()

  // Register synchronously before looking up request receipts. This permits Stop
  // while distinguishing new work from a side-effect-free replay; it neither
  // claims execution ownership nor replaces an unrelated running turn.
  export function trackAdmission(sessionID: string): PendingAdmission {
    const group = pending.get(sessionID) ?? new Set<PendingAdmission>()
    const owners = new Set<Set<PendingAdmission>>()
    const admission: PendingAdmission = {
      sessionID,
      bindOwner(directory = Instance.directory) {
        const owned = pendingOwned(directory)
        owned.add(admission)
        owners.add(owned)
      },
      controller: new AbortController(),
      [Symbol.dispose]() {
        for (const owner of owners) owner.delete(admission)
        group.delete(admission)
        if (group.size === 0 && pending.get(sessionID) === group) pending.delete(sessionID)
      },
    }
    group.add(admission)
    pending.set(sessionID, group)
    return admission
  }

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
    const admissions = pending.get(sessionID)
    const cancelled = Boolean(lease || admissions?.size)
    lease?.controller.abort()
    for (const admission of admissions ?? []) admission.controller.abort()
    return cancelled
  }

  export function release(sessionID: string, leaseID: string): boolean {
    const entry = active.get(sessionID)
    if (!entry || entry.lease.id !== leaseID) return false
    active.delete(sessionID)
    entry.release()
    return true
  }
}
