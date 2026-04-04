import { test, expect, mock, beforeEach, afterEach } from "bun:test"
import { EventEmitter } from "events"

// Track open() calls and control failure behavior
let openShouldFail = false
let openCalledWith: string | undefined
let openCalls: string[] = []
let connectShouldSucceed = false
const busSubscriptions = new Map<string, Array<(event: any) => void>>()
const callbackWaiters = new Map<
  string,
  {
    resolve: (code: string) => void
    reject: (error: Error) => void
  }
>()

mock.module("open", () => ({
  default: async (url: string) => {
    openCalledWith = url
    openCalls.push(url)
    // Return a mock subprocess that emits an error if openShouldFail is true
    const subprocess = new EventEmitter()
    if (openShouldFail) {
      // Emit error asynchronously like a real subprocess would
      setTimeout(() => {
        subprocess.emit("error", new Error("spawn xdg-open ENOENT"))
      }, 10)
    }
    return subprocess
  },
}))

// Mock UnauthorizedError
class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// Mock the transport constructors
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    url: string
    authProvider:
      | {
          redirectToAuthorization?: (url: URL) => Promise<void>
          redirectUrl?: string
        }
      | undefined
    constructor(
      url: URL,
      options?: {
        authProvider?: { redirectToAuthorization?: (url: URL) => Promise<void>; redirectUrl?: string }
        requestInit?: RequestInit
      },
    ) {
      this.url = url.toString()
      this.authProvider = options?.authProvider
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      if (connectShouldSucceed) {
        return
      }
      // Simulate OAuth redirect by calling the authProvider's redirectToAuthorization
      if (this.authProvider?.redirectToAuthorization) {
        const redirectUri = encodeURIComponent(this.authProvider.redirectUrl || "")
        await this.authProvider.redirectToAuthorization(
          new URL(`https://auth.example.com/authorize?client_id=test&redirect_uri=${redirectUri}`),
        )
      }
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {
      connectShouldSucceed = true
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock the MCP SDK Client to trigger OAuth flow
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
    async close() {}
    async listTools() {
      return { tools: [] }
    }
    async listResources() {
      return { resources: [] }
    }
    setNotificationHandler() {}
  },
}))

// Mock UnauthorizedError in the auth module
mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

mock.module("@/bus", () => ({
  Bus: {
    async publish(def: { type: string }, properties: Record<string, unknown>) {
      const event = {
        type: def.type,
        properties,
      }
      for (const callback of busSubscriptions.get(def.type) ?? []) {
        callback(event)
      }
      for (const callback of busSubscriptions.get("*") ?? []) {
        callback(event)
      }
      return []
    },
    subscribe(def: { type: string }, callback: (event: any) => void) {
      const current = busSubscriptions.get(def.type) ?? []
      current.push(callback)
      busSubscriptions.set(def.type, current)
      return () => {
        const next = busSubscriptions.get(def.type) ?? []
        const index = next.indexOf(callback)
        if (index >= 0) {
          next.splice(index, 1)
        }
      }
    },
  },
}))

beforeEach(() => {
  openShouldFail = false
  openCalledWith = undefined
  openCalls = []
  connectShouldSucceed = false
  transportCalls.length = 0
  busSubscriptions.clear()
  callbackWaiters.clear()
})

// Import modules after mocking
const { Instance } = await import("../../src/project/instance")
const { MCP } = await import("../../src/mcp/index")
const { Bus } = await import("@/bus")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { McpAuth } = await import("../../src/mcp/auth")
const { tmpdir } = await import("../fixture/fixture")

const mockedOAuthCallback = McpOAuthCallback as typeof McpOAuthCallback & {
  ensureRunning: () => Promise<void>
  waitForCallback: (oauthState: string) => Promise<string>
  cancelPending: (oauthState: string) => void
  stop: () => Promise<void>
}

mockedOAuthCallback.ensureRunning = async () => {}
mockedOAuthCallback.waitForCallback = (oauthState: string) =>
  {
    const promise = new Promise<string>((resolve, reject) => {
      callbackWaiters.set(oauthState, { resolve, reject })
    })
    promise.catch(() => undefined)
    return promise
  }
mockedOAuthCallback.cancelPending = (oauthState: string) => {
  const pending = callbackWaiters.get(oauthState)
  if (!pending) {
    return
  }
  callbackWaiters.delete(oauthState)
  pending.reject(new Error("Authorization cancelled"))
}
mockedOAuthCallback.stop = async () => {
  for (const [oauthState, pending] of callbackWaiters.entries()) {
    callbackWaiters.delete(oauthState)
    pending.reject(new Error("OAuth callback server stopped"))
  }
}

afterEach(async () => {
  await McpOAuthCallback.stop().catch(() => undefined)
})

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 2000): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (value !== undefined) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for condition")
}

function rejectCallback(state: string, message: string, oauthError?: string) {
  const pending = callbackWaiters.get(state)
  if (!pending) {
    throw new Error(`Missing pending callback for state: ${state}`)
  }
  callbackWaiters.delete(state)
  const error = new Error(message) as Error & { oauthError?: string }
  error.oauthError = oauthError
  pending.reject(error)
}

function resolveCallback(state: string, code: string) {
  const pending = callbackWaiters.get(state)
  if (!pending) {
    throw new Error(`Missing pending callback for state: ${state}`)
  }
  callbackWaiters.delete(state)
  pending.resolve(code)
}

