import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Preferences } from "../../src/preferences"

let root: string
let file: string
let a: Preferences.Context
let b: Preferences.Context
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "preferences-store-"))
  file = path.join(root, "global.json")
  a = { projectID: "project-a", directory: path.join(root, "a") }
  b = { projectID: "project-b", directory: path.join(root, "b") }
  await Promise.all([a, b].map((context) => fs.mkdir(context.directory)))
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

const legacy = { id: "legacy", content: "unassigned instruction", source: "user", createdAt: 1, scope: "project" }

test("isolates project reads and mutations while sharing global preferences", async () => {
  const global = await Preferences.add({ content: "everywhere" }, a, file)
  const project = await Preferences.add({ content: "only A", scope: "project" }, a, file)
  const other = await Preferences.add({ content: "only B", scope: "project" }, b, file)
  expect((await Preferences.list(a, file)).preferences.map((item) => item.id)).toEqual([project.id, global.id])
  expect((await Preferences.list(b, file)).preferences.map((item) => item.id)).toEqual([other.id, global.id])
  expect(await Preferences.update(project.id, { content: "hijacked" }, b, file)).toBeUndefined()
  expect(await Preferences.remove(project.id, b, file)).toBe(false)
  expect(await Preferences.prompt(b, file)).not.toContain("only A")
  expect(await Preferences.prompt(a, file)).toContain("everywhere")
  expect(await Preferences.prompt(a, file)).toContain("only A")
  await Preferences.update(project.id, { content: "updated A" }, a, file)
  expect(await Preferences.prompt(a, file)).toContain("updated A")
  expect(await Preferences.prompt(a, file)).not.toContain("only A")
})

test("serializes concurrent adds, updates and deletes without losing records", async () => {
  const created = await Promise.all(Array.from({ length: 40 }, (_, index) =>
    Preferences.add({ content: `entry ${index}`, scope: "project" }, index % 2 ? a : b, file)))
  expect(JSON.parse(await fs.readFile(file, "utf8")).preferences).toHaveLength(40)
  await Promise.all(created.map((entry, index) => index % 3
    ? Preferences.update(entry.id, { content: `updated ${index}` }, index % 2 ? a : b, file)
    : Preferences.remove(entry.id, index % 2 ? a : b, file)))
  const saved = JSON.parse(await fs.readFile(file, "utf8"))
  expect(saved.preferences).toHaveLength(26)
  expect(saved.preferences.every((entry: Preferences.Info) => entry.content.startsWith("updated"))).toBe(true)
})

test("preserves unowned legacy records and unrelated fields until explicitly assigned", async () => {
  await fs.writeFile(file, JSON.stringify({ version: 1, extension: { keep: true }, preferences: [{ ...legacy, note: "preserve" }] }))
  for (const context of [a, b]) {
    expect((await Preferences.list(context, file)).unresolved).toHaveLength(1)
    expect(await Preferences.prompt(context, file)).toBe("")
  }
  await Preferences.add({ content: "global" }, a, file)
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ extension: { keep: true }, preferences: [{ ...legacy, note: "preserve" }, {}] })
  await Preferences.update("legacy", { assignToCurrentProject: true }, a, file)
  expect((await Preferences.list(a, file)).unresolved).toEqual([])
  expect(await Preferences.prompt(a, file)).toContain(legacy.content)
  expect(await Preferences.prompt(b, file)).not.toContain(legacy.content)
  expect(await Preferences.update("legacy", { assignToCurrentProject: true }, b, file)).toBeUndefined()
})

test("known historical IDs remain unresolved through reads and edits until explicitly assigned", async () => {
  const historical = { ...legacy, projectID: "dir_previous", note: "preserve" }
  const original = JSON.stringify({ version: 1, keep: true, preferences: [historical] })
  await fs.writeFile(file, original)
  const context = { ...a, recoverableProjectIDs: [historical.projectID] }
  expect((await Preferences.list(context, file)).unresolved).toMatchObject([historical])
  expect(await Preferences.prompt(context, file)).toBe("")
  expect(await fs.readFile(file, "utf8")).toBe(original)
  expect((await Preferences.list(b, file)).unresolved).toEqual([])
  expect(await Preferences.update(historical.id, { content: "unrelated edit" }, b, file)).toBeUndefined()
  expect(await Preferences.remove(historical.id, b, file)).toBe(false)
  expect(await Preferences.update(historical.id, { content: "recovered draft" }, context, file)).toMatchObject({
    content: "recovered draft", projectID: historical.projectID, note: "preserve",
  })
  expect((await Preferences.list(context, file)).unresolved).toHaveLength(1)
  expect(await Preferences.prompt(context, file)).toBe("")
  await Preferences.update(historical.id, { assignToCurrentProject: true }, context, file)
  expect((await Preferences.list(context, file)).unresolved).toEqual([])
  expect(await Preferences.prompt(context, file)).toContain("recovered draft")
  expect(await Preferences.prompt(b, file)).toBe("")
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ keep: true, preferences: [{ projectID: a.projectID, note: "preserve" }] })
})

