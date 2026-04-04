import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod/v4"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { checkAndReloadMcpConfig, startMcpConfigWatcher, stopMcpConfigWatcher } from "./hot-reload"
import { Scheduler } from "../scheduler"

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000
  const HEALTH_CHECK_INTERVAL = 60_000
  const RECONNECT_BASE_DELAY = 10_000
  const RECONNECT_MAX_DELAY = 5 * 60_000

  export const Resource = z
    .object({
      name: z.string(),
      uri: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      client: z.string(),
    })
    .meta({ ref: "McpResource" })
  export type Resource = z.infer<typeof Resource>

  export const ToolInfo = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.any().optional(),
    })
    .meta({ ref: "McpToolInfo" })
  export type ToolInfo = z.infer<typeof ToolInfo>

  export const ResourceInfo = z
    .object({
      uri: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    })
    .meta({ ref: "McpResourceInfo" })
  export type ResourceInfo = z.infer<typeof ResourceInfo>

  export const Health = z
    .object({
      ok: z.boolean(),
      checkedAt: z.string(),
      latencyMs: z.number().int().nonnegative().optional(),
      tools: z.number().int().nonnegative().optional(),
      resources: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "McpHealth" })
  export type Health = z.infer<typeof Health>

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const BrowserOpenFailed = BusEvent.define(
    "mcp.browser.open.failed",
    z.object({
      mcpName: z.string(),
      url: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("auth_in_progress"),
        })
        .meta({
          ref: "MCPStatusAuthInProgress",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  export const StatusInfo = Status.and(
    z.object({
      tools: z.array(ToolInfo).optional(),
      resources: z.array(ResourceInfo).optional(),
      health: Health.optional(),
    }),
  ).meta({
    ref: "McpStatusInfo",
  })
  export type StatusInfo = z.infer<typeof StatusInfo>

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      await refreshTools(serverName, client).catch((error) => {
        log.error("failed to refresh tools after notification", { server: serverName, error })
      })
      await refreshResources(serverName, client).catch((error) => {
        log.error("failed to refresh resources after notification", { server: serverName, error })
      })
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // Convert MCP tool definition to AI SDK Tool type
  function isAuthenticationError(error: unknown) {
    return (
      error instanceof UnauthorizedError ||
      (error instanceof Error &&
        /unauthorized|invalid[_ ]token|reauth|authentication required|invalid_client|invalid_grant/i.test(
          error.message,
        ))
    )
  }

  type AuthFailureReason = "needs_auth" | "invalid_client" | "invalid_grant" | "registration_required"

  function classifyAuthenticationError(error: unknown): AuthFailureReason | undefined {
    if (!isAuthenticationError(error)) {
      return undefined
    }

    const message = error instanceof Error ? error.message : String(error)

    if (/dynamic client registration|pre-registered client|required clientId|needs_client_registration/i.test(message)) {
      return "registration_required"
    }

    if (/invalid_client/i.test(message)) {
      return "invalid_client"
    }

    if (/invalid_grant|reauth_required|insufficient_scope/i.test(message)) {
      return "invalid_grant"
    }

    return "needs_auth"
  }

  async function convertMcpTool(
    serverName: string,
    mcpTool: MCPToolDef,
    client: MCPClient,
    timeout?: number,
  ): Promise<Tool> {
    const inputSchema = mcpTool.inputSchema

    // Spread first, then override type to ensure it's always "object"
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        try {
          return await client.callTool(
            {
              name: mcpTool.name,
              arguments: args as Record<string, unknown>,
            },
            CallToolResultSchema,
            {
              resetTimeoutOnProgress: true,
              timeout,
            },
          )
        } catch (error) {
          if (!isAuthenticationError(error)) {
            throw error
          }

          const message = error instanceof Error ? error.message : String(error)
          await markFailed(serverName, message)

          const cfg = await Config.get()
          const entry = cfg.mcp?.[serverName]
          if (!entry || !isMcpConfigured(entry)) {
            throw error
          }

          const recovered = await ensureServerConnected(serverName, entry, { interactiveAuth: true })
          if (!recovered) {
            throw error
          }

          const refreshedClient = (await clients())[serverName]
          if (!refreshedClient) {
            throw error
          }

          return refreshedClient.callTool(
            {
              name: mcpTool.name,
              arguments: args as Record<string, unknown>,
            },
            CallToolResultSchema,
            {
              resetTimeoutOnProgress: true,
              timeout,
            },
          )
        }
      },
    })
  }

  async function getServerTimeout(serverName: string, entry?: Config.Mcp) {
    const cfg = await Config.get()
    const defaultTimeout = cfg.experimental?.mcp_timeout ?? DEFAULT_TIMEOUT
    return entry?.timeout ?? defaultTimeout
  }

  async function refreshTools(serverName: string, client: MCPClient, timeout?: number) {
    const toolsResult = await withTimeout(client.listTools(), timeout ?? DEFAULT_TIMEOUT)
    const s = await state()
    s.tools[serverName] = toolsResult.tools.map(toToolInfo)
  }

  async function refreshResources(serverName: string, client: MCPClient, timeout?: number) {
    const resourcesResult = await withTimeout(client.listResources(), timeout ?? DEFAULT_TIMEOUT)
    const s = await state()
    s.resources[serverName] = resourcesResult.resources.map(toResourceInfo)
  }

  type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
  type StartAuthMode = "loopback" | "server"

  type StartAuthOptions = {
    mode?: StartAuthMode
    serverOrigin?: string
    attempt?: number
  }

  type PendingOAuthSession = {
    directory: string
    mcpName: string
    state: string
    transport: TransportWithAuth
    mode: StartAuthMode
    serverOrigin?: string
    attempt: number
  }

  const pendingOAuthSessions = new Map<string, PendingOAuthSession>()
  const connectionFlights = new Map<string, Promise<boolean>>()
  const authLaunchFlights = new Map<string, Promise<Status>>()

  // Prompt cache types
  type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]

  type ResourceInfoRaw = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  function isMcpConfigured(entry: McpEntry): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  type McpRemote = Extract<Config.Mcp, { type: "remote" }>

  type ReconnectState = {
    attempts: number
    nextAt: number
  }

  function createOAuthState() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }

  function getLoopbackRedirectUrl() {
    return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  }

  function getServerRedirectUrl(serverOrigin: string) {
    if (!serverOrigin) {
      throw new Error("Server origin is required for MCP OAuth server callback mode")
    }
    return `${serverOrigin.replace(/\/$/, "")}/mcp/oauth/callback`
  }

  function createRemoteTransports(mcp: McpRemote, authProvider?: McpOAuthProvider) {
    return [
      {
        name: "StreamableHTTP",
        transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
          authProvider,
          requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
        }),
      },
      {
        name: "SSE",
        transport: new SSEClientTransport(new URL(mcp.url), {
          authProvider,
          requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
        }),
      },
    ] satisfies Array<{ name: string; transport: TransportWithAuth }>
  }

  function buildOAuthProvider(
    mcpName: string,
    mcp: McpRemote,
    redirectUrl: string,
    onRedirect: (url: URL) => void | Promise<void>,
  ) {
    const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
    return new McpOAuthProvider(
      mcpName,
      mcp.url,
      {
        clientId: oauthConfig?.clientId,
        clientSecret: oauthConfig?.clientSecret,
        scope: oauthConfig?.scope,
      },
      redirectUrl,
      {
        onRedirect,
      },
    )
  }

  function hasStaticClientRegistration(mcp: McpRemote) {
    return typeof mcp.oauth === "object" && Boolean(mcp.oauth.clientId)
  }

  async function clearDynamicOAuthState(mcpName: string) {
    await Promise.all([
      McpAuth.clearTokens(mcpName),
      McpAuth.clearClientInfo(mcpName),
      McpAuth.clearLastAuthError(mcpName),
    ]).catch(() => undefined)
  }

  function isFeishuLikeServer(serverName: string, mcp: McpRemote) {
    return /lark|feishu/i.test(serverName) || /lark|feishu/i.test(mcp.url)
  }

  function shouldPreflightFeishuIntent(userText: string) {
    return /飞书|feishu|lark|知识库|文档|wiki|docs|群聊|群|chat|消息/i.test(userText)
  }

  function getPendingSessionByName(mcpName: string) {
    for (const session of pendingOAuthSessions.values()) {
      if (session.mcpName === mcpName) {
        return session
      }
    }
  }

  function clearPendingSessionsForName(mcpName: string) {
    for (const [state, session] of pendingOAuthSessions.entries()) {
      if (session.mcpName === mcpName) {
        pendingOAuthSessions.delete(state)
        McpOAuthCallback.cancelPending(state)
      }
    }
  }

  async function cleanupPendingOAuthSession(session: PendingOAuthSession) {
    pendingOAuthSessions.delete(session.state)
    McpOAuthCallback.cancelPending(session.state)
    await Promise.all([
      McpAuth.clearOAuthState(session.mcpName).catch(() => undefined),
      McpAuth.clearCodeVerifier(session.mcpName).catch(() => undefined),
    ])
  }

  async function setStatusAfterAuthInterruption(mcpName: string, status: Status) {
    const nextState = await state()
    nextState.status[mcpName] = status
  }

  async function retryAfterInvalidClient(session: PendingOAuthSession) {
    return Instance.provide({
      directory: session.directory,
      fn: async () => {
        const cfg = await Config.get()
        const mcpConfig = cfg.mcp?.[session.mcpName]
        if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") {
          return undefined
        }

        await clearDynamicOAuthState(session.mcpName)

        if (session.attempt >= 1 || hasStaticClientRegistration(mcpConfig)) {
          return undefined
        }

        await cleanupPendingOAuthSession(session)

        const { authorizationUrl } = await startAuth(session.mcpName, {
          mode: session.mode,
          serverOrigin: session.serverOrigin,
          attempt: session.attempt + 1,
        })
        const oauthState = await McpAuth.getOAuthState(session.mcpName)
        if (!authorizationUrl || !oauthState) {
          return undefined
        }

        return {
          authorizationUrl,
          oauthState,
        }
      },
    })
  }

  async function runBrowserAuthorization(
    mcpName: string,
    authorizationUrl: string,
    oauthState: string,
  ): Promise<Status> {
    log.info("launching background oauth flow", { mcpName, authorizationUrl, oauthState })
    const s = await state()
    s.status[mcpName] = {
      status: "auth_in_progress",
    }

    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    try {
      const subprocess = await open(authorizationUrl)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 500)
        subprocess.on("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        subprocess.on("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout)
            reject(new Error(`Browser open failed with exit code ${code}`))
          }
        })
      })
    } catch (error) {
      log.warn("failed to open browser, user must open URL manually", { mcpName, error })
      await Bus.publish(BrowserOpenFailed, { mcpName, url: authorizationUrl }).catch(() => undefined)
    }

    try {
      const code = await callbackPromise
      const status = await finishAuthByState(oauthState, code)
      const nextState = await state()
      nextState.status[mcpName] = status
      return status
    } catch (error) {
      const oauthError =
        error && typeof error === "object" && "oauthError" in error && typeof error.oauthError === "string"
          ? error.oauthError
          : undefined
      const session = pendingOAuthSessions.get(oauthState)
      if (oauthError === "invalid_client" && session) {
        log.warn("received invalid_client during browser authorization, retrying with fresh registration", {
          mcpName,
          attempt: session.attempt,
        })
        const recovered = await retryAfterInvalidClient(session)
        if (recovered) {
          return runBrowserAuthorization(mcpName, recovered.authorizationUrl, recovered.oauthState)
        }
      }
      if (session) {
        await cleanupPendingOAuthSession(session)
      }
      log.error("background oauth flow failed", { mcpName, error })
      const nextState = await state()
      const status: Status = {
        status: "needs_auth",
      }
      nextState.status[mcpName] = status
      return status
    }
  }

  async function launchBrowserAuthorization(
    mcpName: string,
    authorizationUrl: string,
    oauthState: string,
  ): Promise<Status> {
    const existing = authLaunchFlights.get(mcpName)
    if (existing) {
      return existing
    }

    const flight = runBrowserAuthorization(mcpName, authorizationUrl, oauthState).finally(() => {
      authLaunchFlights.delete(mcpName)
    })

    authLaunchFlights.set(mcpName, flight)
    return flight
  }

  function toToolInfo(tool: MCPToolDef): ToolInfo {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }
  }

  function toResourceInfo(resource: ResourceInfoRaw): ResourceInfo {
    return {
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }
  }

  function computeNextReconnect(attempts: number) {
    const base = RECONNECT_BASE_DELAY
    const delay = Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), RECONNECT_MAX_DELAY)
    const jitter = Math.floor(Math.random() * 1000)
    return Date.now() + delay + jitter
  }

  async function markFailed(serverName: string, error: string) {
    const s = await state()
    const client = s.clients[serverName]
    if (client) {
      await client.close().catch((closeError) => {
        log.error("Failed to close MCP client after error", { serverName, error: closeError })
      })
      delete s.clients[serverName]
    }
    s.status[serverName] = {
      status: "failed",
      error,
    }
    s.health[serverName] = {
      ok: false,
      checkedAt: new Date().toISOString(),
      error,
    }
    delete s.tools[serverName]
    delete s.resources[serverName]

    const current = s.reconnect[serverName] ?? { attempts: 0, nextAt: 0 }
    const attempts = current.attempts + 1
    s.reconnect[serverName] = {
      attempts,
      nextAt: computeNextReconnect(attempts),
    }
  }

  async function syncCreateResult(serverName: string, result: Awaited<ReturnType<typeof create>>) {
    const s = await state()
    const existingClient = s.clients[serverName]

    s.status[serverName] = result.status

    if (result.mcpClient) {
      if (existingClient && existingClient !== result.mcpClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { serverName, error })
        })
      }
      s.clients[serverName] = result.mcpClient
    } else if (existingClient) {
      await existingClient.close().catch((error) => {
        log.error("Failed to close existing MCP client", { serverName, error })
      })
      delete s.clients[serverName]
    }

    if (result.tools) {
      s.tools[serverName] = result.tools
    } else {
      delete s.tools[serverName]
    }

    if (result.resources) {
      s.resources[serverName] = result.resources
    } else {
      delete s.resources[serverName]
    }

    if (result.health) {
      s.health[serverName] = result.health
    } else {
      delete s.health[serverName]
    }
  }

  type EnsureServerConnectedOptions = {
    interactiveAuth?: boolean
    waitForAuthMs?: number
  }

  async function ensureServerConnected(
    serverName: string,
    entry: Config.Mcp,
    options: EnsureServerConnectedOptions = {},
  ): Promise<boolean> {
    const existing = connectionFlights.get(serverName)
    if (existing) {
      return existing
    }

    const flight = (async () => {
      const interactiveAuth = options.interactiveAuth ?? true
      const waitForAuthMs = options.waitForAuthMs ?? 0
      const s = await state()
      if (s.status[serverName]?.status === "connected" && s.clients[serverName]) {
        return true
      }

      const result = await create(serverName, entry)
      await syncCreateResult(serverName, result)

      if (result.status.status === "connected" && result.mcpClient) {
        return true
      }

      if (!interactiveAuth || entry.type !== "remote" || entry.oauth === false) {
        return false
      }

      const authStatus = await getAuthStatus(serverName)
      const shouldAuthenticate =
        result.status.status === "needs_auth" ||
        result.status.status === "needs_client_registration" ||
        authStatus === "not_authenticated" ||
        authStatus === "expired"

      if (!shouldAuthenticate) {
        return false
      }

      const { authorizationUrl } = await startAuth(serverName, { mode: "loopback" })
      if (!authorizationUrl) {
        const nextState = await state()
        return nextState.status[serverName]?.status === "connected"
      }

      const oauthState = await McpAuth.getOAuthState(serverName)
      if (!oauthState) {
        return false
      }

      const launch = launchBrowserAuthorization(serverName, authorizationUrl, oauthState)
      if (waitForAuthMs <= 0) {
        void launch
        return false
      }

      const outcome = await Promise.race([
        launch.then(() => "completed" as const),
        new Promise<"timeout">((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), waitForAuthMs)
          timer.unref?.()
        }),
      ])

      if (outcome === "completed") {
        const nextState = await state()
        return nextState.status[serverName]?.status === "connected"
      }

      const nextState = await state()
      nextState.status[serverName] = {
        status: "auth_in_progress",
      }
      return false
    })().finally(() => {
      connectionFlights.delete(serverName)
    })

    connectionFlights.set(serverName, flight)
    return flight
  }

  const state = Instance.state(
    async () => {
      const cfg = await Config.get()
      const config = cfg.mcp ?? {}
      const clients: Record<string, MCPClient> = {}
      const status: Record<string, Status> = {}
      const tools: Record<string, ToolInfo[]> = {}
      const resources: Record<string, ResourceInfo[]> = {}
      const health: Record<string, Health> = {}
      const reconnect: Record<string, ReconnectState> = {}

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          if (!isMcpConfigured(mcp)) {
            log.error("Ignoring MCP config entry without type", { key })
            return
          }

          // If disabled by config, mark as disabled without trying to connect
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }

          const result = await create(key, mcp).catch(() => undefined)
          if (!result) return

          status[key] = result.status

          if (result.mcpClient) {
            clients[key] = result.mcpClient
          }
          if (result.tools) {
            tools[key] = result.tools
          }
          if (result.resources) {
            resources[key] = result.resources
          }
          if (result.health) {
            health[key] = result.health
          }
        }),
      )

      // 启动配置文件监听（用于热更新）
      startMcpConfigWatcher()
      startMcpHealthMonitor()

      return {
        status,
        clients,
        tools,
        resources,
        health,
        reconnect,
      }
    },
    async (state) => {
      // 停止配置文件监听
      stopMcpConfigWatcher()
      stopMcpHealthMonitor()

      await Promise.all(
        Object.values(state.clients).map((client) =>
          client.close().catch((error) => {
            log.error("Failed to close MCP client", {
              error,
            })
          }),
        ),
      )
      pendingOAuthSessions.clear()
    },
  )

  // Helper function to fetch prompts for a specific client
  async function fetchPromptsForClient(clientName: string, client: Client) {
    const prompts = await client.listPrompts().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!prompts) {
      return
    }

    const commands: Record<string, PromptInfo & { client: string }> = {}

    for (const prompt of prompts.prompts) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedPromptName

      commands[key] = { ...prompt, client: clientName }
    }
    return commands
  }

  async function fetchResourcesForClient(clientName: string, client: Client) {
    const resources = await client.listResources().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!resources) {
      return
    }

    const commands: Record<string, ResourceInfo & { client: string }> = {}

    for (const resource of resources.resources) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedResourceName

      commands[key] = { ...resource, client: clientName }
    }
    return commands
  }

  export async function add(name: string, mcp: Config.Mcp) {
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      return {
        status,
      }
    }
    if (!result.mcpClient) {
      s.status[name] = result.status
      if (result.health) {
        s.health[name] = result.health
      }
      return {
        status: s.status,
      }
    }
    // Close existing client if present to prevent memory leaks
    const existingClient = s.clients[name]
    if (existingClient) {
      await existingClient.close().catch((error) => {
        log.error("Failed to close existing MCP client", { name, error })
      })
    }
    s.clients[name] = result.mcpClient
    s.status[name] = result.status
    if (result.tools) {
      s.tools[name] = result.tools
    }
    if (result.health) {
      s.health[name] = result.health
    }

    return {
      status: s.status,
    }
  }

  async function create(key: string, mcp: Config.Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
        health: {
          ok: false,
          checkedAt: new Date().toISOString(),
          error: "disabled",
        },
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = buildOAuthProvider(
          key,
          mcp,
          getLoopbackRedirectUrl(),
          async (url) => {
            log.info("oauth redirect requested", { key, url: url.toString() })
            // Store the URL - actual browser opening is handled by startAuth
          },
        )
      }

      const transports = createRemoteTransports(mcp, authProvider)

      let lastError: Error | undefined
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      for (const { name, transport } of transports) {
        try {
          const client = new Client({
            name: "opencode",
            version: Installation.VERSION,
          })
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Handle OAuth-specific errors
          if (isAuthenticationError(error)) {
            log.info("mcp server requires authentication", { key, transport: name })
            const reason = classifyAuthenticationError(lastError)
            if (reason === "registration_required" && !hasStaticClientRegistration(mcp)) {
              status = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide clientId in config.",
              }
              Bus.publish(TuiEvent.ToastShow, {
                title: "MCP Authentication Required",
                message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                variant: "warning",
                duration: 8000,
              }).catch((e) => log.debug("failed to show toast", { error: e }))
            } else {
              if (reason === "invalid_client" && !hasStaticClientRegistration(mcp)) {
                await clearDynamicOAuthState(key)
              }

              status = { status: "needs_auth" as const }
              Bus.publish(TuiEvent.ToastShow, {
                title: "MCP Authentication Required",
                message: `Server "${key}" requires browser authorization.`,
                variant: "warning",
                duration: 8000,
              }).catch((e) => log.debug("failed to show toast", { error: e }))
            }
            break
          }

          log.debug("transport connection failed", {
            key,
            transport: name,
            url: mcp.url,
            error: lastError.message,
          })
          status = {
            status: "failed" as const,
            error: lastError.message,
          }
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      const cwd = Instance.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      try {
        const client = new Client({
          name: "opencode",
          version: Installation.VERSION,
        })
        await withTimeout(client.connect(transport), connectTimeout)
        registerNotificationHandlers(client, key)
        mcpClient = client
        status = {
          status: "connected",
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
        health: {
          ok: false,
          checkedAt: new Date().toISOString(),
          error: status.status === "failed" ? status.error : "connection failed",
        },
      }
    }

    const toolStart = Date.now()
    const result = await withTimeout(mcpClient.listTools(), mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
        health: {
          ok: false,
          checkedAt: new Date().toISOString(),
          error: "Failed to get tools",
        },
      }
    }

    const tools = result.tools.map(toToolInfo)
    const resourcesResult = await withTimeout(mcpClient.listResources(), mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
      log.debug("failed to get resources from client", { key, error: err })
      return undefined
    })
    const resources = resourcesResult?.resources.map(toResourceInfo)
    const health: Health = {
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - toolStart,
      tools: tools.length,
      resources: resources?.length,
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
      tools,
      resources,
      health,
    }
  }

  export async function status() {
    // 检查配置文件变化，支持热更新
    await checkAndReloadMcpConfig()

    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    // Include all configured MCPs from config, not just connected ones
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      result[key] = s.status[key] ?? { status: "disabled" }
    }

    return result
  }

  export async function overview(): Promise<Record<string, StatusInfo>> {
    await checkAndReloadMcpConfig()

    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const result: Record<string, StatusInfo> = {}

    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      const status = s.status[key] ?? { status: "disabled" as const }
      result[key] = {
        ...status,
        tools: s.tools[key],
        resources: s.resources[key],
        health: s.health[key],
      }
    }

    return result
  }

  const healthInFlight = new Map<string, Promise<Health>>()

  async function pingServer(
    serverName: string,
    client: MCPClient,
    entry: Config.Mcp,
  ): Promise<Health> {
    const timeout = await getServerTimeout(serverName, entry)
    const startedAt = Date.now()
    try {
      const toolsResult = await withTimeout(client.listTools(), timeout)
      const resourcesResult = await withTimeout(client.listResources(), timeout).catch(() => undefined)
      const s = await state()
      s.tools[serverName] = toolsResult.tools.map(toToolInfo)
      if (resourcesResult) {
        s.resources[serverName] = resourcesResult.resources.map(toResourceInfo)
      }
      s.status[serverName] = { status: "connected" }
      delete s.reconnect[serverName]

      const health: Health = {
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        tools: toolsResult.tools.length,
        resources: resourcesResult?.resources.length,
      }
      s.health[serverName] = health
      return health
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markFailed(serverName, message)
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: message,
      }
    }
  }

  export async function health(serverName: string): Promise<Health> {
    const existingFlight = healthInFlight.get(serverName)
    if (existingFlight) return existingFlight

    const flight = (async () => {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const entry = config[serverName]

    if (!entry || !isMcpConfigured(entry)) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: "MCP server not configured",
      }
    }
    if (entry.enabled === false) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: "MCP server disabled",
      }
    }

    const s = await state()
    const existing = s.clients[serverName]
    if (existing) {
      return pingServer(serverName, existing, entry)
    }

    const result = await create(serverName, entry)
    s.status[serverName] = result.status
    if (result.mcpClient) {
      // Close existing client if present to prevent memory leaks
      const existingClient = s.clients[serverName]
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { serverName, error })
        })
      }
      s.clients[serverName] = result.mcpClient
    }
    if (result.tools) {
      s.tools[serverName] = result.tools
    }
    if (result.health) {
      s.health[serverName] = result.health
    }

    if (!result.mcpClient) {
      const message = result.status.status === "failed" ? result.status.error : "Connection failed"
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: message,
      }
    }

    return pingServer(serverName, result.mcpClient, entry)
    })()

    healthInFlight.set(serverName, flight)
    try {
      return await flight
    } finally {
      healthInFlight.delete(serverName)
    }
  }

  async function attemptReconnect(serverName: string, entry: Config.Mcp) {
    const s = await state()
    const result = await create(serverName, entry)
    s.status[serverName] = result.status
    if (result.mcpClient) {
      const existingClient = s.clients[serverName]
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { serverName, error })
        })
      }
      s.clients[serverName] = result.mcpClient
    }
    if (result.tools) {
      s.tools[serverName] = result.tools
    }
    if (result.health) {
      s.health[serverName] = result.health
    }

    if (result.status.status === "connected" && result.mcpClient) {
      delete s.reconnect[serverName]
      return
    }

    const current = s.reconnect[serverName] ?? { attempts: 0, nextAt: 0 }
    const attempts = current.attempts + 1
    s.reconnect[serverName] = {
      attempts,
      nextAt: computeNextReconnect(attempts),
    }
  }

  async function monitorMcpHealth() {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const s = await state()
    const now = Date.now()

    for (const [name, entry] of Object.entries(config)) {
      if (!isMcpConfigured(entry)) continue
      if (entry.enabled === false) continue

      const status = s.status[name]

      if (status?.status === "connected") {
        const client = s.clients[name]
        if (!client) {
          await markFailed(name, "Client missing")
          continue
        }
        await pingServer(name, client, entry)
        continue
      }

      if (status?.status === "failed") {
        const reconnect = s.reconnect[name]
        if (reconnect && now < reconnect.nextAt) continue
        await attemptReconnect(name, entry)
      }

      if (status?.status === "needs_auth" || status?.status === "needs_client_registration") {
        s.health[name] = {
          ok: false,
          checkedAt: new Date().toISOString(),
          error: "authentication required",
        }
      }
    }
  }

  let healthMonitorStarted = false
  function startMcpHealthMonitor() {
    if (healthMonitorStarted) return
    healthMonitorStarted = true
    Scheduler.register({
      id: "mcp-health-monitor",
      interval: HEALTH_CHECK_INTERVAL,
      run: monitorMcpHealth,
    })
  }

  function stopMcpHealthMonitor() {
    healthMonitorStarted = false
    Scheduler.unregister("mcp-health-monitor")
  }

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function connect(name: string) {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    if (!isMcpConfigured(mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true })

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      return
    }

    const s = await state()
    s.status[name] = result.status
    if (result.mcpClient) {
      // Close existing client if present to prevent memory leaks
      const existingClient = s.clients[name]
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { name, error })
        })
      }
      s.clients[name] = result.mcpClient
    }
    if (result.tools) {
      s.tools[name] = result.tools
    }
    if (result.health) {
      s.health[name] = result.health
    }
  }

  export async function disconnect(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await client.close().catch((error) => {
        log.error("Failed to close MCP client", { name, error })
      })
      delete s.clients[name]
    }
    s.status[name] = { status: "disabled" }
    delete s.tools[name]
    delete s.resources[name]
    delete s.health[name]
    delete s.reconnect[name]
  }

  /**
   * Remove an MCP server completely (disconnect and remove from state)
   */
  export async function remove(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await client.close().catch((error) => {
        log.error("Failed to close MCP client", { name, error })
      })
      delete s.clients[name]
    }
    delete s.status[name]
    delete s.tools[name]
    delete s.resources[name]
    delete s.health[name]
    delete s.reconnect[name]
    log.info("removed MCP server", { name })
  }

  export async function tools() {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const s = await state()
    const defaultTimeout = cfg.experimental?.mcp_timeout
    const result: Record<string, Tool> = {}

    const clientsSnapshot = await clients()

    for (const [clientName, client] of Object.entries(clientsSnapshot)) {
      // Only include tools from connected MCPs (skip disabled ones)
      if (s.status[clientName]?.status !== "connected") {
        continue
      }

      const toolsResult = await client.listTools().catch((e) => {
        log.error("failed to get tools", { clientName, error: e.message })
        const message = e instanceof Error ? e.message : String(e)
        void markFailed(clientName, message)
        return undefined
      })
      if (!toolsResult) {
        continue
      }
      s.tools[clientName] = toolsResult.tools.map(toToolInfo)
      s.health[clientName] = {
        ok: true,
        checkedAt: new Date().toISOString(),
        tools: toolsResult.tools.length,
      }
      const mcpConfig = config[clientName]
      const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
      const timeout = entry?.timeout ?? defaultTimeout
      for (const mcpTool of toolsResult.tools) {
        const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
        result[sanitizedClientName + "_" + sanitizedToolName] = await convertMcpTool(
          clientName,
          mcpTool,
          client,
          timeout,
        )
      }
    }
    return result
  }

  export async function prompts() {
    const s = await state()
    const clientsSnapshot = await clients()

    const prompts = Object.fromEntries<PromptInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchPromptsForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return prompts
  }

  export async function resources() {
    const s = await state()
    const clientsSnapshot = await clients()

    const result = Object.fromEntries<ResourceInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchResourcesForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return result
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    let client = (await clients())[clientName]

    if (!client) {
      const cfg = await Config.get()
      const entry = cfg.mcp?.[clientName]
      if (entry && isMcpConfigured(entry)) {
        await ensureServerConnected(clientName, entry, { interactiveAuth: true })
        client = (await clients())[clientName]
      }
    }

    if (!client) {
      log.warn("client not found for prompt", {
        clientName,
      })
      return undefined
    }

    const result = await client
      .getPrompt({
        name: name,
        arguments: args,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName,
          promptName: name,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  export async function readResource(clientName: string, resourceUri: string) {
    let client = (await clients())[clientName]

    if (!client) {
      const cfg = await Config.get()
      const entry = cfg.mcp?.[clientName]
      if (entry && isMcpConfigured(entry)) {
        await ensureServerConnected(clientName, entry, { interactiveAuth: true })
        client = (await clients())[clientName]
      }
    }

    if (!client) {
      log.warn("client not found for prompt", {
        clientName: clientName,
      })
      return undefined
    }

    const result = await client
      .readResource({
        uri: resourceUri,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName: clientName,
          resourceUri: resourceUri,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  async function finishAuthByState(oauthState: string, authorizationCode: string): Promise<Status> {
    const session = pendingOAuthSessions.get(oauthState)

    if (!session) {
      throw new Error("No pending OAuth flow for the provided state")
    }

    try {
      return await Instance.provide({
        directory: session.directory,
        fn: async () => {
          const storedState = await McpAuth.getOAuthState(session.mcpName)
          if (storedState !== oauthState) {
            throw new Error("OAuth state mismatch - potential CSRF attack")
          }

          await session.transport.finishAuth(authorizationCode)
          await McpAuth.clearCodeVerifier(session.mcpName)

          const cfg = await Config.get()
          const mcpConfig = cfg.mcp?.[session.mcpName]

          if (!mcpConfig) {
            throw new Error(`MCP server not found: ${session.mcpName}`)
          }

          if (!isMcpConfigured(mcpConfig)) {
            throw new Error(`MCP server ${session.mcpName} is disabled or missing configuration`)
          }

          const result = await add(session.mcpName, mcpConfig)
          const statusRecord = result.status as Record<string, Status>
          return statusRecord[session.mcpName] ?? { status: "failed", error: "Unknown error after auth" }
        },
      })
    } catch (error) {
      log.error("failed to finish oauth", { mcpName: session.mcpName, error })
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      pendingOAuthSessions.delete(oauthState)
      await McpAuth.clearCodeVerifier(session.mcpName).catch(() => undefined)
      await McpAuth.clearOAuthState(session.mcpName).catch(() => undefined)
    }
  }

  /**
   * Start OAuth authentication flow for an MCP server.
   * Returns the authorization URL that should be opened in a browser.
   */
  export async function startAuth(
    mcpName: string,
    options: StartAuthOptions = {},
  ): Promise<{ authorizationUrl: string }> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]

    if (!mcpConfig) {
      throw new Error(`MCP server not found: ${mcpName}`)
    }

    if (!isMcpConfigured(mcpConfig)) {
      throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
    }

    if (mcpConfig.type !== "remote") {
      throw new Error(`MCP server ${mcpName} is not a remote server`)
    }

    if (mcpConfig.oauth === false) {
      throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
    }

    const mode = options.mode ?? "loopback"
    if (mode === "loopback") {
      await McpOAuthCallback.ensureRunning()
    }

    const oauthState = createOAuthState()
    await McpAuth.updateOAuthState(mcpName, oauthState)

    const redirectUrl =
      mode === "server"
        ? getServerRedirectUrl(options.serverOrigin ?? "")
        : getLoopbackRedirectUrl()

    const connectTimeout = mcpConfig.timeout ?? DEFAULT_TIMEOUT

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let capturedUrl: URL | undefined
        const authProvider = buildOAuthProvider(
          mcpName,
          mcpConfig,
          redirectUrl,
          async (url) => {
            capturedUrl = url
          },
        )
        const transports = createRemoteTransports(mcpConfig, authProvider)
        let retryAfterInvalidClient = false

        for (const { name, transport } of transports) {
          try {
            const client = new Client({
              name: "opencode",
              version: Installation.VERSION,
            })
            await withTimeout(client.connect(transport), connectTimeout)
            await client.close().catch(() => undefined)
            return { authorizationUrl: "" }
          } catch (error) {
            const reason = classifyAuthenticationError(error)
            if (isAuthenticationError(error) && capturedUrl) {
              pendingOAuthSessions.set(oauthState, {
                directory: Instance.directory,
                mcpName,
                state: oauthState,
                transport,
                mode,
                serverOrigin: options.serverOrigin,
                attempt: options.attempt ?? 0,
              })
              const s = await state()
              s.status[mcpName] = {
                status: "auth_in_progress",
              }
              return { authorizationUrl: capturedUrl.toString() }
            }

            if (reason === "invalid_client" && !hasStaticClientRegistration(mcpConfig) && attempt === 0) {
              await clearDynamicOAuthState(mcpName)
              retryAfterInvalidClient = true
              break
            }

            if (reason === "registration_required" && !hasStaticClientRegistration(mcpConfig)) {
              throw new Error("Server does not support dynamic client registration. Please provide clientId in config.")
            }

            log.debug("oauth start transport failed", {
              mcpName,
              transport: name,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        if (retryAfterInvalidClient) {
          continue
        }

        break
      }
    } catch (error) {
      await McpAuth.clearOAuthState(mcpName).catch(() => undefined)
      await McpAuth.clearCodeVerifier(mcpName).catch(() => undefined)
      throw error
    }

    await McpAuth.clearOAuthState(mcpName).catch(() => undefined)
    await McpAuth.clearCodeVerifier(mcpName).catch(() => undefined)
    throw new Error(`Failed to start OAuth flow for MCP server: ${mcpName}`)
  }

  /**
   * Complete OAuth authentication after user authorizes in browser.
   * Opens the browser and waits for callback.
   */
  export async function authenticate(mcpName: string): Promise<Status> {
    const { authorizationUrl } = await startAuth(mcpName, { mode: "loopback" })

    if (!authorizationUrl) {
      const s = await state()
      return s.status[mcpName] ?? { status: "connected" }
    }

    const oauthState = await McpAuth.getOAuthState(mcpName)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    log.info("opening browser for oauth", { mcpName, url: authorizationUrl, state: oauthState })
    return launchBrowserAuthorization(mcpName, authorizationUrl, oauthState)
  }

  /**
   * Complete OAuth authentication with the authorization code.
   */
  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    const storedState = await McpAuth.getOAuthState(mcpName)
    const sessionState = storedState ?? getPendingSessionByName(mcpName)?.state

    if (!sessionState) {
      throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    }

    return finishAuthByState(sessionState, authorizationCode)
  }

  export async function handleOAuthCallback(input: {
    code?: string | null
    state?: string | null
    error?: string | null
    errorDescription?: string | null
    oauthError?: string | null
  }): Promise<{ html: string; status: number } | { redirectUrl: string; status: number }> {
    const state = input.state ?? undefined

    if (!state) {
      return {
        html: McpOAuthCallback.renderError("Missing required state parameter - potential CSRF attack"),
        status: 400,
      }
    }

    if (input.error) {
      const errorMessage = input.errorDescription || input.error
      const session = pendingOAuthSessions.get(state)
      if (session) {
        if (input.oauthError === "invalid_client") {
          const recovered = await retryAfterInvalidClient(session)
          if (recovered) {
            return {
              redirectUrl: recovered.authorizationUrl,
              status: 302,
            }
          }
        }
        await setStatusAfterAuthInterruption(session.mcpName, {
          status: "needs_auth",
        })
        await cleanupPendingOAuthSession(session)
      }
      return {
        html: McpOAuthCallback.renderError(errorMessage),
        status: 400,
      }
    }

    if (!input.code) {
      const session = pendingOAuthSessions.get(state)
      if (session) {
        await setStatusAfterAuthInterruption(session.mcpName, {
          status: "needs_auth",
        })
        await cleanupPendingOAuthSession(session)
      }
      return {
        html: McpOAuthCallback.renderError("No authorization code provided"),
        status: 400,
      }
    }

    if (!pendingOAuthSessions.has(state)) {
      return {
        html: McpOAuthCallback.renderError("Invalid or expired state parameter - potential CSRF attack"),
        status: 400,
      }
    }

    const session = pendingOAuthSessions.get(state)
    const status = await finishAuthByState(state, input.code)
    if (status.status === "connected") {
      return {
        html: McpOAuthCallback.renderSuccess(),
        status: 200,
      }
    }

    if (session) {
      await setStatusAfterAuthInterruption(session.mcpName, status)
    }

    return {
      html: McpOAuthCallback.renderError(status.status === "failed" ? status.error : "OAuth authentication failed"),
      status: 400,
    }
  }

  /**
   * Remove OAuth credentials for an MCP server.
   */
  export async function removeAuth(mcpName: string): Promise<void> {
    clearPendingSessionsForName(mcpName)
    await McpAuth.remove(mcpName)
    await McpAuth.clearOAuthState(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  /**
   * Check if an MCP server supports OAuth (remote servers support OAuth by default unless explicitly disabled).
   */
  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) return false
    if (!isMcpConfigured(mcpConfig)) return false
    return mcpConfig.type === "remote" && mcpConfig.oauth !== false
  }

  /**
   * Check if an MCP server has stored OAuth tokens.
   */
  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const entry = await McpAuth.get(mcpName)
    return !!entry?.tokens
  }

  export async function prepareServersForTurn(
    userText: string,
    options: { waitForAuthMs?: number } = {},
  ): Promise<{ authInProgressServers: string[] }> {
    if (!shouldPreflightFeishuIntent(userText)) {
      return { authInProgressServers: [] }
    }

    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const authInProgressServers: string[] = []
    const waitForAuthMs = options.waitForAuthMs ?? 120_000

    for (const [serverName, entry] of Object.entries(config)) {
      if (!isMcpConfigured(entry) || entry.type !== "remote" || entry.oauth === false || entry.enabled === false) {
        continue
      }

      if (!isFeishuLikeServer(serverName, entry)) {
        continue
      }

      const connected = await ensureServerConnected(serverName, entry, {
        interactiveAuth: true,
        waitForAuthMs,
      })

      if (!connected) {
        const nextState = await state()
        if (nextState.status[serverName]?.status === "auth_in_progress") {
          authInProgressServers.push(serverName)
        }
      }
    }

    return { authInProgressServers }
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  /**
   * Get the authentication status for an MCP server.
   */
  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const hasTokens = await hasStoredTokens(mcpName)
    if (!hasTokens) return "not_authenticated"
    const expired = await McpAuth.isTokenStale(mcpName)
    return expired ? "expired" : "authenticated"
  }
}
