import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  patchBrowserExtensionConfig,
  readBrowserExtensionConfig,
} from "../../src/server/nine1bot-browser-extension-config"

let envSnapshot: NodeJS.ProcessEnv
let tempDirectory = ""

beforeEach(async () => {
  envSnapshot = { ...process.env }
  tempDirectory = await mkdtemp(path.join(tmpdir(), "nine1bot-browser-config-"))
  process.env.NINE1BOT_CONFIG_PATH = path.join(tempDirectory, "nine1bot.config.jsonc")
  await writeFile(process.env.NINE1BOT_CONFIG_PATH, "{}\n", "utf-8")
})

afterEach(async () => {
  restoreEnv(envSnapshot)
  await rm(tempDirectory, { recursive: true, force: true })
})

test("normalizes, persists, and clears browser registered tool defaults", async () => {
  const updated = await patchBrowserExtensionConfig({
    registeredTools: ["demo_lookup", " demo_lookup ", "demo_search"],
  })
  expect(updated.registeredTools).toEqual(["demo_lookup", "demo_search"])
  expect(await readBrowserExtensionConfig()).toEqual(updated)

  const stored = JSON.parse(await readFile(process.env.NINE1BOT_CONFIG_PATH!, "utf-8"))
  expect(stored.browser.sidepanel.registeredTools).toEqual(["demo_lookup", "demo_search"])

  expect(await patchBrowserExtensionConfig({ registeredTools: null })).toEqual({})
  const cleared = JSON.parse(await readFile(process.env.NINE1BOT_CONFIG_PATH!, "utf-8"))
  expect(cleared.browser.sidepanel.registeredTools).toBeUndefined()
})

function restoreEnv(snapshot: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
