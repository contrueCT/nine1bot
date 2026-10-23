import type { ScreenBuffer } from "./screen-buffer"

/** Called synchronously after pending output has been assigned a sequence. */
export async function captureBufferSnapshot(source: {
  rawBuffer: string
  outputSeq: number
  outputChunks: Array<{ seq: number; data: string }>
  buffer: ScreenBuffer.Buffer
}, afterSeq?: number) {
  const latestSeq = source.outputSeq
  const firstSeq = source.outputChunks[0]?.seq ?? latestSeq + 1
  const reset = afterSeq === undefined || afterSeq < firstSeq - 1
  const snapshot = {
    buffer: reset ? source.rawBuffer : "",
    chunks: reset ? [] : source.outputChunks.filter(chunk => chunk.seq > afterSeq!),
    latestSeq, firstSeq, reset,
  }
  // Enqueue the read now, before yielding. Future PTY writes must not get into
  // this screen while the raw buffer and latestSeq still describe an older one.
  if (reset) return { ...snapshot, screen: await source.buffer.snapshot() }
  return snapshot
}
