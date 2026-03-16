import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"

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

  export const ImportResult = z
    .object({
      sourceFound: z.boolean(),
      imported: z.array(z.string()),
      skippedExisting: z.array(z.string()),
      skippedInvalid: z.array(z.string()),
      totalSource: z.number(),
    })
    .meta({ ref: "AuthImportResult" })
  export type ImportResult = z.infer<typeof ImportResult>

  // Get auth file path - Nine1Bot custom path takes priority
  function getAuthFilePath(): string {
    if (process.env.NINE1BOT_AUTH_PATH) {
      return process.env.NINE1BOT_AUTH_PATH
    }
    return path.join(Global.Path.data, "auth.json")
  }

  function getOpencodeAuthFilePath(): string {
    return path.join(Global.Path.data, "auth.json")
  }

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
    return loadAuthFile(getAuthFilePath())
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

  export async function importFromOpencode(): Promise<ImportResult> {
    const sourcePath = getOpencodeAuthFilePath()
    const sourceFile = Bun.file(sourcePath)

    if (!(await sourceFile.exists())) {
      return {
        sourceFound: false,
        imported: [],
        skippedExisting: [],
        skippedInvalid: [],
        totalSource: 0,
      }
    }

    const raw = await sourceFile.json()
    const sourceEntries = typeof raw === "object" && raw !== null ? Object.entries(raw) : []
    const current = await all()

    const imported: string[] = []
    const skippedExisting: string[] = []
    const skippedInvalid: string[] = []

    for (const [providerID, value] of sourceEntries) {
      const parsed = Info.safeParse(value)
      if (!parsed.success) {
        skippedInvalid.push(providerID)
        continue
      }
      if (providerID in current) {
        skippedExisting.push(providerID)
        continue
      }

      await set(providerID, parsed.data)
      current[providerID] = parsed.data
      imported.push(providerID)
    }

    return {
      sourceFound: true,
      imported,
      skippedExisting,
      skippedInvalid,
      totalSource: sourceEntries.length,
    }
  }
}
