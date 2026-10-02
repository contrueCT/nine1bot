import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { PreferencesRoutes } from "../../src/server/routes/preferences"
import { Instance } from "../../src/project/instance"
import { InstructionPrompt } from "../../src/session/instruction"
import { addPreference, getGlobalPreferencesPath, loadPreferences } from "../../../../../packages/nine1bot/src/preferences/store"
import { preferencesApi, setApiDirectory } from "../../../../../web/src/api/client"
import { Server } from "../../src/server/server"

let root: string
let a: string
let b: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  env = { ...process.env }
  root = await fs.mkdtemp(path.join(os.tmpdir(), "preferences-routes-"))
  a = path.join(root, "a")
  b = path.join(root, "b")
  await Promise.all([a, b].map((directory) => fs.mkdir(path.join(directory, ".git"), { recursive: true })))
  process.env.NINE1BOT_PREFERENCES_PATH = path.join(root, "preferences.json")
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  await fs.rm(root, { recursive: true, force: true })
})

async function request(directory: string, pathname = "/", method = "GET", body?: unknown): Promise<Response> {
  return Instance.provide({ directory, fn: () => new Hono().route("/preferences", PreferencesRoutes()).request(`/preferences${pathname === "/" ? "" : pathname}`, {
    method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) })
}
function prompt(directory: string) {
  return Instance.provide({ directory, fn: async () => (await InstructionPrompt.system()).join("\n") })
}

test("API and instruction injection use the real current project, without cross-project caching", async () => {
  const global = await request(a, "/", "POST", { content: "global sentinel" }).then((res) => res.json())
  const project = await request(a, "/", "POST", { content: "A sentinel", scope: "project", projectID: "forged" }).then((res) => res.json())
  const own = await request(a).then((res) => res.json())
  expect(project.projectID).toBe(own.projectID)
  const other = await request(b).then((res) => res.json())
  expect(other.global.map((entry: any) => entry.id)).toEqual([global.id])
  expect(other.project).toEqual([])
  expect((await request(b, `/${project.id}`, "PATCH", { content: "hijack" })).status).toBe(404)
  expect((await request(b, `/${project.id}`, "DELETE")).status).toBe(404)
  expect(await prompt(a)).toContain("A sentinel")
  expect(await prompt(b)).not.toContain("A sentinel")
  expect(await prompt(b)).toContain("global sentinel")
  await request(a, `/${project.id}`, "PATCH", { content: "fresh A sentinel" })
  expect(await prompt(a)).toContain("fresh A sentinel")
  expect((await request(b, "/prompt").then((res) => res.json())).prompt).not.toContain("A sentinel")
})

test("legacy launcher API uses the shared store and resolves A/B independently", async () => {
  const preferencePath = process.env.NINE1BOT_PREFERENCES_PATH!
  const project = await addPreference({ content: "launcher A", scope: "project" }, a)
  const route = await request(a).then((res) => res.json())
  expect(route.project.map((entry: any) => entry.content)).toEqual(["launcher A"])
  expect((await loadPreferences(b)).project).toEqual([])
  expect((await loadPreferences(a)).project.map((entry) => entry.content)).toEqual(["launcher A"])
  const acknowledged = await Promise.all(Array.from({ length: 15 }, (_, index) => index % 2
    ? addPreference({ content: `launcher ${index}` }, a)
    : request(a, "/", "POST", { content: `route ${index}` }).then(async (res) => {
      if (res.status !== 200) throw new Error(await res.text())
      return res.json()
    })))
  const persisted = JSON.parse(await fs.readFile(preferencePath, "utf8")).preferences
  const loaded = await loadPreferences(a)
  const records = (entries: { id: string; content: string; scope: string; projectID?: string }[]) => entries
    .map(({ id, content, scope, projectID }) => ({ id, content, scope, projectID }))
    .sort((left, right) => left.id.localeCompare(right.id))
  // Keep every acknowledgement and the raw file in a single failure diff, so a
  // lost write can be distinguished from wrong scope, wrong path or list filtering.
  expect({
    wrapperPath: getGlobalPreferencesPath(),
    acknowledged: acknowledged.map(({ content, scope }) => ({ content, scope })),
    persisted: records(persisted),
    loaded: records(loaded.global),
  }).toEqual({
    wrapperPath: preferencePath,
    acknowledged: Array.from({ length: 15 }, (_, index) => ({ content: `${index % 2 ? "launcher" : "route"} ${index}`, scope: "global" })),
    persisted: records([project, ...acknowledged]),
    loaded: records(acknowledged),
  })
})

test("route rejects invalid content and preserves damaged files on mutation", async () => {
  expect((await request(a, "/", "POST", { content: "  " })).status).toBe(400)
  const damaged = '{"version":1,"preferences":'
  await fs.writeFile(process.env.NINE1BOT_PREFERENCES_PATH!, damaged)
  expect((await request(a, "/", "POST", { content: "valid" })).status).toBe(500)
  expect(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).toBe(damaged)
  expect(await prompt(a)).not.toContain("<user-preferences>")
})

test("legacy monorepo cwd preferences remain visible and editable without moving their file", async () => {
  const app = path.join(a, "apps", "myapp")
  const sibling = path.join(a, "apps", "other")
  const local = path.join(app, ".nine1bot", "preferences.json")
  await fs.mkdir(path.dirname(local), { recursive: true })
  await fs.mkdir(sibling, { recursive: true })
  await fs.writeFile(local, JSON.stringify({ version: 1, keep: "unchanged", preferences: [
    { id: "legacy-app", content: "legacy nested sentinel", scope: "project", source: "user", createdAt: 1 },
  ] }))
  expect((await loadPreferences(app)).project.map((entry) => entry.id)).toEqual(["legacy-app"])
  expect((await loadPreferences(sibling)).project).toEqual([])
  expect((await request(app).then((res) => res.json())).directory).toBe(app)
  expect(await prompt(app)).toContain("legacy nested sentinel")
  expect(await prompt(sibling)).not.toContain("legacy nested sentinel")
  const { updatePreference } = await import("../../../../../packages/nine1bot/src/preferences/store")
  expect(await updatePreference("legacy-app", { content: "edited nested sentinel" }, app)).toMatchObject({ content: "edited nested sentinel" })
  expect(JSON.parse(await fs.readFile(local, "utf8"))).toMatchObject({ keep: "unchanged", preferences: [{ content: "edited nested sentinel" }] })
  expect(await prompt(app)).toContain("edited nested sentinel")
  expect((await request(app, "/legacy-app", "DELETE")).status).toBe(200)
  expect(JSON.parse(await fs.readFile(local, "utf8")).preferences).toEqual([])
})

test("HTTP copied global/project IDs return a visible conflict and preserve both sources byte-for-byte", async () => {
  const globalPath = process.env.NINE1BOT_PREFERENCES_PATH!
  const localPath = path.join(a, "nine1bot.preferences.json")
  const global = JSON.stringify({ version: 1, preferences: [{ id: "copied-id", content: "global original", scope: "global", source: "user", createdAt: 1 }] })
  const local = JSON.stringify({ version: 1, preferences: [{ id: "copied-id", content: "project original", scope: "project", source: "user", createdAt: 1 }] })
  await fs.writeFile(globalPath, global)
  await fs.writeFile(localPath, local)
  const state = await request(a).then((response) => response.json())
  expect(state.project[0]).toMatchObject({ ambiguous: true, origin: localPath })
  expect(state.global[0]).toMatchObject({ ambiguous: true, origin: globalPath })
  for (const [method, input] of [["PATCH", { content: "do not write" }], ["DELETE", undefined]] as const) {
    const response = await request(a, "/copied-id", method, input)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain("ID")
    expect(await fs.readFile(globalPath, "utf8")).toBe(global)
    expect(await fs.readFile(localPath, "utf8")).toBe(local)
  }
  const listed = await request(a).then((response) => response.json())
  expect(listed.preferences).toHaveLength(2)
})

test("Web preference API pins every mutation to a Unicode server default directory and query ownership wins", async () => {
  const directory = path.join(root, "项目 🚀")
  await fs.mkdir(path.join(directory, ".git"), { recursive: true })
  delete process.env.NINE1BOT_PROJECT_DIR
  await fs.writeFile(process.env.NINE1BOT_PREFERENCES_PATH!, JSON.stringify({ version: 1, preferences: [
    { id: "unowned", content: "unowned sentinel", scope: "project", source: "user", createdAt: 1 },
  ] }))
  const originalFetch = globalThis.fetch
  const originalCwd = process.cwd()
  // Exercise the real client, Fetch headers and production server directory middleware.
  globalThis.fetch = ((input, options) => Server.App().request(String(input), options)) as typeof fetch
  setApiDirectory("")
  process.chdir(directory)
  try {
    expect((await preferencesApi.list()).directory).toBe(directory)
    // A fresh Web session selects '.', then the panel pins the resolved absolute cwd.
    setApiDirectory(".")
    const displayed = await preferencesApi.list()
    expect(displayed.directory).toBe(directory)
    expect(displayed.unresolved.map((entry) => entry.id)).toEqual(["unowned"])
    setApiDirectory(b)
    const saved = await preferencesApi.add("unicode sentinel", "project", "user", displayed.directory)
    expect(saved.projectID).toBe(displayed.projectID)
    expect((await preferencesApi.list(b)).project).toEqual([])
    expect(await preferencesApi.update(saved.id, "edited unicode sentinel", displayed.directory)).toMatchObject({ content: "edited unicode sentinel" })
    expect(await preferencesApi.assign("unowned", displayed.directory)).toMatchObject({ projectID: displayed.projectID })
    expect(await preferencesApi.getPrompt(displayed.directory)).toContain("edited unicode sentinel")
    expect(await preferencesApi.getPrompt(b)).not.toContain("unowned sentinel")
    // A mismatched fallback header and forged body ID cannot override the query's owner.
    const response = await Server.App().request(`/preferences?${new URLSearchParams({ directory })}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(b) },
      body: JSON.stringify({ content: "query owner", scope: "project", projectID: "forged" }),
    })
    expect(response.status).toBe(200)
    const queryOwned = await response.json()
    expect(queryOwned.projectID).toBe(displayed.projectID)
    await expect(preferencesApi.update(saved.id, "wrong project", b)).rejects.toThrow()
    await expect(preferencesApi.delete(saved.id, b)).rejects.toThrow()
    expect(await preferencesApi.delete(saved.id, displayed.directory)).toBe(true)
    expect(await preferencesApi.delete("unowned", displayed.directory)).toBe(true)
    expect(await preferencesApi.delete(queryOwned.id, displayed.directory)).toBe(true)
    expect((await preferencesApi.list(displayed.directory)).preferences).toEqual([])
    expect((await preferencesApi.list(b)).project).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    setApiDirectory("")
    process.chdir(originalCwd)
  }
})
