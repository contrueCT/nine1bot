import type { ToolDefinition, ToolResult } from './index'

interface ReadPageArgs {
  tabId?: number
  depth?: number
  filter?: 'all' | 'interactive' | 'visible'
  ref_id?: string
  max_chars?: number
}

interface GetPageTextArgs {
  tabId?: number
}

interface FindArgs {
  tabId?: number
  query: string
}

// Element reference counter for unique IDs
let refCounter = 0
const refMap = new Map<string, string>() // ref -> selector

function generateRef(): string {
  return `ref_${++refCounter}`
}

// Inject content script function to read DOM
async function readDOMFromTab(
  tabId: number,
  options: { depth: number; filter: string; refId?: string; maxChars: number }
): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => {
      const { depth, filter, refId, maxChars } = opts

      function getAccessibilityInfo(element: Element): Record<string, unknown> | null {
        const tagName = element.tagName.toLowerCase()
        const role = element.getAttribute('role') || getImplicitRole(tagName)
        const label =
          element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          element.getAttribute('alt') ||
          (element as HTMLInputElement).placeholder ||
          ''
        const text = element.textContent?.slice(0, 100)?.trim() || ''

        // Generate a unique ref for this element
        const ref = `ref_${Math.random().toString(36).slice(2, 9)}`
        element.setAttribute('data-mcp-ref', ref)

        const info: Record<string, unknown> = {
          tag: tagName,
          ref,
        }

        if (role) info.role = role
        if (label) info.label = label
        if (text && text !== label) info.text = text

        // Add specific attributes based on element type
        if (element instanceof HTMLInputElement) {
          info.type = element.type
          info.value = element.value
          info.name = element.name
        }
        if (element instanceof HTMLAnchorElement) {
          info.href = element.href
        }
        if (element instanceof HTMLButtonElement) {
          info.disabled = element.disabled
        }
        if (element.id) info.id = element.id
        if (element.className) info.class = element.className

        return info
      }

      function getImplicitRole(tagName: string): string {
        const roleMap: Record<string, string> = {
          a: 'link',
          button: 'button',
          input: 'textbox',
          select: 'combobox',
          textarea: 'textbox',
          img: 'img',
          h1: 'heading',
          h2: 'heading',
          h3: 'heading',
          h4: 'heading',
          h5: 'heading',
          h6: 'heading',
          nav: 'navigation',
          main: 'main',
          aside: 'complementary',
          footer: 'contentinfo',
          header: 'banner',
          form: 'form',
          table: 'table',
          ul: 'list',
          ol: 'list',
          li: 'listitem',
        }
        return roleMap[tagName] || ''
      }

      function isInteractive(element: Element): boolean {
        const tagName = element.tagName.toLowerCase()
        const interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']
        if (interactiveTags.includes(tagName)) return true
        if (element.getAttribute('role')?.match(/button|link|checkbox|radio|textbox|combobox|listbox|menu|menuitem|tab|switch/))
          return true
        if (element.getAttribute('tabindex')) return true
        if (element.getAttribute('onclick') || element.getAttribute('onkeydown')) return true
        return false
      }

      function isVisible(element: Element): boolean {
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return false
        return true
      }

      function traverse(element: Element, currentDepth: number): Record<string, unknown> | null {
        if (currentDepth > depth) return null

        if (filter === 'visible' && !isVisible(element)) return null
        if (filter === 'interactive' && !isInteractive(element) && currentDepth > 0) {
          // Still traverse children for interactive filter
          const children: Array<Record<string, unknown>> = []
          for (const child of element.children) {
            const childInfo = traverse(child, currentDepth)
            if (childInfo) children.push(childInfo)
          }
          if (children.length === 0) return null
          return { children }
        }

        const info = getAccessibilityInfo(element)
        if (!info) return null

        if (currentDepth < depth) {
          const children: Array<Record<string, unknown>> = []
          for (const child of element.children) {
            const childInfo = traverse(child, currentDepth + 1)
            if (childInfo) children.push(childInfo)
          }
          if (children.length > 0) info.children = children
        }

        return info
      }

      let rootElement: Element | null = document.body
      if (refId) {
        rootElement = document.querySelector(`[data-mcp-ref="${refId}"]`)
        if (!rootElement) {
          return JSON.stringify({ error: `Element with ref "${refId}" not found` })
        }
      }

      const result = traverse(rootElement, 0)
      const jsonString = JSON.stringify(result, null, 2)

      if (jsonString.length > maxChars) {
        return JSON.stringify({
          error: `Output exceeds ${maxChars} characters. Please specify a smaller depth or focus on a specific element using ref_id.`,
          truncated: true,
          actualLength: jsonString.length,
        })
      }

      return jsonString
    },
    args: [options],
  })

  return results[0]?.result as string
}

