import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ToolRegistry } from "../../src/tool/registry"
import { RememberTool } from "../../src/tool/remember"
import { Instance } from "../../src/project/instance"
import { Preferences } from "../../src/preferences"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session"
import { SessionRuntimeProfile } from "../../src/runtime/session/profile"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
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
    expect(asks[0].metadata.description).toContain("use strict TypeScript")
    expect(asks[0].metadata.description).toContain(root)
    expect(asks[0].metadata.description).toContain("Scope: current project only")
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

test("approval preview shared by CLI and TUI includes exact content, scope and readable project", async () => {
  const { rememberPermissionDescription } = await import("../../src/preferences/permission")
  const content = "first line\n" + "x".repeat(3900) + "VISIBLE_END"
  const metadata = { content, scope: "project", directory: "/projects/readable" }
  const description = rememberPermissionDescription(metadata)!
  expect(description).toContain(content)
  expect(description).toContain("Scope: current project only")
  expect(description).toContain("Project directory: /projects/readable")
  expect(rememberPermissionDescription({ ...metadata, scope: "global" })).toContain("Scope: global (all projects)")
  expect(rememberPermissionDescription({ content, scope: "project" })).toBeUndefined()
  expect(rememberPermissionDescription({})).toBeUndefined()
})

function emptyProfile(): SessionProfileSnapshot {
  return {
    id: "remember-test-profile", createdAt: Date.now(), source: "new-session", sourceTemplateIds: ["test"],
    agent: { name: "build", source: "default-user-template" },
    defaultModel: { providerID: "test", modelID: "test", source: "default-user-template" },
    context: { blocks: [] },
    resources: {
      builtinTools: {},
      mcp: { servers: [], lifecycle: "session", mergeMode: "additive-only" },
      skills: { skills: [], lifecycle: "session", mergeMode: "additive-only" },
    },
    permissions: { rules: {}, source: ["test"], mergeMode: "strict" },
    sessionPermissionGrants: [], orchestration: { mode: "single" },
  }
}

async function pendingRemember(sessionID: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = (await PermissionNext.list()).find((request) => request.sessionID === sessionID && request.permission === "remember")
    if (pending) return pending
    await Bun.sleep(5)
  }
  throw new Error("Remember did not reach the real permission queue")
}

async function realRememberContext(sessionID: string, agent = "build", controller = new AbortController()) {
  const definition = (await Agent.get(agent))!
  return {
    sessionID, messageID: "msg_remember_test", cwd: root, agent, abort: controller.signal,
    messages: [], metadata() {},
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) {
      return PermissionNext.ask({ ...input, sessionID, ruleset: definition.permission, signal: controller.signal })
    },
  }
}

for (const autonomous of [undefined, true, false]) {
  test(`real remember approval is required with autonomous=${String(autonomous)}`, async () => {
    if (autonomous !== undefined) await fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({
      autonomous: { enabled: autonomous, maxRetries: 3, askAfterRetries: true, allowDoomLoop: true },
    }))
    await Instance.provide({ directory: root, fn: async () => {
      expect((await Config.get()).autonomous?.enabled !== false).toBe(autonomous !== false)
      expect(PermissionNext.isSecurityCritical("remember")).toBe(true)
      const session = await Session.createNext({ directory: root, runtimeProfile: emptyProfile() })
      const tool = await RememberTool.init()
      const ctx = await realRememberContext(session.id)
      const rejected = tool.execute({ content: "must not persist", scope: "global" }, ctx).catch((error) => error)
      const first = await pendingRemember(session.id)
      expect(first.metadata.content).toBe("must not persist")
      expect(await fs.stat(process.env.NINE1BOT_PREFERENCES_PATH!).catch(() => null)).toBeNull()
      await PermissionNext.reply({ requestID: first.id, reply: "reject" })
      expect(await rejected).toBeInstanceOf(PermissionNext.RejectedError)
      expect(await fs.stat(process.env.NINE1BOT_PREFERENCES_PATH!).catch(() => null)).toBeNull()

      const accepted = tool.execute({ content: "approved once", scope: "project" }, ctx)
      const second = await pendingRemember(session.id)
      expect(await fs.stat(process.env.NINE1BOT_PREFERENCES_PATH!).catch(() => null)).toBeNull()
      await PermissionNext.reply({ requestID: second.id, reply: "once" })
      await accepted
      expect(JSON.parse(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).preferences).toHaveLength(1)

      const again = tool.execute({ content: "once is not a standing grant", scope: "project" }, ctx).catch((error) => error)
      const third = await pendingRemember(session.id)
      await PermissionNext.reply({ requestID: third.id, reply: "reject" })
      expect(await again).toBeInstanceOf(PermissionNext.RejectedError)
      await expect(tool.execute({ content: "plan must not write", scope: "global" }, await realRememberContext(session.id, "plan")))
        .rejects.toBeInstanceOf(PermissionNext.DeniedError)
      expect(JSON.parse(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).preferences).toHaveLength(1)
    } })
  })
}

