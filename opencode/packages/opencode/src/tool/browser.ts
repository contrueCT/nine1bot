import z from "zod"
import { Tool } from "./tool"
import { getBridgeServer } from "../browser/bridge"
import { Identifier } from "../id/id"
import type { BrowserTarget } from "browser-mcp-server"

function requireBridge() {
  const bridge = getBridgeServer()
  if (!bridge) {
    throw new Error("Browser control not enabled. Enable it in your Nine1Bot config.")
  }
  return bridge
}

const browserParam = z
  .enum(["user", "bot"])
  .optional()
  .describe('Target browser: "user" (Extension-connected browser) or "bot" (server-side Chrome). Omit to auto-detect.')

// ==================== 1. browser_status ====================

export const BrowserStatusTool = Tool.define("browser_status", {
  description: `Query the status of available browsers and their tabs.

Returns:
- user: { connected, tabs } — User's browser connected via Nine1Bot extension
- bot: { running, tabs } — Server-side Chrome instance

Call this first to discover which browsers are available and get tab IDs.`,
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "browser_status",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const bridge = requireBridge()
    const status = await bridge.getStatus()

    const lines: string[] = []

    if (status.user) {
      lines.push(`User Browser: ${status.user.connected ? "Connected" : "Not connected"}`)
      if (status.user.tabs.length > 0) {
        lines.push("  Tabs:")
        for (const tab of status.user.tabs) {
          lines.push(`    [${tab.id}] ${tab.title}\n      ${tab.url}`)
        }
      }
    }

    if (status.bot) {
      lines.push(`Bot Browser: ${status.bot.running ? "Running" : "Not running"}`)
      if (status.bot.tabs.length > 0) {
        lines.push("  Tabs:")
        for (const tab of status.bot.tabs) {
          lines.push(`    [${tab.id}] ${tab.title}\n      ${tab.url}`)
        }
      }
    }

    return {
      title: "Browser status",
      output: lines.join("\n"),
      metadata: {},
    }
  },
})

// ==================== 2. browser_launch ====================

export const BrowserLaunchTool = Tool.define("browser_launch", {
  description: `Launch or check the bot browser (server-side Chrome).

Use this when you need a browser to perform tasks but no browser is available.
If already running, optionally opens a URL in a new tab.`,
  parameters: z.object({
    headless: z.boolean().optional().describe("Run Chrome in headless mode (default: false)"),
    url: z.string().optional().describe("URL to open after launch"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_launch",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const bridge = requireBridge()
    const result = await bridge.launchBotBrowser(params)

    return {
      title: "Bot browser",
      output: result.message,
      metadata: {},
    }
  },
})

// ==================== 3. browser_snapshot ====================

export const BrowserSnapshotTool = Tool.define("browser_snapshot", {
  description: `Get an accessibility tree snapshot of a page. This is the primary way to understand page content and find elements to interact with.

Returns a structured text representation of the page with ref IDs (like ref_abc1234) assigned to each element. Use these ref IDs with browser_click, browser_fill, and other interaction tools.

Parameters:
- tabId: Tab ID (from browser_status)
- filter: "all" (default), "interactive" (buttons, inputs, links only), or "visible"
- depth: Max traversal depth (default: 10)
- refId: Focus on a specific element subtree by its ref ID`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID to snapshot"),
    browser: browserParam,
    filter: z.enum(["all", "interactive", "visible"]).optional().describe("Element filter"),
    depth: z.number().optional().describe("Max depth (default: 10)"),
    refId: z.string().optional().describe("Focus on subtree of this ref"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_snapshot",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    const result = await bridge.snapshot(
      params.tabId,
      { filter: params.filter, depth: params.depth, refId: params.refId },
      params.browser as BrowserTarget | undefined,
    )

    return {
      title: `Snapshot: ${result.title}`,
      output: `Page: ${result.title}\nURL: ${result.url}\n\n${result.snapshot}`,
      metadata: {},
    }
  },
})

// ==================== 4. browser_screenshot ====================

export const BrowserScreenshotTool = Tool.define("browser_screenshot", {
  description: `Capture a screenshot of a browser tab. Use browser_snapshot first for structured content; use this for visual verification.

Parameters:
- tabId: Tab ID (from browser_status)
- fullPage: Capture full page including scrolled content (default: false)`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID to capture"),
    browser: browserParam,
    fullPage: z.boolean().optional().describe("Capture full scrollable page"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_screenshot",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    const result = await bridge.screenshot(
      params.tabId,
      { fullPage: params.fullPage },
      params.browser as BrowserTarget | undefined,
    )

    return {
      title: "Screenshot captured",
      output: "Screenshot captured successfully.",
      metadata: {},
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: result.mimeType,
          url: `data:${result.mimeType};base64,${result.data}`,
        },
      ],
    }
  },
})

