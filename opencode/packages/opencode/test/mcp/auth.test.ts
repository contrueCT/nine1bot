import { afterEach, beforeEach, expect, test } from "bun:test"
import { rm } from "fs/promises"

const { McpAuth } = await import("../../src/mcp/auth")

const tempFile = "/tmp/opencode-mcp-auth-test.json"

beforeEach(async () => {
  process.env.NINE1BOT_MCP_AUTH_PATH = tempFile
  await rm(tempFile, { force: true }).catch(() => undefined)
})

afterEach(async () => {
  await rm(tempFile, { force: true }).catch(() => undefined)
  delete process.env.NINE1BOT_MCP_AUTH_PATH
})

test("marks tokens within the safety window as stale", async () => {
  await McpAuth.updateTokens("lark", {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 240,
    scope: "scope1",
  })

  expect(await McpAuth.isTokenStale("lark")).toBe(true)
})

test("keeps tokens outside the safety window as valid", async () => {
  await McpAuth.updateTokens("lark", {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    scope: "scope1",
  })

  expect(await McpAuth.isTokenStale("lark")).toBe(false)
})

test("tracks dynamic and static registration state in persisted oauth entries", async () => {
  await McpAuth.updateClientInfo("lark", {
    clientId: "dynamic-client",
    clientSecret: "dynamic-secret",
  })

  let entry = await McpAuth.get("lark")
  expect(entry?.registrationMode).toBe("dynamic")

  await McpAuth.setRegistrationMode("lark", "static")
  entry = await McpAuth.get("lark")
  expect(entry?.registrationMode).toBe("static")
})

test("records auth start timestamp while oauth is in progress", async () => {
  await McpAuth.updateOAuthState("lark", "oauth-state")
  const entry = await McpAuth.get("lark")

  expect(entry?.oauthState).toBe("oauth-state")
  expect(typeof entry?.authStartedAt).toBe("number")
})
