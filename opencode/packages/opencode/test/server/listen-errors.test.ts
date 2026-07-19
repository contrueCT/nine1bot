import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("server listen error formatting", () => {
  test("surfaces port-in-use hints with hostname and port", () => {
    const message = Server.formatListenError(
      { hostname: "127.0.0.1", port: 4096 },
      new Error("EADDRINUSE: address already in use 127.0.0.1:4096"),
    )

    expect(message).toContain("127.0.0.1:4096")
    expect(message).toContain("already be in use")
  })

  test("describes ephemeral port fallback requests clearly", () => {
    const message = Server.formatListenError(
      { hostname: "127.0.0.1", port: 0 },
      new Error("bind failed"),
    )

    expect(message).toContain("available port")
    expect(message).toContain("preferred 4096")
  })
})
