import { afterEach, beforeEach, expect, test } from "bun:test"
import { rm } from "fs/promises"

const tempFile = "/tmp/opencode-mcp-oauth-provider-test.json"

const { McpAuth } = await import("../../src/mcp/auth")
const { McpOAuthProvider } = await import("../../src/mcp/oauth-provider")

beforeEach(async () => {
  process.env.NINE1BOT_MCP_AUTH_PATH = tempFile
  await rm(tempFile, { force: true }).catch(() => undefined)
})

afterEach(async () => {
  await rm(tempFile, { force: true }).catch(() => undefined)
  delete process.env.NINE1BOT_MCP_AUTH_PATH
})

test("re-registers a dynamic client when redirect URL changes", async () => {
  await McpAuth.updateClientInfo(
    "lark",
    {
      clientId: "dynamic-client",
      clientSecret: "dynamic-secret",
    },
    "http://127.0.0.1:3000/mcp",
    "http://127.0.0.1:19876/mcp/oauth/callback",
  )

  const provider = new McpOAuthProvider(
    "lark",
    "http://127.0.0.1:3000/mcp",
    {},
    "http://127.0.0.1:4096/mcp/oauth/callback",
    {
      onRedirect: async () => {},
    },
  )

  expect(await provider.clientInformation()).toBeUndefined()

  const entry = await McpAuth.get("lark")
  expect(entry?.clientInfo).toBeUndefined()
})

test("persists redirect URL when saving a dynamic client", async () => {
  const provider = new McpOAuthProvider(
    "lark",
    "http://127.0.0.1:3000/mcp",
    {},
    "http://127.0.0.1:4096/mcp/oauth/callback",
    {
      onRedirect: async () => {},
    },
  )

  await provider.saveClientInformation({
    client_id: "dynamic-client",
    client_secret: "dynamic-secret",
    client_id_issued_at: 123,
    client_secret_expires_at: 456,
    redirect_uris: ["http://127.0.0.1:4096/mcp/oauth/callback"],
  })

  const entry = await McpAuth.get("lark")
  expect(entry?.redirectUrl).toBe("http://127.0.0.1:4096/mcp/oauth/callback")
  expect(entry?.clientInfo?.clientId).toBe("dynamic-client")
})