export const readPageTool = {
  definition: {
    name: 'read_page',
    description:
      'Get an accessibility tree representation of elements on the page. By default returns all elements. Output is limited to 50000 characters. Optionally filter for only interactive elements.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to read. If not provided, uses the active tab.',
        },
        depth: {
          type: 'number',
          description: 'Maximum depth to traverse. Default is 10.',
        },
        filter: {
          type: 'string',
          enum: ['all', 'interactive', 'visible'],
          description: 'Filter elements: "all" (default), "interactive" (only interactive elements), or "visible" (only visible elements).',
        },
        ref_id: {
          type: 'string',
          description: 'Focus on a specific element by its ref ID.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters in output. Default is 50000.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { tabId, depth = 10, filter = 'all', ref_id, max_chars = 50000 } = (args as ReadPageArgs) || {}

    try {
      let targetTabId: number

      if (tabId !== undefined) {
        targetTabId = tabId
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!activeTab?.id) {
          return {
            content: [{ type: 'text', text: 'Error: No active tab found' }],
            isError: true,
          }
        }
        targetTabId = activeTab.id
      }

      const result = await readDOMFromTab(targetTabId, {
        depth,
        filter,
        refId: ref_id,
        maxChars: max_chars,
      })

      return {
        content: [{ type: 'text', text: result }],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error reading page: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}

export const getPageTextTool = {
  definition: {
    name: 'get_page_text',
    description: 'Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to read. If not provided, uses the active tab.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { tabId } = (args as GetPageTextArgs) || {}

    try {
      let targetTabId: number

      if (tabId !== undefined) {
        targetTabId = tabId
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!activeTab?.id) {
          return {
            content: [{ type: 'text', text: 'Error: No active tab found' }],
            isError: true,
          }
        }
        targetTabId = activeTab.id
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: () => {
          // Try to find article content first
          const article = document.querySelector('article') || document.querySelector('[role="main"]') || document.querySelector('main')

          const root = article || document.body

          // Remove script and style elements from consideration
          const clone = root.cloneNode(true) as Element
          clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove())

          return clone.textContent?.trim() || ''
        },
      })

      const text = results[0]?.result as string

      return {
        content: [{ type: 'text', text: text || 'No text content found' }],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error getting page text: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}

export const findTool = {
  definition: {
    name: 'find',
    description:
      'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to search. If not provided, uses the active tab.',
        },
        query: {
          type: 'string',
          description: 'The search query - can be a natural language description or text to find.',
        },
      },
      required: ['query'],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { tabId, query } = args as FindArgs

    if (!query) {
      return {
        content: [{ type: 'text', text: 'Error: query is required' }],
        isError: true,
      }
    }

    try {
      let targetTabId: number

      if (tabId !== undefined) {
        targetTabId = tabId
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!activeTab?.id) {
          return {
            content: [{ type: 'text', text: 'Error: No active tab found' }],
            isError: true,
          }
        }
        targetTabId = activeTab.id
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (searchQuery) => {
          const matches: Array<{
            ref: string
            tag: string
            text?: string
            label?: string
            role?: string
            rect: { x: number; y: number; width: number; height: number }
          }> = []

          const queryLower = searchQuery.toLowerCase()

          // Search all elements
          const elements = document.querySelectorAll('*')

          for (const element of elements) {
            const tagName = element.tagName.toLowerCase()

            // Skip non-visible elements
            const style = window.getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden') continue

            const rect = element.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) continue

            // Check various attributes for matches
            const text = element.textContent?.slice(0, 200)?.toLowerCase() || ''
            const label =
              element.getAttribute('aria-label')?.toLowerCase() ||
              element.getAttribute('title')?.toLowerCase() ||
              element.getAttribute('placeholder')?.toLowerCase() ||
              ''
            const role = element.getAttribute('role')?.toLowerCase() || ''
            const id = element.id?.toLowerCase() || ''
            const className = element.className?.toString?.()?.toLowerCase() || ''

            // Check for match
            const isMatch =
              text.includes(queryLower) ||
              label.includes(queryLower) ||
              role.includes(queryLower) ||
              id.includes(queryLower) ||
              className.includes(queryLower) ||
              tagName.includes(queryLower)

            if (isMatch) {
              const ref = `ref_${Math.random().toString(36).slice(2, 9)}`
              element.setAttribute('data-mcp-ref', ref)

              matches.push({
                ref,
                tag: tagName,
                text: element.textContent?.slice(0, 100)?.trim(),
                label: element.getAttribute('aria-label') || element.getAttribute('title') || undefined,
                role: element.getAttribute('role') || undefined,
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              })

              if (matches.length >= 20) break
            }
          }

          return matches
        },
        args: [query],
      })

      const matches = results[0]?.result as Array<unknown>

      if (!matches || matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No elements found matching "${query}"` }],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Found ${matches.length} element(s):\n${JSON.stringify(matches, null, 2)}`,
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error finding elements: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}