test("BrowserOpenFailed event is published when open() throws", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      openShouldFail = true

      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      // Run authenticate with a timeout to avoid waiting forever for the callback
      const authPromise = MCP.authenticate("test-oauth-server")

      // Wait for the browser open attempt (error fires at 10ms, but we wait for event to be published)
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Stop the callback server and cancel any pending auth
      await McpOAuthCallback.stop()

      const status = await authPromise

      unsubscribe()

      // Verify the BrowserOpenFailed event was published
      expect(events.length).toBe(1)
      expect(events[0].mcpName).toBe("test-oauth-server")
      expect(events[0].url).toContain("https://")
      expect(status.status).toBe("needs_auth")
    },
  })
})

test("BrowserOpenFailed event is NOT published when open() succeeds", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-2": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      openShouldFail = false

      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      // Run authenticate with a timeout to avoid waiting forever for the callback
      const authPromise = MCP.authenticate("test-oauth-server-2")

      // Wait for the browser open attempt and the 500ms error detection timeout
      await new Promise((resolve) => setTimeout(resolve, 700))

      // Stop the callback server and cancel any pending auth
      await McpOAuthCallback.stop()

      const status = await authPromise

      unsubscribe()

      // Verify NO BrowserOpenFailed event was published
      expect(events.length).toBe(0)
      // Verify open() was still called
      expect(openCalledWith).toBeDefined()
      expect(status.status).toBe("needs_auth")
    },
  })
})

test("open() is called with the authorization URL", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-3": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      openShouldFail = false
      openCalledWith = undefined

      // Run authenticate with a timeout to avoid waiting forever for the callback
      const authPromise = MCP.authenticate("test-oauth-server-3")

      // Wait for the browser open attempt and the 500ms error detection timeout
      await new Promise((resolve) => setTimeout(resolve, 700))

      // Stop the callback server and cancel any pending auth
      await McpOAuthCallback.stop()

      const status = await authPromise

      // Verify open was called with a URL
      expect(openCalledWith).toBeDefined()
      expect(typeof openCalledWith).toBe("string")
      expect(openCalledWith!).toContain("https://")
      expect(status.status).toBe("needs_auth")
    },
  })
})

test("startAuth reuses remote headers and server callback redirect", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-headers": {
              type: "remote",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer test-token",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0

      const result = await MCP.startAuth("test-oauth-server-headers", {
        mode: "server",
        serverOrigin: "https://bot.example.com",
      })

      expect(result.authorizationUrl).toContain(
        encodeURIComponent("https://bot.example.com/mcp/oauth/callback"),
      )
      expect(transportCalls[0]?.options.requestInit?.headers).toEqual({
        Authorization: "Bearer test-token",
      })
    },
  })
})

test("authenticate retries invalid_client once before surfacing failure", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-retry": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const authPromise = MCP.authenticate("test-oauth-server-retry")
      authPromise.catch(() => undefined)

      await waitFor(() => (openCalls.length >= 1 ? openCalls[0] : undefined))
      const firstState = await waitFor(() => McpAuth.getOAuthState("test-oauth-server-retry"))

      rejectCallback(firstState, "invalid_client", "invalid_client")

      await waitFor(() => (openCalls.length >= 2 ? openCalls[1] : undefined))
      const secondState = await waitFor(async () => {
        const value = await McpAuth.getOAuthState("test-oauth-server-retry")
        return value && value !== firstState ? value : undefined
      })

      expect(secondState).not.toBe(firstState)

      resolveCallback(secondState, "test-code")

      const status = await authPromise
      expect(status.status).toBe("connected")
      expect(openCalls.length).toBe(2)
    },
  })
})

test("server callback redirects to a fresh authorization URL after invalid_client once", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-server-retry": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const started = await MCP.startAuth("test-oauth-server-server-retry", {
        mode: "server",
        serverOrigin: "https://bot.example.com",
      })

      expect(started.authorizationUrl).toContain(
        encodeURIComponent("https://bot.example.com/mcp/oauth/callback"),
      )

      const firstState = await waitFor(() => McpAuth.getOAuthState("test-oauth-server-server-retry"))
      const retry = await MCP.handleOAuthCallback({
        state: firstState,
        error: "access_denied",
        errorDescription: "invalid_client",
        oauthError: "invalid_client",
      })

      expect("redirectUrl" in retry).toBe(true)
      if (!("redirectUrl" in retry)) {
        throw new Error("Expected retry redirect response")
      }
      expect(retry.redirectUrl).toContain(encodeURIComponent("https://bot.example.com/mcp/oauth/callback"))

      const secondState = await waitFor(async () => {
        const value = await McpAuth.getOAuthState("test-oauth-server-server-retry")
        return value && value !== firstState ? value : undefined
      })

      const success = await MCP.handleOAuthCallback({
        state: secondState,
        code: "server-code",
      })

      expect("html" in success).toBe(true)
      if (!("html" in success)) {
        throw new Error("Expected HTML success response")
      }
      expect(success.status).toBe(200)
    },
  })
})

test("server callback error resets auth_in_progress back to needs_auth", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-cancelled": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const started = await MCP.startAuth("test-oauth-server-cancelled", {
        mode: "server",
        serverOrigin: "https://bot.example.com",
      })

      expect(started.authorizationUrl).toContain(
        encodeURIComponent("https://bot.example.com/mcp/oauth/callback"),
      )

      const oauthState = await waitFor(() => McpAuth.getOAuthState("test-oauth-server-cancelled"))

      const response = await MCP.handleOAuthCallback({
        state: oauthState,
        error: "access_denied",
        errorDescription: "User denied access",
      })

      expect("html" in response).toBe(true)
      if (!("html" in response)) {
        throw new Error("Expected HTML error response")
      }
      expect(response.status).toBe(400)

      const statuses = await MCP.status()
      expect(statuses["test-oauth-server-cancelled"]?.status).toBe("needs_auth")
    },
  })
})
