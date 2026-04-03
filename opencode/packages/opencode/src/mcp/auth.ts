import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "../global"

export namespace McpAuth {
  const OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS = 300

  export const Tokens = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
    issuedAt: z.number().optional(),
    lastRefreshedAt: z.number().optional(),
  })
  export type Tokens = z.infer<typeof Tokens>

  export const ClientInfo = z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
    clientIdIssuedAt: z.number().optional(),
    clientSecretExpiresAt: z.number().optional(),
  })
  export type ClientInfo = z.infer<typeof ClientInfo>

  export const Entry = z.object({
    tokens: Tokens.optional(),
    clientInfo: ClientInfo.optional(),
    registrationMode: z.enum(["dynamic", "static"]).optional(),
    codeVerifier: z.string().optional(),
    oauthState: z.string().optional(),
    authStartedAt: z.number().optional(),
    serverUrl: z.string().optional(), // Track the URL these credentials are for
    issuer: z.string().optional(),
    authorizationEndpoint: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    registrationEndpoint: z.string().optional(),
    redirectUrl: z.string().optional(),
    lastAuthError: z.string().optional(),
    lastAuthErrorAt: z.number().optional(),
    lastSuccessAt: z.number().optional(),
  })
  export type Entry = z.infer<typeof Entry>

  const legacyFilepath = path.join(Global.Path.data, "mcp-auth.json")

  function getPrimaryFilePath() {
    return process.env.NINE1BOT_MCP_AUTH_PATH || legacyFilepath
  }

  async function loadFile(filePath: string): Promise<Record<string, Entry>> {
    const data = await Bun.file(filePath).json().catch(() => ({}))
    return z.record(z.string(), Entry).catch({}).parse(data)
  }

  async function writeFileAtomically(filePath: string, data: Record<string, Entry>): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await Bun.write(tempPath, JSON.stringify(data, null, 2))
    await fs.chmod(tempPath, 0o600)
    await fs.rename(tempPath, filePath)
  }

  export async function get(mcpName: string): Promise<Entry | undefined> {
    const data = await all()
    return data[mcpName]
  }

  /**
   * Get auth entry and validate it's for the correct URL.
   * Returns undefined if URL has changed (credentials are invalid).
   */
  export async function getForUrl(mcpName: string, serverUrl: string): Promise<Entry | undefined> {
    const entry = await get(mcpName)
    if (!entry) return undefined

    // If no serverUrl is stored, this is from an old version - consider it invalid
    if (!entry.serverUrl) return undefined

    // If URL has changed, credentials are invalid
    if (entry.serverUrl !== serverUrl) return undefined

    return entry
  }

  export async function all(): Promise<Record<string, Entry>> {
    const primaryFilepath = getPrimaryFilePath()
    if (primaryFilepath === legacyFilepath) {
      return loadFile(primaryFilepath)
    }

    const [legacy, primary] = await Promise.all([loadFile(legacyFilepath), loadFile(primaryFilepath)])
    return {
      ...legacy,
      ...primary,
    }
  }

  export async function set(mcpName: string, entry: Entry, serverUrl?: string): Promise<void> {
    const filepath = getPrimaryFilePath()
    const data = await loadFile(filepath)
    // Always update serverUrl if provided
    if (serverUrl) {
      entry.serverUrl = serverUrl
    }
    await writeFileAtomically(filepath, { ...data, [mcpName]: entry })
  }

  export async function remove(mcpName: string): Promise<void> {
    const primaryFilepath = getPrimaryFilePath()
    const targets = primaryFilepath === legacyFilepath ? [primaryFilepath] : [primaryFilepath, legacyFilepath]

    await Promise.all(
      targets.map(async (filepath) => {
        const data = await loadFile(filepath)
        delete data[mcpName]
        await writeFileAtomically(filepath, data).catch(() => undefined)
      }),
    )
  }

  export async function updateTokens(mcpName: string, tokens: Tokens, serverUrl?: string): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    entry.tokens = {
      ...tokens,
      issuedAt: tokens.issuedAt ?? Math.floor(Date.now() / 1000),
      lastRefreshedAt: Math.floor(Date.now() / 1000),
    }
    entry.lastSuccessAt = Math.floor(Date.now() / 1000)
    delete entry.lastAuthError
    delete entry.lastAuthErrorAt
    await set(mcpName, entry, serverUrl)
  }

  export async function updateClientInfo(
    mcpName: string,
    clientInfo: ClientInfo,
    serverUrl?: string,
    redirectUrl?: string,
  ): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    entry.clientInfo = clientInfo
    entry.registrationMode = "dynamic"
    if (redirectUrl) {
      entry.redirectUrl = redirectUrl
    }
    await set(mcpName, entry, serverUrl)
  }

  export async function setRegistrationMode(
    mcpName: string,
    registrationMode: "dynamic" | "static",
    serverUrl?: string,
  ): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    entry.registrationMode = registrationMode
    await set(mcpName, entry, serverUrl)
  }

  export async function updateCodeVerifier(mcpName: string, codeVerifier: string): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    entry.codeVerifier = codeVerifier
    await set(mcpName, entry)
  }

  export async function clearCodeVerifier(mcpName: string): Promise<void> {
    const entry = await get(mcpName)
    if (entry) {
      delete entry.codeVerifier
      await set(mcpName, entry)
    }
  }

  export async function updateOAuthState(mcpName: string, oauthState: string): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    entry.oauthState = oauthState
    entry.authStartedAt = Math.floor(Date.now() / 1000)
    await set(mcpName, entry)
  }

  export async function getOAuthState(mcpName: string): Promise<string | undefined> {
    const entry = await get(mcpName)
    return entry?.oauthState
  }

  export async function clearOAuthState(mcpName: string): Promise<void> {
    const entry = await get(mcpName)
    if (entry) {
      delete entry.oauthState
      delete entry.authStartedAt
      await set(mcpName, entry)
    }
  }

  export async function clearTokens(mcpName: string): Promise<void> {
    const entry = await get(mcpName)
    if (!entry) return
    delete entry.tokens
    await set(mcpName, entry)
  }

  export async function clearClientInfo(mcpName: string): Promise<void> {
    const entry = await get(mcpName)
    if (!entry) return
    delete entry.clientInfo
    await set(mcpName, entry)
  }

  export async function updateOAuthMetadata(
    mcpName: string,
    metadata: {
      issuer?: string
      authorizationEndpoint?: string
      tokenEndpoint?: string
      registrationEndpoint?: string
      redirectUrl?: string
    },
    serverUrl?: string,
  ): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    Object.assign(entry, metadata)
    await set(mcpName, entry, serverUrl)
  }

  export async function setLastAuthError(mcpName: string, message: string, serverUrl?: string): Promise<void> {
    const entry = (await get(mcpName)) ?? {}
    entry.lastAuthError = message
    entry.lastAuthErrorAt = Math.floor(Date.now() / 1000)
    await set(mcpName, entry, serverUrl)
  }

  export async function clearLastAuthError(mcpName: string): Promise<void> {
    const entry = await get(mcpName)
    if (!entry) return
    delete entry.lastAuthError
    delete entry.lastAuthErrorAt
    await set(mcpName, entry)
  }

  /**
   * Check if stored tokens are expired.
   * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
   */
  export async function isTokenExpired(mcpName: string): Promise<boolean | null> {
    const entry = await get(mcpName)
    if (!entry?.tokens) return null
    if (!entry.tokens.expiresAt) return false
    return entry.tokens.expiresAt <= Date.now() / 1000
  }

  export async function isTokenStale(mcpName: string): Promise<boolean | null> {
    const entry = await get(mcpName)
    if (!entry?.tokens) return null
    if (!entry.tokens.expiresAt) return false
    return entry.tokens.expiresAt <= Date.now() / 1000 + OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS
  }
}
