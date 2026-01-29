import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"
import { Flag } from "../flag/flag"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  // Get auth file path - Nine1Bot custom path takes priority
  function getAuthFilePath(): string {
    if (process.env.NINE1BOT_AUTH_PATH) {
      return process.env.NINE1BOT_AUTH_PATH
    }
    return path.join(Global.Path.data, "auth.json")
  }

  // OpenCode default auth path
  const opencodeAuthPath = path.join(Global.Path.data, "auth.json")

  // Helper to load auth from a file
  async function loadAuthFile(filePath: string): Promise<Record<string, Info>> {
    const file = Bun.file(filePath)
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    let result: Record<string, Info> = {}
    const nine1botAuthPath = process.env.NINE1BOT_AUTH_PATH

    // 1. Load OpenCode auth if inheritance is enabled and Nine1Bot path is set
    if (!Flag.OPENCODE_DISABLE_OPENCODE_AUTH && nine1botAuthPath) {
      result = await loadAuthFile(opencodeAuthPath)
    }

    // 2. Load from primary auth file (Nine1Bot or OpenCode)
    const primaryPath = getAuthFilePath()

    // If no Nine1Bot path, just load from OpenCode (unless disabled)
    if (!nine1botAuthPath) {
      if (Flag.OPENCODE_DISABLE_OPENCODE_AUTH) {
        return {}
      }
      return loadAuthFile(primaryPath)
    }

    // Load Nine1Bot auth (overwrites OpenCode auth for same providers)
    const nine1botAuth = await loadAuthFile(primaryPath)
    result = { ...result, ...nine1botAuth }

    return result
  }

  export async function set(key: string, info: Info) {
    const filePath = getAuthFilePath()
    const dir = path.dirname(filePath)

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true })

    // Load current data from Nine1Bot auth file only (not merged)
    const file = Bun.file(filePath)
    const currentData = await file.json().catch(() => ({}) as Record<string, unknown>)
    const data = Object.entries(currentData).reduce(
      (acc, [k, value]) => {
        const parsed = Info.safeParse(value)
        if (parsed.success) acc[k] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )

    await Bun.write(file, JSON.stringify({ ...data, [key]: info }, null, 2))
    await fs.chmod(filePath, 0o600)
  }

  export async function remove(key: string) {
    const filePath = getAuthFilePath()
    const file = Bun.file(filePath)

    // Load current data from Nine1Bot auth file only
    const currentData = await file.json().catch(() => ({}) as Record<string, unknown>)
    const data = Object.entries(currentData).reduce(
      (acc, [k, value]) => {
        const parsed = Info.safeParse(value)
        if (parsed.success) acc[k] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )

    delete data[key]
    await Bun.write(file, JSON.stringify(data, null, 2))
    await fs.chmod(filePath, 0o600)
  }
}
