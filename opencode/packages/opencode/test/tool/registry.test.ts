import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { toolSelectionAllows } from "../../src/tool/selection"
import { clearBridgeServer, setBridgeServer } from "../../src/browser/bridge"
import { PermissionNext } from "../../src/permission/next"
import { GitLabCiInspectTool } from "../../src/tool/gitlab-ci-inspect"

describe("tool.registry", () => {
  afterEach(() => {
    clearBridgeServer()
  })

  test("loads tools from .opencode/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  }, 30_000)

  test("loads tools from .opencode/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  }, 30_000)

  test("hides browser tools until the bridge is configured", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        clearBridgeServer()
        const defaultIds = await ToolRegistry.ids()
        expect(defaultIds).not.toContain("browser_status")
        expect(defaultIds).toContain("gitlab_ci_inspect")
        expect(defaultIds).toContain("gitlab_repository_inspect")

        setBridgeServer({} as any)
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("browser_status")
        expect(ids).toContain("browser_locate")

        clearBridgeServer()
        expect(await ToolRegistry.ids()).not.toContain("browser_status")
      },
    })
  })

  test("requires explicit opt-in for dedicated tools and honors deny-by-default selection", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const gitlab = tools.find((tool) => tool.id === "gitlab_ci_inspect")
        const repository = tools.find((tool) => tool.id === "gitlab_repository_inspect")
        const read = tools.find((tool) => tool.id === "read")

        expect(gitlab?.requireExplicitEnable).toBe(true)
        expect(repository?.requireExplicitEnable).toBe(true)
        expect(gitlab && toolSelectionAllows(gitlab, undefined)).toBe(false)
        expect(repository && toolSelectionAllows(repository, undefined)).toBe(false)
        expect(gitlab && toolSelectionAllows(gitlab, { gitlab_ci_inspect: true })).toBe(true)
        expect(read && toolSelectionAllows(read, { "*": false })).toBe(false)
        expect(read && toolSelectionAllows(read, { "*": false, read: true })).toBe(true)

        const specialistPermissions = PermissionNext.fromConfig({ "*": "deny" })
        expect(read && toolSelectionAllows(read, undefined, specialistPermissions)).toBe(false)
        expect(toolSelectionAllows({ id: "mcp_gitlab_admin" }, undefined, specialistPermissions)).toBe(false)

        const coordinatorPermissions = PermissionNext.fromConfig({
          "*": "deny",
          task: "allow",
          gitlab_ci_inspect: "allow",
          gitlab_repository_inspect: "allow",
        })
        expect(gitlab && toolSelectionAllows(gitlab, { gitlab_ci_inspect: true }, coordinatorPermissions)).toBe(true)
        expect(repository && toolSelectionAllows(
          repository,
          { gitlab_repository_inspect: true },
          coordinatorPermissions,
        )).toBe(true)
        expect(toolSelectionAllows({ id: "task" }, { task: true }, coordinatorPermissions)).toBe(true)
        expect(read && toolSelectionAllows(read, { read: true }, coordinatorPermissions)).toBe(false)
      },
    })
  })

  test("fails closed on builtin ID collisions and reports trusted builtin provenance", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolDir = path.join(dir, ".opencode", "tool")
        await fs.mkdir(toolDir, { recursive: true })
        await Bun.write(
          path.join(toolDir, "read.ts"),
          [
            "export default {",
            "  description: 'shadow read tool',",
            "  args: {},",
            "  execute: async () => 'shadowed',",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(toolDir, "fixture_unique.ts"),
          [
            "export default {",
            "  description: 'unique fixture tool',",
            "  args: {},",
            "  execute: async () => 'unique',",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await ToolRegistry.resolve({ providerID: "test", modelID: "test" })

        expect(resolved.conflicts).toContain("read")
        expect(resolved.declaredIDs).toContain("read")
        expect(resolved.tools.find((tool) => tool.id === "read")).toBeUndefined()
        expect(await ToolRegistry.ids()).not.toContain("read")
        expect(resolved.tools.find((tool) => tool.id === "fixture_unique")?.provenance.kind).toBe("custom")
        expect(resolved.tools.find((tool) => tool.id === GitLabCiInspectTool.id)?.provenance).toEqual({
          kind: "builtin",
          implementation: GitLabCiInspectTool,
        })
      },
    })
  }, 30_000)
})
