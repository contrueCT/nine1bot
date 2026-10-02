import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ToolRegistry } from "../../src/tool/registry"
import { RememberTool } from "../../src/tool/remember"
import { Instance } from "../../src/project/instance"
import { Preferences } from "../../src/preferences"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"

let root: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  env = { ...process.env }
  root = await fs.mkdtemp(path.join(os.tmpdir(), "remember-tool-"))
  await fs.mkdir(path.join(root, ".git"))
  process.env.NINE1BOT_PREFERENCES_PATH = path.join(root, "preferences.json")
  process.env.OPENCODE_SERVER_PASSWORD = "test-only-not-a-real-credential"
  process.env.NINE1BOT_PORT = "12345"
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  await fs.rm(root, { recursive: true, force: true })
})

test("remember is permission-gated, scoped to execution directory and independent of HTTP/auth/port", async () => {
  await Instance.provide({ directory: root, fn: async () => {
    const asks: any[] = []
    const tool = await RememberTool.init()
    const result = await tool.execute({ content: "use strict TypeScript", scope: "project" }, {
      sessionID: "ses_test", messageID: "msg_test", cwd: root, agent: "build", abort: new AbortController().signal,
      messages: [], metadata() {}, async ask(input) { asks.push(input) },
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ permission: "remember", patterns: [`project:${Instance.project.id}`] })
    const record = JSON.parse(result.output)
    expect(record).toMatchObject({ scope: "project", projectID: Instance.project.id, source: "ai" })
    expect(result.output).not.toContain(process.env.OPENCODE_SERVER_PASSWORD!)
    expect((await Preferences.list({ projectID: Instance.project.id, directory: root })).project).toHaveLength(1)
  } })
})

test("denied permission does not persist and scope is mandatory", async () => {
  await Instance.provide({ directory: root, fn: async () => {
    const tool = await RememberTool.init()
    const ctx = { sessionID: "ses_test", messageID: "msg_test", cwd: root, agent: "build", abort: new AbortController().signal,
      messages: [], metadata() {}, async ask() { throw new Error("denied") } }
    await expect(tool.execute({ content: "no", scope: "global" }, ctx)).rejects.toThrow("denied")
    await expect(tool.execute({ content: "no" } as any, ctx)).rejects.toThrow()
    expect(await fs.stat(process.env.NINE1BOT_PREFERENCES_PATH!).catch(() => null)).toBeNull()
    expect(PermissionNext.evaluate("remember", "global", (await Agent.get("build"))!.permission).action).toBe("ask")
    expect(PermissionNext.evaluate("remember", "global", (await Agent.get("plan"))!.permission).action).toBe("deny")
  } })
})


test("tool catalog enables remember only in Nine1Bot and uses executor context over ambient project", async () => {
  const other = path.join(root, "other")
  await fs.mkdir(path.join(other, ".git"), { recursive: true })
  await Instance.provide({ directory: root, fn: async () => {
    expect(await ToolRegistry.ids()).toContain("remember")
    const tool = await RememberTool.init()
    const result = await tool.execute({ content: "executor project only", scope: "project" }, {
      sessionID: "ses_test", messageID: "msg_test", cwd: other, agent: "build", abort: new AbortController().signal,
      messages: [], metadata() {}, async ask() {},
    })
    expect(JSON.parse(result.output).projectID).not.toBe(Instance.project.id)
    expect((await Preferences.list({ projectID: Instance.project.id, directory: root })).project).toEqual([])
    delete process.env.NINE1BOT_PREFERENCES_PATH
    delete process.env.NINE1BOT_PREFERENCES_MODULE
    expect(await ToolRegistry.ids()).not.toContain("remember")
  } })
})
