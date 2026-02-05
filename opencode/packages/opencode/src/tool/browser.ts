import z from "zod"
import { Tool } from "./tool"

// Nine1Bot Browser Bridge Server URL
const BRIDGE_URL = process.env.NINE1BOT_BRIDGE_URL || "http://127.0.0.1:18793"

interface BridgeResponse<T = unknown> {
  ok: boolean
  error?: string
  data?: T
  [key: string]: unknown
}

async function bridgeRequest<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<BridgeResponse<T>> {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })
  return response.json() as Promise<BridgeResponse<T>>
}

const BROWSER_TABS_DESCRIPTION = `List all browser tabs that can be controlled.
Returns information about each tab including its ID, title, and URL.
Use this tool first to discover available tabs before performing operations.

The browser must have the Nine1Bot Browser Control extension installed and connected.`

export const BrowserTabsTool = Tool.define("browser_tabs", {
  description: BROWSER_TABS_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "browser_tabs",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const result = await bridgeRequest<{ tabs: Array<{ id: string; title: string; url: string }> }>("/tabs")

    if (!result.ok) {
      throw new Error(result.error || "Failed to list browser tabs")
    }

    const tabs = result.tabs || []
    if (tabs.length === 0) {
      return {
        title: "No browser tabs available",
        output: "No browser tabs found. Make sure the Nine1Bot Browser Control extension is installed and connected.",
        metadata: { tabCount: 0 },
      }
    }

    const tabList = tabs
      .map((tab, i) => `${i + 1}. [${tab.id}] ${tab.title}\n   URL: ${tab.url}`)
      .join("\n\n")

    return {
      title: `Found ${tabs.length} browser tab(s)`,
      output: `Available browser tabs:\n\n${tabList}`,
      metadata: { tabCount: tabs.length },
    }
  },
})

const BROWSER_SCREENSHOT_DESCRIPTION = `Capture a screenshot of a browser tab.
Returns a base64-encoded PNG image of the visible area of the tab.

Parameters:
- tabId: The ID of the tab to capture (get from browser_tabs tool)

Note: The first screenshot of a tab will show a Chrome debugger notification banner.`

export const BrowserScreenshotTool = Tool.define("browser_screenshot", {
  description: BROWSER_SCREENSHOT_DESCRIPTION,
  parameters: z.object({
    tabId: z.string().describe("The ID of the tab to capture"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_screenshot",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const result = await bridgeRequest<string>(`/tabs/${params.tabId}/screenshot`, {
      method: "POST",
      body: {},
    })

    if (!result.ok) {
      throw new Error(result.error || "Failed to capture screenshot")
    }

    const imageData = result.data
    if (!imageData) {
      throw new Error("No screenshot data returned")
    }

    return {
      title: "Screenshot captured",
      output: "Screenshot captured successfully.",
      metadata: {},
      attachments: [
        {
          type: "file" as const,
          mimeType: "image/png",
          data: imageData,
        },
      ],
    }
  },
})

const BROWSER_NAVIGATE_DESCRIPTION = `Navigate a browser tab to a specific URL.

Parameters:
- tabId: The ID of the tab to navigate (get from browser_tabs tool)
- url: The URL to navigate to (must include protocol, e.g., https://)`

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description: BROWSER_NAVIGATE_DESCRIPTION,
  parameters: z.object({
    tabId: z.string().describe("The ID of the tab to navigate"),
    url: z.string().describe("The URL to navigate to"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_navigate",
      patterns: [params.url],
      always: ["*"],
      metadata: { tabId: params.tabId, url: params.url },
    })

    const result = await bridgeRequest(`/tabs/${params.tabId}/navigate`, {
      method: "POST",
      body: { url: params.url },
    })

    if (!result.ok) {
      throw new Error(result.error || "Failed to navigate")
    }

    return {
      title: `Navigated to ${params.url}`,
      output: `Successfully navigated tab to: ${params.url}`,
      metadata: { url: params.url },
    }
  },
})

const BROWSER_CLICK_DESCRIPTION = `Click at a specific position in a browser tab.

Parameters:
- tabId: The ID of the tab to click in (get from browser_tabs tool)
- x: X coordinate (horizontal position from left edge)
- y: Y coordinate (vertical position from top edge)
- button: Mouse button to use (default: "left")
- clickCount: Number of clicks (default: 1, use 2 for double-click)

Use browser_screenshot first to see the page and determine click coordinates.`

