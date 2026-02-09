import { describe, expect, test } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { assertExternalDirectory } from "../../src/tool/external-directory"
import type { PermissionNext } from "../../src/permission/next"

const createBaseCtx = (cwd: string): Omit<Tool.Context, "ask"> => ({
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  cwd,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
})

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...createBaseCtx("/tmp"),
      ask: async (req) => {
        requests.push(req)
      },
    }

    await assertExternalDirectory(ctx)
    expect(requests.length).toBe(0)
  })

  test("no-ops for paths inside ctx.cwd", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const cwd = "/tmp/project"
    const ctx: Tool.Context = {
      ...createBaseCtx(cwd),
      ask: async (req) => {
        requests.push(req)
      },
    }

    await assertExternalDirectory(ctx, path.join(cwd, "file.txt"))
    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const cwd = "/tmp/project"
    const ctx: Tool.Context = {
      ...createBaseCtx(cwd),
      ask: async (req) => {
        requests.push(req)
      },
    }

    const target = "/tmp/outside/file.txt"
    const expected = path.join(path.dirname(target), "*")

    await assertExternalDirectory(ctx, target)

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("uses target directory when kind=directory", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const cwd = "/tmp/project"
    const ctx: Tool.Context = {
      ...createBaseCtx(cwd),
      ask: async (req) => {
        requests.push(req)
      },
    }

    const target = "/tmp/outside"
    const expected = path.join(target, "*")

    await assertExternalDirectory(ctx, target, { kind: "directory" })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("skips prompting when bypass=true", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...createBaseCtx("/tmp/project"),
      ask: async (req) => {
        requests.push(req)
      },
    }

    await assertExternalDirectory(ctx, "/tmp/outside/file.txt", { bypass: true })
    expect(requests.length).toBe(0)
  })
})
