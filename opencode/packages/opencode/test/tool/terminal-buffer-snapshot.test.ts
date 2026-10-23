import { afterEach, expect, test } from "bun:test"
import { ScreenBuffer } from "../../src/pty/screen-buffer"
import { captureBufferSnapshot } from "../../src/pty/buffer-snapshot"

const buffers: ScreenBuffer.Buffer[] = []
function screen() {
  const buffer = new ScreenBuffer.Buffer({ rows: 4, cols: 40, scrollback: 20 })
  buffers.push(buffer)
  return buffer
}
afterEach(() => { buffers.splice(0).forEach(buffer => buffer.dispose()) })

test("reset captures raw output, sequence and parsed screen before later writes", async () => {
  const buffer = screen()
  const first = buffer.write("HEADER\r\nSTATUS 50%")
  const source = { buffer, rawBuffer: "HEADER\r\nSTATUS 50%", outputSeq: 1, outputChunks: [{ seq: 1, data: "HEADER\r\nSTATUS 50%" }] }
  const captured = captureBufferSnapshot(source)
  // Emulate another PTY callback while the prior write is still being parsed.
  source.rawBuffer += "\rSTATUS 100%"
  source.outputSeq = 2
  source.outputChunks.push({ seq: 2, data: "\rSTATUS 100%" })
  const later = buffer.write("\rSTATUS 100%")
  const snapshot = await captured
  expect(snapshot.latestSeq).toBe(1)
  expect(snapshot.buffer).toBe("HEADER\r\nSTATUS 50%")
  expect(snapshot.screen?.screenAnsi).toContain("HEADER")
  expect(snapshot.screen?.screenAnsi).toContain("STATUS 50%")
  expect(snapshot.screen?.screenAnsi).not.toContain("100%")
  await Promise.all([first, later])
  expect(buffer.getScreenText()).toContain("STATUS 100%")
})

test("truncated raw ring is paired with the still-visible screen and cursor", async () => {
  const buffer = screen()
  const raw = "HEADER\r\n" + "\rSTATUS 50%".repeat(220000)
  void buffer.write(raw)
  const retained = raw.slice(-2 * 1024 * 1024)
  const snapshot = await captureBufferSnapshot({ buffer, rawBuffer: retained, outputSeq: 2, outputChunks: [{ seq: 2, data: retained }] }, 0)
  const replay = screen()
  await replay.write(snapshot.buffer)
  expect(replay.getScreenText()).not.toContain("HEADER")
  expect(snapshot.screen?.screenAnsi).toContain("HEADER")
  expect(snapshot.screen?.screenAnsi).toContain("STATUS 50%")
  expect(snapshot.screen?.cursor).toEqual(buffer.getCursor())
  expect(snapshot.reset).toBe(true)
})

test("incremental recovery returns ordered chunks without an unnecessary screen snapshot", async () => {
  const buffer = screen()
  const snapshot = await captureBufferSnapshot({ buffer, rawBuffer: "onetwo", outputSeq: 2, outputChunks: [{ seq: 1, data: "one" }, { seq: 2, data: "two" }] }, 1)
  expect(snapshot).toEqual({ buffer: "", chunks: [{ seq: 2, data: "two" }], latestSeq: 2, firstSeq: 1, reset: false })
})