export const BrowserClickTool = Tool.define("browser_click", {
  description: BROWSER_CLICK_DESCRIPTION,
  parameters: z.object({
    tabId: z.string().describe("The ID of the tab to click in"),
    x: z.number().describe("X coordinate"),
    y: z.number().describe("Y coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    clickCount: z.number().optional().describe("Number of clicks"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_click",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId, x: params.x, y: params.y },
    })

    const result = await bridgeRequest(`/tabs/${params.tabId}/click`, {
      method: "POST",
      body: {
        x: params.x,
        y: params.y,
        button: params.button,
        clickCount: params.clickCount,
      },
    })

    if (!result.ok) {
      throw new Error(result.error || "Failed to click")
    }

    return {
      title: `Clicked at (${params.x}, ${params.y})`,
      output: `Successfully clicked at position (${params.x}, ${params.y})`,
      metadata: { x: params.x, y: params.y },
    }
  },
})

const BROWSER_TYPE_DESCRIPTION = `Type text into the focused element in a browser tab.

Parameters:
- tabId: The ID of the tab to type in (get from browser_tabs tool)
- text: The text to type

First click on an input field to focus it, then use this tool to type text.`

export const BrowserTypeTool = Tool.define("browser_type", {
  description: BROWSER_TYPE_DESCRIPTION,
  parameters: z.object({
    tabId: z.string().describe("The ID of the tab to type in"),
    text: z.string().describe("The text to type"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_type",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const result = await bridgeRequest(`/tabs/${params.tabId}/type`, {
      method: "POST",
      body: { text: params.text },
    })

    if (!result.ok) {
      throw new Error(result.error || "Failed to type")
    }

    return {
      title: "Text typed",
      output: `Successfully typed: "${params.text.slice(0, 50)}${params.text.length > 50 ? "..." : ""}"`,
      metadata: { textLength: params.text.length },
    }
  },
})

const BROWSER_EVALUATE_DESCRIPTION = `Execute JavaScript code in a browser tab and return the result.

Parameters:
- tabId: The ID of the tab to execute in (get from browser_tabs tool)
- expression: JavaScript code to execute

The code runs in the page context and can access DOM, window, document, etc.
Returns the result of the last expression.`

export const BrowserEvaluateTool = Tool.define("browser_evaluate", {
  description: BROWSER_EVALUATE_DESCRIPTION,
  parameters: z.object({
    tabId: z.string().describe("The ID of the tab to execute in"),
    expression: z.string().describe("JavaScript code to execute"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_evaluate",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const result = await bridgeRequest<unknown>(`/tabs/${params.tabId}/evaluate`, {
      method: "POST",
      body: { expression: params.expression },
    })

    if (!result.ok) {
      throw new Error(result.error || "Failed to evaluate")
    }

    const output = result.result !== undefined ? JSON.stringify(result.result, null, 2) : "undefined"

    return {
      title: "JavaScript executed",
      output: `Result:\n${output}`,
      metadata: {},
    }
  },
})

const BROWSER_CONTENT_DESCRIPTION = `Get the HTML content of a browser tab.

Parameters:
- tabId: The ID of the tab to get content from (get from browser_tabs tool)

Returns the page title, URL, and HTML content (truncated to 100KB).
Useful for extracting text or analyzing page structure.`

export const BrowserContentTool = Tool.define("browser_content", {
  description: BROWSER_CONTENT_DESCRIPTION,
  parameters: z.object({
    tabId: z.string().describe("The ID of the tab to get content from"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_content",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const result = await bridgeRequest<{ title: string; url: string; html: string }>(
      `/tabs/${params.tabId}/content`,
      { method: "POST", body: {} }
    )

    if (!result.ok) {
      throw new Error(result.error || "Failed to get content")
    }

    const title = result.title || "Untitled"
    const url = result.url || ""
    const html = result.html || ""

    return {
      title: `Content from: ${title}`,
      output: `Page Title: ${title}\nURL: ${url}\n\nHTML Content (${html.length} chars):\n${html.slice(0, 50000)}${html.length > 50000 ? "\n...(truncated)" : ""}`,
      metadata: { contentLength: html.length },
    }
  },
})
