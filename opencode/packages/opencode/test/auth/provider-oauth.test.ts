import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { ProviderAuth } from "../../src/provider/auth"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"
import type { AuthOuathResult } from "@opencode-ai/plugin"

let directory: string
let originalAuthPath: string | undefined
let authorizeFixture: () => Promise<AuthOuathResult>
let pluginSpy: ReturnType<typeof spyOn>
let refreshSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nine1bot-provider-oauth-"))
  originalAuthPath = process.env.NINE1BOT_AUTH_PATH
  process.env.NINE1BOT_AUTH_PATH = join(directory, "auth.json")
  pluginSpy = spyOn(Plugin, "list").mockResolvedValue([{
    auth: { provider: "vendor", methods: [{ type: "oauth", label: "Device login", authorize: () => authorizeFixture() }] },
  }] as any)
  refreshSpy = spyOn(Provider, "refreshAll").mockImplementation(() => {})
})

afterEach(async () => {
  pluginSpy.mockRestore()
  refreshSpy.mockRestore()
  await Instance.disposeAll()
  if (originalAuthPath === undefined) delete process.env.NINE1BOT_AUTH_PATH
  else process.env.NINE1BOT_AUTH_PATH = originalAuthPath
  await rm(directory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("OAuth callback persists credentials, invalidates provider caches, and consumes its pending login", async () => {
  authorizeFixture = async () => ({ url: "https://example.invalid/device", method: "auto", instructions: "Enter device code",
    callback: async () => ({ type: "success", refresh: "fixture-refresh", access: "fixture-access", expires: 123, accountId: "fixture-account" }) })
  await Instance.provide({ directory, fn: async () => {
    expect(await ProviderAuth.authorize({ providerID: "vendor", method: 0 })).toEqual({ url: "https://example.invalid/device", method: "auto", instructions: "Enter device code" })
    await ProviderAuth.callback({ providerID: "vendor", method: 0 })
    expect(await Auth.get("vendor")).toEqual({ type: "oauth", refresh: "fixture-refresh", access: "fixture-access", expires: 123, accountId: "fixture-account" })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    await expect(ProviderAuth.callback({ providerID: "vendor", method: 0 })).rejects.toThrow()
  } })
})

test("code authorization preserves the pending login after a rejected code and stores a later success", async () => {
  authorizeFixture = async () => ({ url: "https://example.invalid/code", method: "code", instructions: "Paste code",
    callback: async code => code === "valid" ? { type: "success", key: "fixture-key" } : { type: "failed" } })
  await Instance.provide({ directory, fn: async () => {
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    await expect(ProviderAuth.callback({ providerID: "vendor", method: 0, code: "bad" })).rejects.toThrow()
    expect(await Auth.get("vendor")).toBeUndefined()
    await ProviderAuth.callback({ providerID: "vendor", method: 0, code: "valid" })
    expect(await Auth.get("vendor")).toEqual({ type: "api", key: "fixture-key" })
  } })
})

test("a late callback cannot overwrite a newer completed login", async () => {
  const oldResult = deferred<any>()
  let attempt = 0
  authorizeFixture = async () => ({ url: "https://example.invalid/device", method: "auto", instructions: "Wait",
    callback: ++attempt === 1 ? () => oldResult.promise : async () => ({ type: "success", key: "new-login" }) })
  await Instance.provide({ directory, fn: async () => {
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    const first = ProviderAuth.callback({ providerID: "vendor", method: 0 })
    const rejected = first.then(() => { throw new Error("Expected stale OAuth operation to fail") }, error => { expect(error).toBeDefined() })
    await Promise.resolve()
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    await ProviderAuth.callback({ providerID: "vendor", method: 0 })
    oldResult.resolve({ type: "success", key: "old-login" })
    await rejected
    expect(await Auth.get("vendor")).toEqual({ type: "api", key: "new-login" })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  } })
})

test("an older login in another project cannot overwrite the newest global provider credentials", async () => {
  const otherDirectory = join(directory, "other-project")
  await mkdir(otherDirectory)
  const oldResult = deferred<any>()
  const callbackStarted = deferred<void>()
  let attempt = 0
  authorizeFixture = async () => ({ url: "https://example.invalid/device", method: "auto", instructions: "Wait",
    callback: ++attempt === 1
      ? () => { callbackStarted.resolve(); return oldResult.promise }
      : async () => ({ type: "success", key: "new-project-login" }) })
  await Instance.provide({ directory, fn: () => ProviderAuth.authorize({ providerID: "vendor", method: 0 }) })
  const first = Instance.provide({ directory, fn: () => ProviderAuth.callback({ providerID: "vendor", method: 0 }) })
  const rejected = first.then(
    () => { throw new Error("stale project callback unexpectedly succeeded") },
    error => { expect(error).toBeDefined() },
  )
  await callbackStarted.promise
  await Instance.provide({ directory: otherDirectory, fn: async () => {
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    await ProviderAuth.callback({ providerID: "vendor", method: 0 })
  } })
  oldResult.resolve({ type: "success", key: "old-project-login" })
  await rejected
  expect(await Auth.get("vendor")).toEqual({ type: "api", key: "new-project-login" })
  expect(refreshSpy).toHaveBeenCalledTimes(1)
})

test("saving an API key supersedes an older OAuth callback", async () => {
  const result = deferred<any>()
  const started = deferred<void>()
  authorizeFixture = async () => ({ url: "https://example.invalid/device", method: "auto", instructions: "Wait",
    callback: () => { started.resolve(); return result.promise } })
  await Instance.provide({ directory, fn: async () => {
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    const pending = ProviderAuth.callback({ providerID: "vendor", method: 0 }).then(
      () => { throw new Error("stale OAuth callback overwrote the API key") },
      error => { expect(error).toBeDefined() },
    )
    await started.promise
    await Auth.set("vendor", { type: "api", key: "replacement-api-key" })
    result.resolve({ type: "success", key: "stale-oauth-key" })
    await pending
    expect(await Auth.get("vendor")).toEqual({ type: "api", key: "replacement-api-key" })
    expect(refreshSpy).not.toHaveBeenCalled()
  } })
})

test("logging out invalidates an unfinished OAuth callback instead of restoring credentials", async () => {
  const result = deferred<any>()
  const started = deferred<void>()
  authorizeFixture = async () => ({ url: "https://example.invalid/device", method: "auto", instructions: "Wait",
    callback: () => { started.resolve(); return result.promise } })
  await Instance.provide({ directory, fn: async () => {
    await Auth.set("vendor", { type: "api", key: "initial-key" })
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    const pending = ProviderAuth.callback({ providerID: "vendor", method: 0 }).then(
      () => { throw new Error("stale OAuth callback restored logged-out credentials") },
      error => { expect(error).toBeDefined() },
    )
    await started.promise
    await Auth.remove("vendor")
    result.resolve({ type: "success", refresh: "stale-refresh", access: "stale-access", expires: 123 })
    await pending
    expect(await Auth.get("vendor")).toBeUndefined()
    expect(refreshSpy).not.toHaveBeenCalled()
  } })
})

test("an older authorize response cannot replace a newer pending login", async () => {
  const firstAuthorization = deferred<AuthOuathResult>()
  let attempt = 0
  authorizeFixture = () => ++attempt === 1 ? firstAuthorization.promise : Promise.resolve({ url: "https://example.invalid/new", method: "auto", instructions: "New login", callback: async () => ({ type: "success", key: "new-login" }) })
  await Instance.provide({ directory, fn: async () => {
    const first = ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    const rejected = first.then(() => { throw new Error("Expected stale OAuth operation to fail") }, error => { expect(error).toBeDefined() })
    // Wait until the first authorize request has actually entered the plugin.
    while (attempt === 0) await Promise.resolve()
    await ProviderAuth.authorize({ providerID: "vendor", method: 0 })
    firstAuthorization.resolve({ url: "https://example.invalid/old", method: "auto", instructions: "Old login", callback: async () => ({ type: "success", key: "old-login" }) })
    await rejected
    await ProviderAuth.callback({ providerID: "vendor", method: 0 })
    expect(await Auth.get("vendor")).toEqual({ type: "api", key: "new-login" })
  } })
})