test("real always grant persists only for its scope and resumed conversation", async () => {
  let sessionID = ""
  await Instance.provide({ directory: root, fn: async () => {
    const session = await Session.createNext({ directory: root, runtimeProfile: emptyProfile() })
    sessionID = session.id
    const tool = await RememberTool.init()
    const accepted = tool.execute({ content: "first approved preference", scope: "project" }, await realRememberContext(sessionID))
    const request = await pendingRemember(sessionID)
    await PermissionNext.reply({ requestID: request.id, reply: "always" })
    await accepted
    expect((await SessionRuntimeProfile.read(session))?.sessionPermissionGrants).toMatchObject([
      { permission: "remember", patterns: [`project:${Instance.project.id}`] },
    ])
  } })
  await Instance.disposeAll()
  await Instance.provide({ directory: root, fn: async () => {
    const tool = await RememberTool.init()
    const resumed = await Session.get(sessionID)
    expect(resumed.id).toBe(sessionID)
    await tool.execute({ content: "resumed same-scope preference", scope: "project" }, await realRememberContext(sessionID))
    expect(await PermissionNext.list()).toEqual([])
    const global = tool.execute({ content: "unapproved global scope", scope: "global" }, await realRememberContext(sessionID)).catch((error) => error)
    await PermissionNext.reply({ requestID: (await pendingRemember(sessionID)).id, reply: "reject" })
    expect(await global).toBeInstanceOf(PermissionNext.RejectedError)
    const other = await Session.createNext({ directory: root, runtimeProfile: emptyProfile() })
    const differentSession = tool.execute({ content: "unapproved other session", scope: "project" }, await realRememberContext(other.id)).catch((error) => error)
    await PermissionNext.reply({ requestID: (await pendingRemember(other.id)).id, reply: "reject" })
    expect(await differentSession).toBeInstanceOf(PermissionNext.RejectedError)
    expect(JSON.parse(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).preferences).toHaveLength(2)
  } })
})

test("terminal preview visibly escapes controls in content and directory without changing storage", async () => {
  const { rememberPermissionDescription, REMEMBER_SESSION_GRANT_NOTICE } = await import("../../src/preferences/permission")
  const { UI } = await import("../../src/cli/ui")
  const content = "visible \x1b[8mhidden instruction\x1b[0m \r overwrite \b \u009b31m red \u202eorder\u202c\nnext line\ttab"
  const directory = "/projects/name\x1b[2J\r\u009d8;;https://example.invalid\u0007"
  const description = rememberPermissionDescription({ content, directory, scope: "project" })!
  expect(description).toContain("\\u001b[8mhidden instruction\\u001b[0m")
  expect(description).toContain("\\u000d overwrite \\u0008")
  expect(description).toContain("\\u009b31m red \\u202eorder\\u202c")
  expect(description).toContain("/projects/name\\u001b[2J\\u000d\\u009d8;;https://example.invalid\\u0007")
  expect(description).toContain("\nnext line\ttab")
  expect(description).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/)
  // Exercise the same UI output sink used by run.ts, capturing the actual bytes.
  const write = Bun.stderr.write
  const chunks: string[] = []
  try {
    Bun.stderr.write = async (value) => {
      const text = String(value)
      chunks.push(text)
      return text.length
    }
    UI.println(description)
  } finally {
    Bun.stderr.write = write
  }
  expect(chunks.join("")).toBe(description + "\n")
  expect(REMEMBER_SESSION_GRANT_NOTICE).toContain("resumed, including after a restart")
  expect(REMEMBER_SESSION_GRANT_NOTICE).not.toContain("until OpenCode restarts")
  const stored = await Preferences.add({ content, scope: "project" }, { projectID: "test", directory: root })
  expect(stored.content).toBe(content)
  expect(JSON.parse(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).preferences[0].content).toBe(content)
})
