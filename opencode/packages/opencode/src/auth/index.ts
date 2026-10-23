import path from "path"
import { Global } from "../global"
import { JsonFile } from "../util/json-file"
import z from "zod"
import { Lock } from "../util/lock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  const authorizations = new Map<string, symbol>()

  export async function beginAuthorization(providerID: string) {
    using lock = await Lock.write("auth.credentials")
    const generation = Symbol()
    authorizations.set(providerID, generation)
    return generation
  }

  export function isAuthorizationCurrent(providerID: string, generation: symbol | undefined) {
    return generation !== undefined && authorizations.get(providerID) === generation
  }
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
    const { data } = await JsonFile.read(filePath)
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

  async function writeCredential(key: string, info: Info) {
    await JsonFile.transaction([getAuthFilePath()], ([document]) => {
      document.data[key] = Info.parse(info)
      document.mode = 0o600
    })
  }

  export async function set(key: string, info: Info) {
    const credential = Info.parse(info)
    using lock = await Lock.write("auth.credentials")
    authorizations.delete(key)
    await writeCredential(key, credential)
  }

  export async function setAuthorized(key: string, info: Info, generation: symbol | undefined) {
    using lock = await Lock.write("auth.credentials")
    if (!isAuthorizationCurrent(key, generation)) return false
    await writeCredential(key, info)
    authorizations.delete(key)
    return true
  }

  export async function remove(key: string) {
    using lock = await Lock.write("auth.credentials")
    authorizations.delete(key)
    await JsonFile.update(getAuthFilePath(), (data) => {
      delete data[key]
    })
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

    const imported: string[] = []
    const skippedExisting: string[] = []
    const skippedInvalid: string[] = []

    using lock = await Lock.write("auth.credentials")
    await JsonFile.transaction([getAuthFilePath()], ([document]) => {
      document.mode = 0o600
      for (const [providerID, value] of sourceEntries) {
        const parsed = Info.safeParse(value)
        if (!parsed.success) {
          skippedInvalid.push(providerID)
          continue
        }
        if (providerID in document.data) {
          skippedExisting.push(providerID)
          continue
        }
        document.data[providerID] = parsed.data
        authorizations.delete(providerID)
        imported.push(providerID)
      }
    })

    return {
      sourceFound: true,
      imported,
      skippedExisting,
      skippedInvalid,
      totalSource: sourceEntries.length,
    }
  }
}