// ==================== 5. browser_navigate ====================

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description: `Navigate a browser tab: go to URL, back, forward, reload, or manage tabs.

Parameters:
- tabId: Tab ID (from browser_status)
- action: "goto" (default), "back", "forward", "reload", "new_tab", "close_tab"
- url: Required for "goto" and optional for "new_tab"`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    url: z.string().optional().describe("URL to navigate to (required for goto)"),
    action: z
      .enum(["goto", "back", "forward", "reload", "new_tab", "close_tab"])
      .optional()
      .describe('Navigation action (default: "goto")'),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_navigate",
      patterns: [params.url ?? "*"],
      always: ["*"],
      metadata: { tabId: params.tabId, url: params.url },
    })

    const bridge = requireBridge()
    const result = await bridge.navigate(
      params.tabId,
      { url: params.url, action: params.action },
      params.browser as BrowserTarget | undefined,
    )

    const action = params.action ?? "goto"
    const msg =
      action === "goto"
        ? `Navigated to ${params.url}`
        : action === "new_tab"
          ? `New tab created${result.tabId ? ` (ID: ${result.tabId})` : ""}`
          : `Action: ${action}`

    return {
      title: msg,
      output: msg,
      metadata: { newTabId: result.tabId },
    }
  },
})

// ==================== 6. browser_click ====================

export const BrowserClickTool = Tool.define("browser_click", {
  description: `Click an element on the page.

Use ref (from browser_snapshot) for precise targeting. Falls back to coordinate if ref is not available.

Parameters:
- tabId: Tab ID
- ref: Element ref ID from snapshot (preferred)
- coordinate: [x, y] pixel position (fallback)
- button: "left" (default), "right", "middle"
- clickCount: 1 (default) or 2 for double-click`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    ref: z.string().optional().describe("Element ref ID from snapshot"),
    coordinate: z.tuple([z.number(), z.number()]).optional().describe("[x, y] pixel coordinates"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button"),
    clickCount: z.number().optional().describe("Click count (2 for double-click)"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_click",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId, ref: params.ref },
    })

    const bridge = requireBridge()
    await bridge.clickElement(
      params.tabId,
      {
        ref: params.ref,
        coordinate: params.coordinate,
        button: params.button,
        clickCount: params.clickCount,
      },
      params.browser as BrowserTarget | undefined,
    )

    const target = params.ref ? `ref=${params.ref}` : `(${params.coordinate?.join(", ")})`
    return {
      title: `Clicked ${target}`,
      output: `Clicked ${target}`,
      metadata: {},
    }
  },
})

// ==================== 7. browser_fill ====================

export const BrowserFillTool = Tool.define("browser_fill", {
  description: `Fill a form element (input, textarea, select, contenteditable) by ref ID.

Sets the value directly and dispatches input/change events. More reliable than typing for form fields.

Parameters:
- tabId: Tab ID
- ref: Element ref ID from snapshot
- value: Value to set (string for text inputs, boolean for checkboxes, array for multi-select)`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    ref: z.string().describe("Element ref ID from snapshot"),
    value: z.union([z.string(), z.boolean(), z.array(z.string())]).describe("Value to fill"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_fill",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId, ref: params.ref },
    })

    const bridge = requireBridge()
    const result = await bridge.fillForm(
      params.tabId,
      params.ref,
      params.value,
      params.browser as BrowserTarget | undefined,
    )

    if (!result.success) {
      throw new Error(result.error ?? "Fill failed")
    }

    return {
      title: `Filled ${params.ref}`,
      output: `Set value on ${result.elementType ?? "element"}`,
      metadata: {},
    }
  },
})

// ==================== 8. browser_press_key ====================

export const BrowserPressKeyTool = Tool.define("browser_press_key", {
  description: `Press a key or key combination in a browser tab.

Examples: "Enter", "Tab", "Escape", "Control+A", "Control+Shift+R", "ArrowDown"

Parameters:
- tabId: Tab ID
- key: Key or combination (modifiers joined with +)`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    key: z.string().describe('Key or combination (e.g., "Enter", "Control+A")'),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_press_key",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId, key: params.key },
    })

    const bridge = requireBridge()
    await bridge.pressKey(params.tabId, params.key, params.browser as BrowserTarget | undefined)

    return {
      title: `Pressed ${params.key}`,
      output: `Pressed key: ${params.key}`,
      metadata: {},
    }
  },
})

// ==================== 9. browser_scroll ====================

export const BrowserScrollTool = Tool.define("browser_scroll", {
  description: `Scroll a browser tab in a direction.

Parameters:
- tabId: Tab ID
- direction: "up", "down", "left", or "right"
- amount: Pixels to scroll (default: 300)
- ref: Optional element ref to scroll within`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
    amount: z.number().optional().describe("Pixels to scroll (default: 300)"),
    ref: z.string().optional().describe("Scroll within this element"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_scroll",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    await bridge.scroll(
      params.tabId,
      params.direction,
      params.amount,
      params.ref,
      params.browser as BrowserTarget | undefined,
    )

    return {
      title: `Scrolled ${params.direction}`,
      output: `Scrolled ${params.direction} by ${params.amount ?? 300}px`,
      metadata: {},
    }
  },
})

