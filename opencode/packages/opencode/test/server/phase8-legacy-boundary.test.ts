import { describe, expect, test } from "bun:test"
import path from "path"

const packageRoot = path.join(__dirname, "../..")

async function readSource(relativePath: string) {
  return Bun.file(path.join(packageRoot, relativePath)).text()
}

describe("phase 8 legacy runtime boundary", () => {
  test("controller agent routes use the canonical compiler, not legacy adapters", async () => {
    const controllerSource = await readSource("src/server/routes/nine1bot-agent.ts")

    expect(controllerSource).toContain("ControllerAgentRunCompiler")
    expect(controllerSource).toContain("SessionProfileCompiler")
    expect(controllerSource).not.toContain("LegacyAgentRunSpecAdapter")
    expect(controllerSource).not.toContain("RuntimeCompatibilityCompiler")
    expect(controllerSource).not.toContain("runtime/compat/runtime-compatibility-compiler")
  })

  test("legacy session routes keep legacy adapter behind the compatibility boundary", async () => {
    const sessionRouteSource = await readSource("src/server/routes/session.ts")
    const compatCompilerSource = await readSource("src/runtime/compat/runtime-compatibility-compiler.ts")

    expect(sessionRouteSource).toContain("LegacyAgentRunSpecAdapter.fromSessionMessage")
    expect(sessionRouteSource).toContain("RuntimePromptBridgeCompiler.compilePrompt")
    expect(compatCompilerSource).toContain("Compatibility export for older imports")
    expect(compatCompilerSource).toContain("RuntimePromptBridgeCompiler as RuntimeCompatibilityCompiler")
  })
})
