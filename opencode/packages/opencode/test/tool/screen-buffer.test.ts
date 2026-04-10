import { afterEach, describe, expect, test } from "bun:test"
import { ScreenBuffer } from "../../src/pty/screen-buffer"

const disposables: ScreenBuffer.Buffer[] = []

function createBuffer(config: Partial<ScreenBuffer.Config>) {
  const buffer = new ScreenBuffer.Buffer(config)
  disposables.push(buffer)
  return buffer
}

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()?.dispose()
  }
})

describe("ScreenBuffer", () => {
  test("getScreen returns the current viewport lines", async () => {
    const buffer = createBuffer({ rows: 4, cols: 40, scrollback: 100 })
    const data = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\r\n")

    await buffer.write(data)

    expect(buffer.getScreen()).toEqual(["l3", "l4", "l5", "l6"])
    expect(buffer.getInfo().scrollbackLength).toBe(2)
  })

  test("getScrollback returns lines above the current viewport", async () => {
    const buffer = createBuffer({ rows: 3, cols: 40, scrollback: 100 })
    const data = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\r\n")

    await buffer.write(data)

    expect(buffer.getScrollback()).toEqual(["l1", "l2", "l3", "l4"])
    expect(buffer.getScrollback(2)).toEqual(["l3", "l4"])
  })

  test("getFullView appends screen after requested history slice", async () => {
    const buffer = createBuffer({ rows: 3, cols: 40, scrollback: 100 })
    const data = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\r\n")

    await buffer.write(data)

    expect(buffer.getFullView(2).split("\n")).toEqual(["l3", "l4", "l5", "l6", "l7"])
  })

  test("getScreenAnsi also reads from current viewport", async () => {
    const buffer = createBuffer({ rows: 3, cols: 40, scrollback: 100 })
    const data = ["old1", "old2", "new1", "new2", "new3"].join("\r\n")

    await buffer.write(data)

    const ansi = buffer.getScreenAnsi()
    expect(ansi).toContain("new3")
    expect(ansi).not.toContain("old1")
  })
})
