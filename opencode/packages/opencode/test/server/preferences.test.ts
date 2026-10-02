import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { PreferencesRoutes } from "../../src/server/routes/preferences"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Filesystem } from "../../src/util/filesystem"
import { InstructionPrompt } from "../../src/session/instruction"
import { addPreference, getGlobalPreferencesPath, loadPreferences } from "../../../../../packages/nine1bot/src/preferences/store"
import { preferencesApi, setApiDirectory } from "../../../../../web/src/api/client"
import { Server } from "../../src/server/server"
import { createOpencodeClient as createSdkV1 } from "../../../sdk/js/src/client"
import { createOpencodeClient as createSdkV2 } from "../../../sdk/js/src/v2/client"

let root: string
let a: string
let b: string
let env: NodeJS.ProcessEnv
let restoreGitDiscovery: (() => void) | undefined
beforeEach(async () => {
  env = { ...process.env }
  root = await fs.mkdtemp(path.join(os.tmpdir(), "preferences-routes-"))
  a = path.join(root, "a")
  b = path.join(root, "b")
  await Promise.all([a, b].map((directory) => fs.mkdir(path.join(directory, ".git"), { recursive: true })))
  process.env.NINE1BOT_PREFERENCES_PATH = path.join(root, "preferences.json")
  Server.App.reset()
})
afterEach(async () => {
  restoreGitDiscovery?.()
  restoreGitDiscovery = undefined
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  // Re-evaluate startup-only route gates under the next test's environment.
  Server.App.reset()
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

function standaloneGitBoundary() {
  const up = Filesystem.up
  // Some test hosts have an ancestor .git marker (for example /tmp/.git).
  // Model a standalone filesystem only for this fixture's Git discovery; keep
  // real markers inside it so the first commit still exercises real discovery.
  const discovery = spyOn(Filesystem, "up").mockImplementation((options) => {
    if (options.targets.length !== 1 || options.targets[0] !== ".git" || !Filesystem.contains(root, options.start)) return up(options)
    const stop = options.stop && Filesystem.contains(root, options.stop) ? options.stop : root
    return up({ ...options, stop })
  })
  restoreGitDiscovery = () => discovery.mockRestore()
}

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  expect(await child.exited).toBe(0)
}

async function firstCommit(directory: string) {
  await git(directory, "init", "--quiet")
  await git(directory, "-c", "user.name=Preference Test", "-c", "user.email=preference-test@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", `First commit ${directory}`)
}

test("server app reset creates isolated routes without changing the startup preference gate", () => {
  const first = Server.App()
  expect(Server.App()).toBe(first)
  const count = first.routes.length
  expect(first.routes.some((route) => route.path.startsWith("/preferences"))).toBe(true)
  Server.App.reset()
  const second = Server.App()
  expect(second).not.toBe(first)
  expect(second.routes).toHaveLength(count)
  delete process.env.NINE1BOT_PREFERENCES_PATH
  delete process.env.NINE1BOT_PREFERENCES_MODULE
  Server.App.reset()
  expect(Server.App().routes.some((route) => route.path.startsWith("/preferences"))).toBe(false)
  process.env.NINE1BOT_PREFERENCES_PATH = path.join(root, "preferences.json")
  Server.App.reset()
  expect(Server.App().routes).toHaveLength(count)
})

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

test.each(["directory", "empty-git"])("%s preferences can be explicitly recovered after the first commit and instance restart", async (initial) => {
  if (initial === "directory") {
    await fs.rm(path.join(a, ".git"), { recursive: true })
    standaloneGitBoundary()
  } else await git(a, "init", "--quiet")
  const initialProject = (await Project.fromDirectory(a)).project
  expect({ id: initialProject.id, rootDirectory: initialProject.rootDirectory, projectType: initialProject.projectType }).toEqual({
    id: Project.directoryProjectID(a), rootDirectory: a, projectType: initial === "directory" ? "directory" : "git",
  })
  const saved = await addPreference({ content: "before first commit sentinel", scope: "project" }, a)
  const disposable = await request(a, "/", "POST", { content: "recoverable deletion", scope: "project" }).then((res) => res.json())
  const oldID = saved.projectID
  expect(oldID).toStartWith("dir_")
  expect(await prompt(a)).toContain(saved.content)
  const original = await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")
  await firstCommit(a)
  expect((await loadPreferences(a)).projectID).toBe(oldID)
  await Instance.disposeAll()

  const restarted = await request(a).then((res) => res.json())
  expect(restarted.projectID).not.toBe(oldID)
  expect(restarted.project).toEqual([])
  expect(restarted.unresolved.map((entry: { id: string }) => entry.id)).toEqual([saved.id, disposable.id])
  expect(restarted.unresolved.every((entry: { projectID: string }) => entry.projectID === oldID)).toBe(true)
  expect((await loadPreferences(a)).unresolved.map((entry) => entry.id)).toEqual([saved.id, disposable.id])
  expect(await prompt(a)).not.toContain(saved.content)
  expect((await request(a, "/prompt").then((res) => res.json())).prompt).toBe("")
  expect(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).toBe(original)
  expect((await request(b).then((res) => res.json())).unresolved).toEqual([])
  expect((await request(b, `/${saved.id}`, "PATCH", { assignToCurrentProject: true })).status).toBe(404)
  expect((await request(b, `/${disposable.id}`, "DELETE")).status).toBe(404)

  const edited = await request(a, `/${saved.id}`, "PATCH", { content: "reviewed after restart sentinel" })
  expect(edited.status).toBe(200)
  expect(await edited.json()).toMatchObject({ projectID: oldID, content: "reviewed after restart sentinel" })
  expect((await loadPreferences(a)).unresolved).toHaveLength(2)
  expect(await prompt(a)).not.toContain("reviewed after restart sentinel")
  expect((await request(a, `/${disposable.id}`, "DELETE")).status).toBe(200)
  const assigned = await request(a, `/${saved.id}`, "PATCH", { assignToCurrentProject: true })
  expect(assigned.status).toBe(200)
  expect(await assigned.json()).toMatchObject({ projectID: restarted.projectID, content: "reviewed after restart sentinel" })
  expect((await loadPreferences(a)).unresolved).toEqual([])
  expect(await prompt(a)).toContain("reviewed after restart sentinel")
  expect(await prompt(b)).not.toContain("reviewed after restart sentinel")
})

test("first-commit recovery recognizes only the exact root and cwd without activating a former subdirectory project", async () => {
  await fs.rm(path.join(a, ".git"), { recursive: true })
  standaloneGitBoundary()
  const app = path.join(a, "apps", "one")
  const sibling = path.join(a, "apps", "two")
  await Promise.all([app, sibling].map((directory) => fs.mkdir(directory, { recursive: true })))
  for (const directory of [a, app, sibling]) {
    const initialProject = (await Project.fromDirectory(directory)).project
    expect({ id: initialProject.id, rootDirectory: initialProject.rootDirectory, projectType: initialProject.projectType }).toEqual({
      id: Project.directoryProjectID(directory), rootDirectory: directory, projectType: "directory",
    })
  }
  const nested = await addPreference({ content: "formerly standalone app sentinel", scope: "project" }, app)
  const rootPreference = await addPreference({ content: "formerly standalone root sentinel", scope: "project" }, a)
  await firstCommit(a)
  await Instance.disposeAll()
  const ids = (state: { unresolved: { id: string }[] }) => state.unresolved.map((entry) => entry.id).sort()
  expect(ids(await request(app).then((res) => res.json()))).toEqual([nested.id, rootPreference.id].sort())
  expect(ids(await request(sibling).then((res) => res.json()))).toEqual([rootPreference.id])
  expect(ids(await request(a).then((res) => res.json()))).toEqual([rootPreference.id])
  expect((await loadPreferences(app)).unresolved.map((entry) => entry.id).sort()).toEqual([nested.id, rootPreference.id].sort())
  for (const directory of [a, app, sibling]) {
    expect(await prompt(directory)).not.toContain(nested.content)
    expect(await prompt(directory)).not.toContain(rootPreference.content)
  }
  expect((await request(sibling, `/${nested.id}`, "PATCH", { assignToCurrentProject: true })).status).toBe(404)
  expect((await request(a, `/${nested.id}`, "DELETE")).status).toBe(404)
  expect((await request(app, `/${nested.id}`, "PATCH", { assignToCurrentProject: true })).status).toBe(200)
  // Only explicit assignment gives the former subdirectory entry the new Git project's scope.
  expect(await prompt(sibling)).toContain(nested.content)
  expect(await prompt(sibling)).not.toContain(rootPreference.content)
  expect(await prompt(b)).not.toContain(nested.content)
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

test.each(["项目 🚀", "project%20A", "project%2Fchild", "project%25A", "project%broken", "project A"])("Web preference API preserves the exact default directory %s through every mutation", async (name) => {
  const directory = path.join(root, name)
  await fs.mkdir(path.join(directory, ".git"), { recursive: true })
  const decoded = (() => { try { return decodeURIComponent(directory) } catch { return directory } })()
  const other = decoded === directory ? b : decoded
  await fs.mkdir(path.join(other, ".git"), { recursive: true })
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
    process.env.NINE1BOT_PROJECT_DIR = directory
    process.chdir(originalCwd)
    expect((await preferencesApi.list()).directory).toBe(directory)
    delete process.env.NINE1BOT_PROJECT_DIR
    process.chdir(directory)
    const headerOnly = await Server.App().request("/preferences", {
      headers: { "x-opencode-directory": encodeURIComponent(directory) },
    })
    expect((await headerOnly.json()).directory).toBe(directory)
    if (name === "project%broken") {
      const malformedHeader = await Server.App().request("/preferences", { headers: { "x-opencode-directory": directory } })
      expect((await malformedHeader.json()).directory).toBe(directory)
    }
    // A fresh Web session selects '.', then the panel pins the resolved absolute cwd.
    setApiDirectory(".")
    const displayed = await preferencesApi.list()
    expect(displayed.directory).toBe(directory)
    expect(displayed.unresolved.map((entry) => entry.id)).toEqual(["unowned"])
    const sdkFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory))
      return Server.App().request(request)
    }) as typeof fetch
    for (const createClient of [createSdkV1, createSdkV2]) {
      const sdk = createClient({ baseUrl: "http://localhost", directory, fetch: sdkFetch })
      expect((await sdk.project.current()).data?.id).toBe(displayed.projectID)
    }
    setApiDirectory(other)
    const saved = await preferencesApi.add("unicode sentinel", "project", "user", displayed.directory)
    expect(saved.projectID).toBe(displayed.projectID)
    expect((await preferencesApi.list(other)).project).toEqual([])
    expect(await preferencesApi.update(saved.id, "edited unicode sentinel", displayed.directory)).toMatchObject({ content: "edited unicode sentinel" })
    expect(await preferencesApi.assign("unowned", displayed.directory)).toMatchObject({ projectID: displayed.projectID })
    expect(await preferencesApi.getPrompt(displayed.directory)).toContain("edited unicode sentinel")
    expect(await preferencesApi.getPrompt(other)).not.toContain("unowned sentinel")
    // A mismatched fallback header and forged body ID cannot override the query's owner.
    const response = await Server.App().request(`/preferences?${new URLSearchParams({ directory })}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(other) },
      body: JSON.stringify({ content: "query owner", scope: "project", projectID: "forged" }),
    })
    expect(response.status).toBe(200)
    const queryOwned = await response.json()
    expect(queryOwned.projectID).toBe(displayed.projectID)
    await expect(preferencesApi.update(saved.id, "wrong project", other)).rejects.toThrow()
    await expect(preferencesApi.delete(saved.id, other)).rejects.toThrow()
    expect(await preferencesApi.delete(saved.id, displayed.directory)).toBe(true)
    expect(await preferencesApi.delete("unowned", displayed.directory)).toBe(true)
    expect(await preferencesApi.delete(queryOwned.id, displayed.directory)).toBe(true)
    expect((await preferencesApi.list(displayed.directory)).preferences).toEqual([])
    expect((await preferencesApi.list(other)).project).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    setApiDirectory("")
    process.chdir(originalCwd)
  }
})