test("a recovered historical ID participates in duplicate detection before any mutation", async () => {
  const context = { ...a, recoverableProjectIDs: ["dir_previous"] }
  const original = JSON.stringify({ version: 1, preferences: [
    { ...legacy, projectID: "dir_previous" },
    { ...legacy, projectID: a.projectID, content: "current owner" },
  ] })
  await fs.writeFile(file, original)
  const state = await Preferences.list(context, file)
  expect(state.project[0].ambiguous).toBe(true)
  expect(state.unresolved[0].ambiguous).toBe(true)
  await expect(Preferences.update(legacy.id, { assignToCurrentProject: true }, context, file)).rejects.toBeInstanceOf(Preferences.AmbiguousError)
  await expect(Preferences.remove(legacy.id, context, file)).rejects.toBeInstanceOf(Preferences.AmbiguousError)
  expect(await fs.readFile(file, "utf8")).toBe(original)
})

test("edits historical alternate project file in place without migrating or replacing it", async () => {
  const local = path.join(a.directory, "nine1bot.preferences.json")
  await fs.writeFile(local, JSON.stringify({ version: 1, keep: 42, preferences: [legacy] }))
  expect((await Preferences.list(a, file)).project[0].projectID).toBe(a.projectID)
  expect((await Preferences.list(b, file)).project).toEqual([])
  await Preferences.update("legacy", { content: "local edit" }, a, file)
  expect(JSON.parse(await fs.readFile(local, "utf8"))).toMatchObject({ keep: 42, preferences: [{ content: "local edit" }] })
  expect(await fs.stat(path.join(a.directory, ".nine1bot/preferences.json")).catch(() => null)).toBeNull()
  expect(await Preferences.remove("legacy", a, file)).toBe(true)
  expect(JSON.parse(await fs.readFile(local, "utf8")).preferences).toEqual([])
})

test("malformed and future files remain untouched on writes", async () => {
  for (const text of ['{"version":1,"preferences":', '{"version":2,"preferences":[]}', '{"version":1,"preferences":"bad"}', '{"version":1,"preferences":null}']) {
    await fs.writeFile(file, text)
    await expect(Preferences.add({ content: "do not overwrite" }, a, file)).rejects.toThrow()
    expect(await fs.readFile(file, "utf8")).toBe(text)
  }
})

test("rejects empty and excessively long new content without creating a file", async () => {
  for (const content of [" \n ", "x".repeat(4097)]) {
    await expect(Preferences.add({ content }, a, file)).rejects.toThrow()
  }
  expect(await fs.stat(file).catch(() => null)).toBeNull()
})

for (const source of ["project-file", "same-file"] as const) {
  test(`duplicate legacy IDs fail closed for edit, delete and assignment (${source})`, async () => {
    const global = { ...legacy, scope: "global", content: "global original" }
    const copied = { ...legacy, content: "local copied original" }
    const local = path.join(a.directory, "nine1bot.preferences.json")
    const originalGlobal = JSON.stringify({ version: 1, keep: "global", preferences: source === "same-file" ? [global, copied] : [global] }, null, 2)
    const originalLocal = JSON.stringify({ version: 1, keep: "local", preferences: [copied] }, null, 2)
    await fs.writeFile(file, originalGlobal)
    if (source === "project-file") await fs.writeFile(local, originalLocal)
    const state = await Preferences.list(a, file)
    const all = [...state.global, ...state.project, ...state.unresolved]
    expect(all).toHaveLength(2)
    expect(all.every((preference) => preference.ambiguous)).toBe(true)
    expect(all.map((preference) => preference.origin)).toEqual(source === "same-file" ? [file, file] : [file, local])
    await expect(Preferences.update("legacy", { content: "wrong target" }, a, file)).rejects.toBeInstanceOf(Preferences.AmbiguousError)
    await expect(Preferences.remove("legacy", a, file)).rejects.toBeInstanceOf(Preferences.AmbiguousError)
    await expect(Preferences.update("legacy", { assignToCurrentProject: true }, a, file)).rejects.toBeInstanceOf(Preferences.AmbiguousError)
    expect(await fs.readFile(file, "utf8")).toBe(originalGlobal)
    if (source === "project-file") expect(await fs.readFile(local, "utf8")).toBe(originalLocal)
    expect((await Preferences.list(a, file)).global[0].content).toBe("global original")
  })
}

test("duplicate IDs in two project-local sources also fail closed without hiding either", async () => {
  const cwd = path.join(a.directory, "apps", "one")
  await fs.mkdir(cwd, { recursive: true })
  const rootLocal = path.join(a.directory, "nine1bot.preferences.json")
  const cwdLocal = path.join(cwd, "nine1bot.preferences.json")
  const original = JSON.stringify({ version: 1, preferences: [legacy] })
  await Promise.all([rootLocal, cwdLocal].map((filename) => fs.writeFile(filename, original)))
  const context = { ...a, workingDirectory: cwd }
  expect((await Preferences.list(context, file)).project).toHaveLength(2)
  await expect(Preferences.remove("legacy", context, file)).rejects.toBeInstanceOf(Preferences.AmbiguousError)
  expect(await fs.readFile(rootLocal, "utf8")).toBe(original)
  expect(await fs.readFile(cwdLocal, "utf8")).toBe(original)
})