// ==================== 10. browser_wait ====================

export const BrowserWaitTool = Tool.define("browser_wait", {
  description: `Wait for specific text to appear on the page. Useful after navigation or clicking to confirm the page has loaded.

Parameters:
- tabId: Tab ID
- text: Text to wait for
- timeout: Max wait time in ms (default: 10000)`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    text: z.string().describe("Text to wait for on the page"),
    timeout: z.number().optional().describe("Max wait in ms (default: 10000)"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_wait",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    const found = await bridge.waitForText(
      params.tabId,
      params.text,
      params.timeout,
      params.browser as BrowserTarget | undefined,
    )

    return {
      title: found ? "Text found" : "Timeout",
      output: found
        ? `Text "${params.text}" appeared on the page.`
        : `Timeout: text "${params.text}" did not appear within ${params.timeout ?? 10000}ms.`,
      metadata: { found },
    }
  },
})

// ==================== 11. browser_dialog ====================

export const BrowserDialogTool = Tool.define("browser_dialog", {
  description: `Handle a JavaScript dialog (alert, confirm, prompt, beforeunload).

Parameters:
- action: "accept" or "dismiss"
- promptText: Text to enter for prompt dialogs`,
  parameters: z.object({
    browser: browserParam,
    action: z.enum(["accept", "dismiss"]).describe("Accept or dismiss the dialog"),
    promptText: z.string().optional().describe("Text input for prompt dialogs"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_dialog",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const bridge = requireBridge()
    await bridge.handleDialog(params.action, params.promptText, params.browser as BrowserTarget | undefined)

    return {
      title: `Dialog ${params.action}ed`,
      output: `Dialog ${params.action}ed successfully.`,
      metadata: {},
    }
  },
})

// ==================== 12. browser_find ====================

export const BrowserFindTool = Tool.define("browser_find", {
  description: `Find elements on the page using natural language. Returns matching elements with ref IDs, scored by relevance.

Examples: "search bar", "login button", "submit", "email input"

Parameters:
- tabId: Tab ID
- query: Search query (natural language description or text to find)`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    query: z.string().describe("Natural language query to find elements"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_find",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    const matches = await bridge.findElements(
      params.tabId,
      params.query,
      params.browser as BrowserTarget | undefined,
    )

    if (matches.length === 0) {
      return {
        title: "No matches",
        output: `No elements found matching "${params.query}".`,
        metadata: { matchCount: 0 },
      }
    }

    const lines = matches.map(
      (m, i) =>
        `${i + 1}. [${m.ref}] <${m.tag}>${m.role ? ` role=${m.role}` : ""}${m.label ? ` label="${m.label}"` : ""}\n   ${m.text ? `Text: "${m.text.slice(0, 80)}"` : "(no text)"}   Score: ${m.score}`,
    )

    return {
      title: `Found ${matches.length} element(s)`,
      output: `Found ${matches.length} element(s) matching "${params.query}":\n\n${lines.join("\n\n")}`,
      metadata: { matchCount: matches.length },
    }
  },
})

// ==================== 13. browser_upload ====================

export const BrowserUploadTool = Tool.define("browser_upload", {
  description: `Upload a file to a file input element.

Parameters:
- tabId: Tab ID
- ref: Ref ID of the file input element (from snapshot)
- filePath: Path to the file on the server`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    ref: z.string().describe("Ref ID of the file input element"),
    filePath: z.string().describe("Server-side file path to upload"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_upload",
      patterns: [params.filePath],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    await bridge.uploadFile(
      params.tabId,
      params.ref,
      params.filePath,
      params.browser as BrowserTarget | undefined,
    )

    return {
      title: "File uploaded",
      output: `Uploaded ${params.filePath} to file input.`,
      metadata: {},
    }
  },
})

// ==================== 14. browser_evaluate ====================

export const BrowserEvaluateTool = Tool.define("browser_evaluate", {
  description: `Execute JavaScript in a browser tab. Use this as a fallback for operations not covered by other browser tools (e.g., reading specific DOM properties, complex interactions).

Parameters:
- tabId: Tab ID
- expression: JavaScript code to execute in page context`,
  parameters: z.object({
    tabId: z.string().describe("Tab ID"),
    browser: browserParam,
    expression: z.string().describe("JavaScript to execute"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "browser_evaluate",
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: params.tabId },
    })

    const bridge = requireBridge()
    const result = await bridge.evaluate(
      params.tabId,
      params.expression,
      params.browser as BrowserTarget | undefined,
    )

    const output = result !== undefined ? JSON.stringify(result, null, 2) : "undefined"

    return {
      title: "JavaScript executed",
      output: `Result:\n${output}`,
      metadata: {},
    }
  },
})
