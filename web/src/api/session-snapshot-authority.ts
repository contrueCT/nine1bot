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
  // Observation is not authority. A lost/unmarked provenance must never become
  // newer than an acknowledged mutation simply because the object was cloned.
  return reads.get(toRaw(value)) ?? 0
}
export function deriveSessionSnapshot<T extends object, Changes extends object>(source: T, changes: Changes): T & Changes {
  return markSessionSnapshot({ ...source, ...changes }, sessionSnapshotOrder(source))
}
