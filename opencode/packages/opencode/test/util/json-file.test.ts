import { afterEach, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { JsonFile } from "../../src/util/json-file"
import { Lock } from "../../src/util/lock"

// The deleted-inode behavior and component traversal are specific to Linux.
const linuxTest = process.platform === "linux" ? test : test.skip

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

linuxTest("atomic replacement cannot redirect an acknowledged update to a deleted-inode pathname", async () => {
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

linuxTest("literal deleted suffix and file/directory symlink aliases retain one identity", async () => {
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

linuxTest("missing targets through symlinks use the target path and cyclic symlinks fail", async () => {
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


linuxTest("an update cancelled behind the canonical file lock never writes", async () => {
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
  linuxTest(`cancellation during rename restores the original file state (existing=${existing})`, async () => {
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

linuxTest("symlink targets resolve directory links before parent components", async () => {
  const root = await directory()
  await fs.mkdir(path.join(root, "real", "subdir"), { recursive: true })
  await fs.symlink("real/subdir", path.join(root, "alias"), "dir")
  const target = path.join(root, "real", "preferences.json")
  const unrelated = path.join(root, "preferences.json")
  const sentinel = '{"preferences":["unrelated"]}'
  await fs.writeFile(target, '{"preferences":[]}')
  await fs.writeFile(unrelated, sentinel)
  const relative = path.join(root, "relative.json"), absolute = path.join(root, "absolute.json")
  await fs.symlink("alias/../preferences.json", relative)
  await fs.symlink(`${root}/alias/../preferences.json`, absolute)
  const aliases = [target, relative, absolute]
  expect(await Promise.all(aliases.map((name) => fs.realpath(name)))).toEqual(aliases.map(() => target))
  expect(await Promise.all(aliases.map(JsonFile.canonical))).toEqual(aliases.map(() => target))
  await Promise.all(aliases.map((name, index) => JsonFile.update(name, (data) => { data.preferences.push(index) })))
  expect((await JsonFile.read(target)).data.preferences.toSorted()).toEqual([0, 1, 2])
  expect(await fs.readFile(unrelated, "utf8")).toBe(sentinel)
  expect((await fs.lstat(relative)).isSymbolicLink()).toBe(true)
  expect((await fs.lstat(absolute)).isSymbolicLink()).toBe(true)
})

linuxTest("exactly forty file symlinks resolve, while a forty-first is rejected", async () => {
  const root = await directory()
  const target = path.join(root, "preferences.json")
  await fs.writeFile(target, '{"preferences":[]}')
  for (let index = 39; index >= 0; index--) {
    await fs.symlink(index === 39 ? "preferences.json" : `link-${index + 1}`, path.join(root, `link-${index}`))
  }
  const forty = path.join(root, "link-0")
  expect(await fs.realpath(forty)).toBe(target)
  expect(await JsonFile.canonical(forty)).toBe(target)
  await JsonFile.update(forty, (data) => { data.preferences.push("through forty links") })
  expect((await JsonFile.read(target)).data.preferences).toEqual(["through forty links"])
  const fortyOne = path.join(root, "forty-one")
  await fs.symlink("link-0", fortyOne)
  await expect(JsonFile.canonical(fortyOne)).rejects.toMatchObject({ code: "ELOOP" })
})

linuxTest("missing parents in symlink targets retain resolved directory ownership", async () => {
  const root = await directory()
  await fs.mkdir(path.join(root, "real", "subdir"), { recursive: true })
  await fs.mkdir(path.join(root, "new"))
  await fs.symlink("real/subdir", path.join(root, "alias"), "dir")
  const target = path.join(root, "real", "new", "preferences.json")
  const unrelated = path.join(root, "new", "preferences.json")
  const sentinel = '{"preferences":["unrelated"]}'
  await fs.writeFile(unrelated, sentinel)
  const link = path.join(root, "preferences-link.json")
  await fs.symlink("alias/../new/preferences.json", link)
  expect(await JsonFile.canonical(link)).toBe(target)
  await JsonFile.update(link, (data) => { data.preferences = ["owned"] })
  expect((await JsonFile.read(target)).data.preferences).toEqual(["owned"])
  expect(await fs.readFile(unrelated, "utf8")).toBe(sentinel)
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
})

for (const [target, code] of [
  ["missing/../preferences.json", "ENOENT"],
  ["blocker.json/../preferences.json", "ENOTDIR"],
  ["preferences.json/", "ENOTDIR"],
] as const) {
  linuxTest(`invalid symlink traversal ${target} fails closed with ${code}`, async () => {
    const root = await directory()
    const filename = path.join(root, "preferences.json"), link = path.join(root, "link.json")
    const sentinel = '{"preferences":["unrelated"]}'
    await fs.writeFile(filename, sentinel)
    await fs.writeFile(path.join(root, "blocker.json"), "blocker")
    await fs.symlink(target, link)
    await expect(fs.realpath(link)).rejects.toMatchObject({ code })
    await expect(fs.readFile(link, "utf8")).rejects.toMatchObject({ code })
    await expect(JsonFile.update(link, (data) => { data.preferences = ["must not write"] }))
      .rejects.toMatchObject({ code })
    expect(await fs.readFile(filename, "utf8")).toBe(sentinel)
    expect(await fs.readlink(link)).toBe(target)
    expect((await fs.readdir(root)).toSorted()).toEqual(["blocker.json", "link.json", "preferences.json"])
  })
}

linuxTest("directory and leaf symlinks share the native forty-hop limit", async () => {
  const root = await directory()
  const real = path.join(root, "real"), alias = path.join(root, "alias")
  await fs.mkdir(real)
  await fs.symlink("real", alias, "dir")
  const filename = path.join(real, "preferences.json")
  const sentinel = '{"preferences":["unchanged"]}'
  await fs.writeFile(filename, sentinel)
  for (let index = 39; index >= 0; index--) {
    await fs.symlink(index === 39 ? "preferences.json" : `link-${index + 1}`, path.join(real, `link-${index}`))
  }
  const fortyOne = path.join(alias, "link-0")
  await expect(fs.realpath(fortyOne)).rejects.toMatchObject({ code: "ELOOP" })
  await expect(fs.readFile(fortyOne, "utf8")).rejects.toMatchObject({ code: "ELOOP" })
  await expect(JsonFile.update(fortyOne, (data) => { data.preferences = ["must not write"] }))
    .rejects.toMatchObject({ code: "ELOOP" })
  expect(await fs.readFile(filename, "utf8")).toBe(sentinel)
})

for (const platform of ["darwin", "win32"] as const) {
  test(`non-Linux canonicalization preserves native resolution (${platform}, branch contract only)`, async () => {
    // This checks dispatch on the current host, not a native Windows/macOS filesystem.
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...descriptor, value: platform })
    try {
      const filename = path.resolve("preferences-case-probe.json")
      const native = platform === "win32" ? "C:\\CanonicalLongName\\Preferences.json" : "/canonical/Preferences.json"
      const realpath = spyOn(fs, "realpath").mockResolvedValue(native)
      const readlink = spyOn(fs, "readlink")
      expect(await JsonFile.canonical(filename)).toBe(native)
      expect(realpath).toHaveBeenCalledWith(filename)
      expect(realpath).toHaveBeenCalledTimes(1)
      expect(readlink).not.toHaveBeenCalled()

      realpath.mockReset()
      const parent = path.resolve("NativeParent")
      realpath.mockImplementation(async (name) => {
        if (name === filename) throw Object.assign(new Error("missing leaf"), { code: "ENOENT" })
        return parent as any
      })
      expect(await JsonFile.canonical(filename)).toBe(path.join(parent, path.basename(filename)))
      expect(realpath).toHaveBeenCalledWith(path.dirname(filename))
      expect(realpath).toHaveBeenCalledTimes(2)

      realpath.mockReset()
      realpath.mockRejectedValue(Object.assign(new Error("missing parent"), { code: "ENOENT" }))
      expect(await JsonFile.canonical(filename)).toBe(filename)
      expect(realpath).toHaveBeenCalledTimes(2)

      realpath.mockReset()
      realpath.mockRejectedValue(Object.assign(new Error("access denied"), { code: "EACCES" }))
      await expect(JsonFile.canonical(filename)).rejects.toMatchObject({ code: "EACCES" })
      expect(realpath).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, "platform", descriptor)
    }
  })
}
