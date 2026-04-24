import { describe, expect, test } from "bun:test"
import path from "path"

const packageRoot = path.join(__dirname, "../..")

async function readSource(relativePath: string) {
  return Bun.file(path.join(packageRoot, relativePath)).text()
}

describe("mcp turn preflight", () => {
  test("does not keep Feishu/Lark-specific preflight on the prompt critical path", async () => {
    const [mcpSource, promptSource] = await Promise.all([
      readSource("src/mcp/index.ts"),
      readSource("src/session/prompt.ts"),
    ])

    expect(mcpSource).not.toContain("prepareServersForTurn")
    expect(mcpSource).not.toContain("shouldPreflightFeishuIntent")
    expect(mcpSource).not.toContain("isFeishuLikeServer")
    expect(promptSource).not.toContain("prepareServersForTurn")
    expect(promptSource).not.toContain("Feishu MCP authentication is in progress")
    expect(mcpSource).toContain("export async function tools()")
  })
})
