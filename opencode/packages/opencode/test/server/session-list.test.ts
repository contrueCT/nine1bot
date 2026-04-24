import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("session.list", () => {
  test("filters by directory", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-list-"))
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-list-other-"))
    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const app = Server.App()

          const first = await Session.create({})

          const second = await Instance.provide({
            directory: otherDir,
            fn: async () => Session.create({}),
          })

          const response = await app.request(`/session?directory=${encodeURIComponent(projectRoot)}`)
          expect(response.status).toBe(200)

          const body = (await response.json()) as unknown[]
          const ids = body
            .map((s) => (typeof s === "object" && s && "id" in s ? (s as { id: string }).id : undefined))
            .filter((x): x is string => typeof x === "string")

          expect(ids).toContain(first.id)
          expect(ids).not.toContain(second.id)
        },
      })
    } finally {
      await Instance.disposeAll()
      await fs.rm(projectRoot, { recursive: true, force: true })
      await fs.rm(otherDir, { recursive: true, force: true })
    }
  })
})
