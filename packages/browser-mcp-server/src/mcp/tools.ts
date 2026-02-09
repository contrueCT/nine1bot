/**
 * MCP Tool definitions for browser control
 * Each tool calls BridgeServer methods directly (no HTTP hop)
 */

import { z } from 'zod'

export const TOOL_DEFINITIONS = {
  browser_tabs: {
    description: `List all browser tabs that can be controlled.
Returns information about each tab including its ID, title, and URL.
Use this tool first to discover available tabs before performing operations.
The browser must have the Nine1Bot Browser Control extension installed and connected.`,
    schema: z.object({}),
  },

  browser_screenshot: {
    description: `Capture a screenshot of a browser tab.
Returns the screenshot as a base64-encoded PNG image.
Parameters:
- tabId: The ID of the tab to capture (get from browser_tabs tool)
- fullPage: If true, capture the full scrollable page (optional, default: false)`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab to capture'),
      fullPage: z.boolean().optional().describe('Capture full scrollable page'),
    }),
  },

  browser_navigate: {
    description: `Navigate a browser tab to a specific URL.
Parameters:
- tabId: The ID of the tab to navigate (get from browser_tabs tool)
- url: The URL to navigate to (must include protocol, e.g. https://)`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab to navigate'),
      url: z.string().describe('The URL to navigate to'),
    }),
  },

  browser_click: {
    description: `Click at specific coordinates in a browser tab.
Use browser_screenshot first to identify the coordinates of the element you want to click.
Parameters:
- tabId: The ID of the tab to click in (get from browser_tabs tool)
- x: X coordinate (pixels from left)
- y: Y coordinate (pixels from top)
- button: Mouse button ('left', 'right', or 'middle', default: 'left')`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
      clickCount: z.number().optional().describe('Number of clicks'),
    }),
  },

  browser_type: {
    description: `Type text into the currently focused element in a browser tab.
Click on an input field first using browser_click, then use this tool to type text.
Parameters:
- tabId: The ID of the tab to type in (get from browser_tabs tool)
- text: The text to type`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
      text: z.string().describe('The text to type'),
    }),
  },

  browser_evaluate: {
    description: `Execute JavaScript code in a browser tab and return the result.
Parameters:
- tabId: The ID of the tab to execute in (get from browser_tabs tool)
- expression: JavaScript expression to evaluate`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
      expression: z.string().describe('JavaScript expression to evaluate'),
    }),
  },

  browser_content: {
    description: `Get the HTML content, title, and URL of a browser tab.
Parameters:
- tabId: The ID of the tab to get content from (get from browser_tabs tool)`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
    }),
  },
  // ==================== Extension-powered tools (CSP-safe) ====================

  browser_read_page: {
    description: `Get an accessibility tree representation of elements on the page. Returns structured JSON with element info including ref IDs that can be used with browser_computer and browser_form_input.
Much more useful than browser_content for understanding page structure.
Requires the Chrome extension to be connected.
Parameters:
- tabId: The ID of the tab to read
- depth: Maximum traversal depth (default: 10)
- filter: 'all' (default), 'interactive' (buttons/inputs/links only), or 'visible'
- ref_id: Focus on a specific element subtree by ref ID
- max_chars: Maximum output characters (default: 50000)`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab to read'),
      depth: z.number().optional().describe('Max traversal depth (default: 10)'),
      filter: z.enum(['all', 'interactive', 'visible']).optional().describe('Element filter'),
      ref_id: z.string().optional().describe('Focus on element subtree by ref ID'),
      max_chars: z.number().optional().describe('Max output chars (default: 50000)'),
    }),
  },

  browser_find: {
    description: `Find elements on the page using natural language search. Returns matching elements with their ref IDs and bounding box coordinates, which can be used for clicking or form input.
Searches across text content, aria-labels, roles, IDs, class names, and tag names.
Requires the Chrome extension to be connected.
Parameters:
- tabId: The ID of the tab to search
- query: Search text (e.g. "login button", "search bar", "submit")`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab to search'),
      query: z.string().describe('Natural language search query'),
    }),
  },

  browser_get_text: {
    description: `Extract clean text content from a browser tab, prioritizing article/main content. Much lighter than browser_content - returns plain text without HTML markup.
Requires the Chrome extension to be connected.
Parameters:
- tabId: The ID of the tab to extract text from`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
    }),
  },

  browser_form_input: {
    description: `Set values in form elements using a ref ID from browser_read_page or browser_find. Works with input, textarea, select, checkbox, radio, and contenteditable elements.
Requires the Chrome extension to be connected.
Parameters:
- tabId: The ID of the tab
- ref: Element reference ID (from browser_read_page or browser_find)
- value: The value to set (string, number, boolean, or array for multi-select)`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
      ref: z.string().describe('Element ref ID from browser_read_page or browser_find'),
      value: z.any().describe('Value to set'),
    }),
  },

  browser_computer: {
    description: `Advanced browser interaction tool. Supports clicking, scrolling, typing, key combinations, hovering, and dragging. Can target elements by coordinate or ref ID.
Requires the Chrome extension to be connected.
Parameters:
- tabId: The ID of the tab
- action: One of: left_click, right_click, double_click, middle_click, scroll, type, key, hover, drag, wait
- coordinate: [x, y] pixel coordinates (alternative to ref)
- ref: Element ref ID from browser_read_page/browser_find (alternative to coordinate)
- text: Text to type (for 'type' action) or key combo (for 'key' action, e.g. "Enter", "Control+c")
- scroll_direction: up/down/left/right (for 'scroll' action)
- scroll_amount: Pixels to scroll (default: 300)
- start_coordinate: Starting [x, y] for drag action
- duration: Wait time in ms (for 'wait' action)`,
    schema: z.object({
      tabId: z.string().describe('The ID of the tab'),
      action: z.enum(['left_click', 'right_click', 'double_click', 'middle_click', 'scroll', 'type', 'key', 'hover', 'drag', 'wait']).describe('Action to perform'),
      coordinate: z.array(z.number()).optional().describe('[x, y] pixel coordinates'),
      ref: z.string().optional().describe('Element ref ID (alternative to coordinate)'),
      text: z.string().optional().describe('Text to type or key combo'),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction'),
      scroll_amount: z.number().optional().describe('Scroll amount in pixels'),
      duration: z.number().optional().describe('Wait duration in ms'),
      start_coordinate: z.array(z.number()).optional().describe('Start [x,y] for drag'),
      modifiers: z.string().optional().describe('Modifier keys (Control, Shift, Alt)'),
    }),
  },
} as const
