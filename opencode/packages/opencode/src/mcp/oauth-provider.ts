import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js"
import { McpAuth } from "./auth"
import { Log } from "../util/log"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"
const OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS = 300
const refreshFlights = new Map<string, Promise<OAuthTokens | undefined>>()

export type McpOAuthErrorCode =
  | "invalid_client"
  | "invalid_grant"
  | "insufficient_scope"
  | "reauth_required"
  | "registration_required"
  | "needs_auth"

export class McpOAuthError extends Error {
  constructor(
    message: string,
    public readonly oauthError: McpOAuthErrorCode,
  ) {
    super(message)
    this.name = "McpOAuthError"
  }
}

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private redirectTarget: string,
    private callbacks: McpOAuthCallbacks,
  ) {}

  get redirectUrl(): string {
    return this.redirectTarget
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenCode",
      client_uri: "https://opencode.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    }
  }

  private get oauthMetadataUrl(): string {
    return new URL("/.well-known/oauth-authorization-server", this.serverUrl).toString()
  }

  private buildStoredTokens(tokens: McpAuth.Tokens): OAuthTokens {
    return {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresAt ? Math.max(0, Math.floor(tokens.expiresAt - Date.now() / 1000)) : undefined,
      scope: tokens.scope,
    }
  }

  private async loadOAuthMetadata(): Promise<OAuthMetadata> {
    const response = await fetch(this.oauthMetadataUrl, {
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch OAuth metadata: ${response.status} ${response.statusText}`)
    }

    const metadata = (await response.json()) as OAuthMetadata
    await McpAuth.updateOAuthMetadata(
      this.mcpName,
      {
        issuer: metadata.issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        registrationEndpoint: metadata.registration_endpoint,
        redirectUrl: this.redirectUrl,
      },
      this.serverUrl,
    )
    return metadata
  }

  private parseOAuthError(
    raw: unknown,
    response: Response,
    fallback: McpOAuthErrorCode,
  ): McpOAuthError {
    const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    const message =
      (typeof payload?.error_description === "string" && payload.error_description) ||
      (typeof payload?.error === "string" && payload.error) ||
      `Token refresh failed with status ${response.status}`

    const oauthError =
      (typeof payload?.lark_mcp_error === "string" && payload.lark_mcp_error) ||
      (typeof payload?.error === "string" && payload.error) ||
      fallback

    return new McpOAuthError(message, oauthError as McpOAuthErrorCode)
  }

  private async handleRefreshFailure(error: Error & { oauthError?: string }) {
    const oauthError = error.oauthError
    await McpAuth.setLastAuthError(this.mcpName, error.message, this.serverUrl)

    if (oauthError === "invalid_client") {
      await Promise.all([McpAuth.clearTokens(this.mcpName), McpAuth.clearClientInfo(this.mcpName)])
      return
    }

    if (
      oauthError === "invalid_grant" ||
      oauthError === "reauth_required" ||
      oauthError === "insufficient_scope"
    ) {
      await McpAuth.clearTokens(this.mcpName)
    }
  }

  private async performTokenRefresh(entry: McpAuth.Entry): Promise<OAuthTokens | undefined> {
    if (!entry.tokens?.refreshToken) {
      return undefined
    }

    const client = await this.clientInformation()
    if (!client?.client_id) {
      const error = new Error("No client information available for MCP token refresh") as Error & {
        oauthError?: string
      }
      error.oauthError = "invalid_client"
      await this.handleRefreshFailure(error)
      return undefined
    }

    const metadata = await this.loadOAuthMetadata()
    if (!metadata.token_endpoint) {
      throw new Error("OAuth metadata did not include a token endpoint")
    }

    const payload: Record<string, string> = {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: entry.tokens.refreshToken,
    }

    if (client.client_secret) {
      payload.client_secret = client.client_secret
    }

    if (this.config.scope) {
      payload.scope = this.config.scope
    }

    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    })

    const raw = await response.json().catch(() => undefined)
    if (!response.ok) {
      const error = this.parseOAuthError(raw, response, "invalid_grant")
      await this.handleRefreshFailure(error)
      return undefined
    }

    const parsed = OAuthTokensSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error("MCP token refresh returned an invalid token payload")
    }

    await this.saveTokens(parsed.data)
    await McpAuth.clearLastAuthError(this.mcpName)
    return parsed.data
  }

  private async refreshTokensSingleFlight(entry: McpAuth.Entry): Promise<OAuthTokens | undefined> {
    const existing = refreshFlights.get(this.mcpName)
    if (existing) {
      return existing
    }

    const flight = this.performTokenRefresh(entry).finally(() => {
      refreshFlights.delete(this.mcpName)
    })
    refreshFlights.set(this.mcpName, flight)
    return flight
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      await McpAuth.setRegistrationMode(this.mcpName, "static", this.serverUrl)
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (entry?.clientInfo) {
      if (entry.registrationMode === "dynamic" && entry.redirectUrl !== this.redirectUrl) {
        log.info("stored dynamic client redirect URL changed, re-registering", {
          mcpName: this.mcpName,
          previousRedirectUrl: entry.redirectUrl,
          redirectUrl: this.redirectUrl,
        })
        await McpAuth.clearClientInfo(this.mcpName)
        return undefined
      }

      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        await McpAuth.clearClientInfo(this.mcpName)
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await McpAuth.updateClientInfo(
      this.mcpName,
      {
        clientId: info.client_id,
        clientSecret: info.client_secret,
        clientIdIssuedAt: info.client_id_issued_at,
        clientSecretExpiresAt: info.client_secret_expires_at,
      },
      this.serverUrl,
      this.redirectUrl,
    )
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
    await McpAuth.clearLastAuthError(this.mcpName)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (!entry?.tokens) return undefined

    const expiresAt = entry.tokens.expiresAt
    if (!expiresAt || expiresAt > Date.now() / 1000 + OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS) {
      return this.buildStoredTokens(entry.tokens)
    }

    if (!entry.tokens.refreshToken) {
      await McpAuth.clearTokens(this.mcpName)
      return undefined
    }

    const refreshed = await this.refreshTokensSingleFlight(entry)
    if (refreshed) {
      return refreshed
    }

    if (expiresAt > Date.now() / 1000) {
      log.warn("token refresh failed but current token is still usable for a short period", {
        mcpName: this.mcpName,
      })
      return this.buildStoredTokens(entry.tokens)
    }

    return undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await McpAuth.updateTokens(
      this.mcpName,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Math.floor(Date.now() / 1000 + tokens.expires_in) : undefined,
        scope: tokens.scope,
      },
      this.serverUrl,
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await McpAuth.updateCodeVerifier(this.mcpName, codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await McpAuth.updateOAuthState(this.mcpName, state)
  }

  async state(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.oauthState) {
      throw new Error(`No OAuth state saved for MCP server: ${this.mcpName}`)
    }
    return entry.oauthState
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
