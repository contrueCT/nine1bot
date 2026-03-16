import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Auth } from "../../src/auth"
import { Global } from "../../src/global"

const opencodeAuthPath = path.join(Global.Path.data, "auth.json")

let originalNine1botAuthPath: string | undefined
let originalOpencodeAuthContent: string | null = null
let opencodeAuthExisted = false
let tempRoot = ""

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, JSON.stringify(value, null, 2))
}

beforeEach(async () => {
  originalNine1botAuthPath = process.env.NINE1BOT_AUTH_PATH
  opencodeAuthExisted = await Bun.file(opencodeAuthPath).exists()
  originalOpencodeAuthContent = opencodeAuthExisted ? await Bun.file(opencodeAuthPath).text() : null

  tempRoot = path.join(process.cwd(), ".tmp-auth-tests", Math.random().toString(36).slice(2))
  await fs.mkdir(tempRoot, { recursive: true })
  process.env.NINE1BOT_AUTH_PATH = path.join(tempRoot, "nine1bot-auth.json")
})

afterEach(async () => {
  if (originalNine1botAuthPath === undefined) {
    delete process.env.NINE1BOT_AUTH_PATH
  } else {
    process.env.NINE1BOT_AUTH_PATH = originalNine1botAuthPath
  }

  if (opencodeAuthExisted && originalOpencodeAuthContent !== null) {
    await fs.mkdir(path.dirname(opencodeAuthPath), { recursive: true })
    await Bun.write(opencodeAuthPath, originalOpencodeAuthContent)
  } else {
    await fs.unlink(opencodeAuthPath).catch(() => {})
  }

  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

test("Auth.all only reads the Nine1Bot auth file", async () => {
  await writeJson(opencodeAuthPath, {
    openrouter: { type: "api", key: "opencode-key" },
  })
  await writeJson(process.env.NINE1BOT_AUTH_PATH!, {
    openai: { type: "api", key: "nine1bot-key" },
  })

  const auth = await Auth.all()

  expect(auth).toEqual({
    openai: { type: "api", key: "nine1bot-key" },
  })
})

test("Auth.importFromOpencode imports missing providers and skips existing and invalid entries", async () => {
  await writeJson(opencodeAuthPath, {
    openai: { type: "api", key: "openai-key" },
    anthropic: { type: "api", key: "anthropic-key" },
    invalidProvider: { type: "api" },
  })
  await writeJson(process.env.NINE1BOT_AUTH_PATH!, {
    openai: { type: "api", key: "existing-key" },
  })

  const result = await Auth.importFromOpencode()
  const auth = await Auth.all()

  expect(result).toEqual({
    sourceFound: true,
    imported: ["anthropic"],
    skippedExisting: ["openai"],
    skippedInvalid: ["invalidProvider"],
    totalSource: 3,
  })
  expect(auth).toEqual({
    openai: { type: "api", key: "existing-key" },
    anthropic: { type: "api", key: "anthropic-key" },
  })
})

test("Auth.importFromOpencode reports missing source file and deleted auth does not come back", async () => {
  const missing = await Auth.importFromOpencode()
  expect(missing).toEqual({
    sourceFound: false,
    imported: [],
    skippedExisting: [],
    skippedInvalid: [],
    totalSource: 0,
  })

  await writeJson(opencodeAuthPath, {
    google: { type: "api", key: "google-key" },
  })

  await Auth.importFromOpencode()
  await Auth.remove("google")

  expect(await Auth.all()).toEqual({})
})
