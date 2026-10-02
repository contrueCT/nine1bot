import { afterEach, describe, expect, test } from "bun:test"
import { BrowserDialogTool, BrowserNavigateTool, BrowserScreenshotTool, BrowserUploadTool } from "../../src/tool/browser"
import { clearBridgeServer, setBridgeServer } from "../../src/browser/bridge"
import type { Tool } from "../../src/tool/tool"

const requests: unknown[] = []
const context: Tool.Context = {
  sessionID: "session-browser-protocol",
  messageID: "message-browser-protocol",
  agent: "test",
  abort: new AbortController().signal,
  cwd: process.cwd(),
  messages: [],
  metadata: () => {},
  ask: async (request) => { requests.push(request) },
}
afterEach(() => { clearBridgeServer(); requests.length = 0 })

describe("browser protocol tool contracts", () => {
  test("requires a dialog tab and forwards its identity into permission metadata and the bridge", async () => {
    const calls: unknown[][] = []
    setBridgeServer({ handleDialog: async (...args: unknown[]) => { calls.push(args) } } as any)
    const tool = await BrowserDialogTool.init()
    await expect(tool.execute({ action: "accept" } as any, context)).rejects.toThrow("invalid arguments")
    expect(requests).toHaveLength(0)
    await tool.execute({ tabId: "tab-17", action: "accept", promptText: "hello", browser: "bot" }, context)
    expect(calls).toEqual([["tab-17", "accept", "hello", "bot"]])
    expect(requests[0]).toMatchObject({ permission: "browser_dialog", metadata: { tabId: "tab-17" } })
  })

  test("propagates bridge failures instead of returning successful dialog/navigation/upload text", async () => {
    setBridgeServer({
      handleDialog: async () => { throw new Error("No dialog is showing") },
      navigate: async () => { throw new Error("Navigation failed: net::ERR_ABORTED") },
      uploadFile: async () => { throw new Error("File upload is not supported in the user browser") },
    } as any)
    await expect((await BrowserDialogTool.init()).execute({ tabId: "17", action: "dismiss", browser: "user" }, context)).rejects.toThrow("No dialog is showing")
    await expect((await BrowserNavigateTool.init()).execute({ tabId: "17", action: "new_tab", browser: "user" }, context)).rejects.toThrow("net::ERR_ABORTED")
    await expect((await BrowserUploadTool.init()).execute({ tabId: "17", ref: "ref_abc", filePath: "/fixture.txt", browser: "user" }, context)).rejects.toThrow("not supported in the user browser")
  })

  test("describes upload host restrictions and forwards full-page screenshot intent", async () => {
    const upload = await BrowserUploadTool.init()
    expect(upload.description).toContain("User/extension browser uploads are unsupported")
    const calls: unknown[][] = []
    setBridgeServer({ screenshot: async (...args: unknown[]) => { calls.push(args); return { data: "fixture", mimeType: "image/png" } } } as any)
    const screenshot = await BrowserScreenshotTool.init()
    await screenshot.execute({ tabId: "17", fullPage: true, browser: "user" }, context)
    expect(calls).toEqual([["17", { fullPage: true }, "user"]])
  })
})
