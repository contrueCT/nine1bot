import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Instance } from "../../src/project/instance"
import { preferenceContext } from "../../src/preferences/context"
import { addPreference, loadPreferences } from "../../../../../packages/nine1bot/src/preferences/store"

let root: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  env = { ...process.env }
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "preferences-context-")))
  await fs.mkdir(path.join(root, ".git"))
  process.env.NINE1BOT_PREFERENCES_PATH = path.join(root, "preferences.json")
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  await fs.rm(root, { recursive: true, force: true })
})

test.each(["load", "add"])("compatibility %s before server initialization never seeds the instance cache", async (operation) => {
  if (operation === "load") await loadPreferences(root)
  else await addPreference({ content: "before bootstrap", scope: "project" }, root)
  expect(await Instance.existing(root)).toBeUndefined()
  let initialized = 0
  const init = async () => { initialized++ }
  for (let index = 0; index < 2; index++) {
    await Instance.provide({ directory: root, init, fn: async () => {
      expect(initialized).toBe(1)
      expect((await loadPreferences(root)).projectID).toBe(Instance.project.id)
    } })
  }
  expect(initialized).toBe(1)
})

test("compatibility load and add during init use the active context without self-waiting", async () => {
  let initialized = false
  await Instance.provide({
    directory: root,
    init: async () => {
      expect((await loadPreferences(root)).projectID).toBe(Instance.project.id)
      const preference = await addPreference({ content: "during bootstrap", scope: "project" }, root)
      expect(preference.projectID).toBe(Instance.project.id)
      initialized = true
    },
    fn: async () => {
      expect(initialized).toBe(true)
      expect((await loadPreferences(root)).project.map((preference) => preference.content)).toEqual(["during bootstrap"])
    },
  })
})

test("trusted cwd uses its own cached or discovered context while another instance is active", async () => {
  const other = path.join(root, "other")
  const fresh = path.join(root, "fresh")
  await Promise.all([other, fresh].map((directory) => fs.mkdir(path.join(directory, ".git"), { recursive: true })))
  const otherID = await Instance.provide({ directory: other, fn: () => Instance.project.id })
  for (const args of [
    ["init", "--quiet"],
    ["-c", "user.name=Preference Test", "-c", "user.email=preference-test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", `First commit ${other}`],
  ]) {
    const child = Bun.spawn(["git", ...args], { cwd: other, stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
  }
  await Instance.provide({ directory: root, fn: async () => {
    const ownID = Instance.project.id
    expect(otherID).not.toBe(ownID)
    expect(await preferenceContext(other)).toMatchObject({ projectID: otherID, directory: other, workingDirectory: other })
    const otherPreference = await addPreference({ content: "other executor", scope: "project" }, other)
    expect(otherPreference.projectID).toBe(otherID)
    expect((await loadPreferences(other)).project.map((preference) => preference.id)).toEqual([otherPreference.id])
    const discovered = await preferenceContext(fresh)
    expect(discovered.projectID).not.toBe(ownID)
    expect(discovered.projectID).not.toBe(otherID)
    expect(await Instance.existing(fresh)).toBeUndefined()
    expect(Instance.project.id).toBe(ownID)
    expect((await loadPreferences(root)).project).toEqual([])
  } })
  let initialized = false
  await Instance.provide({ directory: fresh, init: async () => { initialized = true }, fn: () => {
    expect(initialized).toBe(true)
  } })
})
