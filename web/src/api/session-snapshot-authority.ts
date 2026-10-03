import { toRaw } from 'vue'

// Monotonic client causality, not wall-clock or server updated timestamps (a
// directory PATCH uses touch:false). Store it out-of-band so it is never sent.
let sequence = 0
const reads = new WeakMap<object, number>()
export function beginSessionRead(): number { return ++sequence }
export function acknowledgeSessionDirectory(): number { return ++sequence }
export function markSessionSnapshot<T extends object>(value: T, readStarted: number): T {
  reads.set(toRaw(value), readStarted)
  return value
}
export function ensureSessionSnapshot<T extends object>(value: T, readStarted: number): T {
  if (!reads.has(toRaw(value))) markSessionSnapshot(value, readStarted)
  return value
}
export function sessionSnapshotOrder(value: object): number {
  const raw = toRaw(value)
  const known = reads.get(raw)
  if (known !== undefined) return known
  const order = ++sequence
  reads.set(raw, order)
  return order
}
export function copySessionSnapshot<T extends object>(source: object, result: T): T {
  return markSessionSnapshot(result, sessionSnapshotOrder(source))
}
