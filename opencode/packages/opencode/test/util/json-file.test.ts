import { afterEach, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { JsonFile } from "../../src/util/json-file"
import { Lock } from "../../src/util/lock"

const roots: string[] = []
afterEach(async () => {
  mock.restore()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "json-file-canonical-")))
  roots.push(root)
  return root
}
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test("atomic replacement cannot redirect an acknowledged update to a deleted-inode pathname", async () => {
  const root = await directory()
  const filename = path.join(root, "preferences.json")
  await fs.writeFile(filename, JSON.stringify({ preferences: ["seed"] }))
  const renamed = barrier(), resolving = barrier(), resume = barrier()
  const rename = fs.rename.bind(fs), realpath = fs.realpath.bind(fs), readlink = fs.readlink.bind(fs)
  let replacing = false, armed = true
  spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to)
    if (!armed || to !== filename) return
    armed = false
    replacing = true
    renamed.resolve()
    await resume.promise
    replacing = false
  })
  spyOn(fs, "realpath").mockImplementation(async (name, options) => {
    if (name === filename && replacing) {
      resolving.resolve()
      // Captured Bun/Linux result when realpath races with an atomic rename.
      return `${filename} (deleted)` as any
    }
    return realpath(name, options as any) as any
  })
  spyOn(fs, "readlink").mockImplementation(async (name, options) => {
    if (name === filename && replacing) resolving.resolve()
    return readlink(name, options as any) as any
  })
  const first = JsonFile.update(filename, (data) => { data.preferences.push("first") })
  await renamed.promise
  const second = JsonFile.update(filename, (data) => { (data.preferences ??= []).push("second") })
  try {
    await resolving.promise
  } finally {
    resume.resolve()
  }
  await Promise.all([first, second])
  expect((await JsonFile.read(filename)).data.preferences).toEqual(["seed", "first", "second"])
  expect(await fs.readdir(root)).toEqual(["preferences.json"])
})

test("literal deleted suffix and file/directory symlink aliases retain one identity", async () => {
  const root = await directory()
  const targetDirectory = path.join(root, "real")
  const aliasDirectory = path.join(root, "alias")
  await fs.mkdir(targetDirectory)
  await fs.symlink(targetDirectory, aliasDirectory, "dir")
  const target = path.join(targetDirectory, "preferences.json (deleted)")
  const link = path.join(targetDirectory, "preferences-link.json")
  await fs.writeFile(target, JSON.stringify({ preferences: [] }))
  await fs.symlink(path.basename(target), link)
  const aliases = [target, link, path.join(aliasDirectory, path.basename(link))]
  expect(await Promise.all(aliases.map(JsonFile.canonical))).toEqual(aliases.map(() => target))
  await Promise.all(aliases.map((name, index) => JsonFile.update(name, (data) => { data.preferences.push(index) })))
  expect((await JsonFile.read(target)).data.preferences.toSorted()).toEqual([0, 1, 2])
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
})

test("missing targets through symlinks use the target path and cyclic symlinks fail", async () => {
  const root = await directory()
  const target = path.join(root, "new.json"), link = path.join(root, "link.json")
  await fs.symlink(path.basename(target), link)
  expect(await JsonFile.canonical(link)).toBe(target)
  await JsonFile.update(link, (data) => { data.saved = true })
  expect((await JsonFile.read(target)).data).toEqual({ saved: true })
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  const one = path.join(root, "one"), two = path.join(root, "two")
  await fs.symlink("two", one)
  await fs.symlink("one", two)
  await expect(JsonFile.canonical(one)).rejects.toMatchObject({ code: "ELOOP" })
})


test("an update cancelled behind the canonical file lock never writes", async () => {
  const root = await directory()
  const filename = path.join(root, "preferences.json"), alias = path.join(root, "alias.json")
  const original = '{"preferences":["seed"]}'
  await fs.writeFile(filename, original)
  await fs.symlink(path.basename(filename), alias)
  const held = await Lock.write(await JsonFile.canonical(filename))
  const queued = barrier()
  const write = Lock.write
  spyOn(Lock, "write").mockImplementation((key) => {
    queued.resolve()
    return write(key)
  })
  const controller = new AbortController()
  const pending = JsonFile.update(alias, (data) => { data.preferences.push("cancelled") }, controller.signal)
    .catch((error) => error)
  await queued.promise
  controller.abort(new Error("cancelled behind canonical lock"))
  held[Symbol.dispose]()
  expect(await pending).toMatchObject({ message: "cancelled behind canonical lock" })
  expect(await fs.readFile(filename, "utf8")).toBe(original)
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
})

for (const existing of [false, true]) {
  test(`cancellation during rename restores the original file state (existing=${existing})`, async () => {
    const root = await directory()
    const filename = path.join(root, "preferences.json")
    const original = '{"preferences":["seed"]}'
    if (existing) await fs.writeFile(filename, original)
    const controller = new AbortController()
    const rename = fs.rename.bind(fs)
    spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === filename) controller.abort(new Error("cancelled during rename"))
    })
    await expect(JsonFile.update(filename, (data) => { data.preferences = ["replacement"] }, controller.signal))
      .rejects.toThrow("cancelled during rename")
    if (existing) expect(await fs.readFile(filename, "utf8")).toBe(original)
    expect(await fs.readdir(root)).toEqual(existing ? ["preferences.json"] : [])
  })
}
