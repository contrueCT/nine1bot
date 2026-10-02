import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { PreferencesRoutes } from "../../src/server/routes/preferences"
import { Instance } from "../../src/project/instance"
import { InstructionPrompt } from "../../src/session/instruction"
import { addPreference, loadPreferences } from "../../../../../packages/nine1bot/src/preferences/store"

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
  await addPreference({ content: "launcher A", scope: "project" }, a)
  const route = await request(a).then((res) => res.json())
  expect(route.project.map((entry: any) => entry.content)).toEqual(["launcher A"])
  expect((await loadPreferences(b)).project).toEqual([])
  expect((await loadPreferences(a)).project.map((entry) => entry.content)).toEqual(["launcher A"])
  await Promise.all(Array.from({ length: 15 }, (_, index) => index % 2
    ? addPreference({ content: `launcher ${index}` }, a)
    : request(a, "/", "POST", { content: `route ${index}` }).then(async (res) => {
      if (res.status !== 200) throw new Error(await res.text())
      return res.json()
    })))
  expect((await loadPreferences(a)).global).toHaveLength(15)
})

test("route rejects invalid content and preserves damaged files on mutation", async () => {
  expect((await request(a, "/", "POST", { content: "  " })).status).toBe(400)
  const damaged = '{"version":1,"preferences":'
  await fs.writeFile(process.env.NINE1BOT_PREFERENCES_PATH!, damaged)
  expect((await request(a, "/", "POST", { content: "valid" })).status).toBe(500)
  expect(await fs.readFile(process.env.NINE1BOT_PREFERENCES_PATH!, "utf8")).toBe(damaged)
  expect(await prompt(a)).not.toContain("<user-preferences>")
})
