import type { ToolDefinition, ToolResult } from './index'
import type { ToolExecutionContext } from './execution-context'
import { abortableDelay, isAbortError, throwIfAborted } from './execution-context'

interface ComputerArgs {
  tabId?: number
  action:
    | 'screenshot'
    | 'left_click'
    | 'right_click'
    | 'double_click'
    | 'middle_click'
    | 'scroll'
    | 'type'
    | 'key'
    | 'hover'
    | 'drag'
    | 'wait'
  coordinate?: [number, number]
  ref?: string
  text?: string
  scroll_direction?: 'up' | 'down' | 'left' | 'right'
  scroll_amount?: number
  duration?: number
  start_coordinate?: [number, number]
  modifiers?: string
}

interface RefCoordinateResult {
  coords?: [number, number]
  message?: string
}

// Debugger management
const attachedTabs = new Set<number>()

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return

  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attachedTabs.add(tabId)

    // Listen for debugger detach
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId) {
        attachedTabs.delete(source.tabId)
      }
    })
  } catch (error) {
    // Already attached is OK
    if (!(error instanceof Error && error.message.includes('already attached'))) {
      throw error
    }
    attachedTabs.add(tabId)
  }
}

async function sendDebuggerCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  await ensureDebuggerAttached(tabId)
  return chrome.debugger.sendCommand({ tabId }, method, params)
}

async function dispatchMouseEvent(
  tabId: number,
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  x: number,
  y: number,
  button: 'left' | 'middle' | 'right' = 'left',
  clickCount = 1
): Promise<void> {
  const buttonMap = { left: 'left', middle: 'middle', right: 'right' }
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: buttonMap[button],
    clickCount,
  })
}

async function getElementCoordinates(tabId: number, ref: string): Promise<RefCoordinateResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (refId) => {
      function isVisibleElement(element: Element | null): boolean {
        if (!element) return false
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        const rect = element.getBoundingClientRect()
        return !(rect.width === 0 && rect.height === 0)
      }

      function isDisabledElement(element: Element): boolean {
        return Boolean(
          ('disabled' in element && (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled) ||
          element.getAttribute('disabled') !== null ||
          element.getAttribute('aria-disabled') === 'true'
        )
      }

      function isActionableElement(element: Element | null): boolean {
        if (!element || isDisabledElement(element)) return false

        const tagName = element.tagName.toLowerCase()
        if (tagName === 'a' && (element as HTMLAnchorElement).href) return true
        if (['button', 'input', 'select', 'textarea', 'summary'].includes(tagName)) return true

        const role = (element.getAttribute('role') || '').toLowerCase()
        if (/button|link|checkbox|radio|textbox|combobox|listbox|menuitem|tab|switch/.test(role)) return true

        const tabIndex = element.getAttribute('tabindex')
        if (tabIndex !== null && tabIndex !== '-1') return true

        if (element.getAttribute('onclick') || element.getAttribute('onkeydown') || element.getAttribute('onkeyup')) return true

        return false
      }

      function getActionableScore(element: Element): number {
        if (!isActionableElement(element) || !isVisibleElement(element)) return -1

        const tagName = element.tagName.toLowerCase()
        let score = 0

        if (tagName === 'button') score += 60
        else if (tagName === 'a') score += 55
        else if (tagName === 'input') score += 50
        else if (tagName === 'select' || tagName === 'textarea') score += 45
        else if (tagName === 'summary') score += 35

        const role = (element.getAttribute('role') || '').toLowerCase()
        if (role === 'button' || role === 'link') score += 35
        else if (role) score += 20

        if (element.getAttribute('onclick')) score += 20

        const tabIndex = element.getAttribute('tabindex')
        if (tabIndex !== null && tabIndex !== '-1') score += 10

        if ((element.textContent || '').trim()) score += 5

        return score
      }

      function findBestActionableDescendant(root: Element): Element | null {
        let best: Element | null = null
        let bestScore = -1
        const queue: Array<{ element: Element; depth: number }> = []

        for (const child of root.children) {
          queue.push({ element: child, depth: 1 })
        }

        while (queue.length > 0) {
          const current = queue.shift()
          if (!current) break

          const score = getActionableScore(current.element)
          if (score >= 0) {
            const adjustedScore = score - current.depth * 2
            if (adjustedScore > bestScore) {
              best = current.element
              bestScore = adjustedScore
            }
          }

          for (const child of current.element.children) {
            queue.push({ element: child, depth: current.depth + 1 })
          }
        }

        return best
      }

      function findNearestActionableAncestor(element: Element): Element | null {
        let current = element.parentElement
        while (current) {
          if (getActionableScore(current) >= 0) return current
          current = current.parentElement
        }
        return null
      }

      const element = document.querySelector(`[data-mcp-ref="${refId}"]`)
      if (!element) {
        const hasAnyRefs = Boolean(document.querySelector('[data-mcp-ref]'))
        return {
          message: hasAnyRefs
            ? `Element with ref "${refId}" not found. This ref is likely stale after a later snapshot/find call or a DOM re-render. Re-run browser_snapshot/browser_find before interacting.`
            : `Element with ref "${refId}" not found and the page currently has no ref markers. Run browser_snapshot/browser_find before interacting, or re-snapshot after navigation.`,
        }
      }

      let target: Element = element
      if (getActionableScore(element) < 0) {
        target = findBestActionableDescendant(element) || findNearestActionableAncestor(element) || element
      }

      const rect = target.getBoundingClientRect()
      return {
        coords: [rect.x + rect.width / 2, rect.y + rect.height / 2] as [number, number],
      }
    },
    args: [ref],
  })

  return (results[0]?.result as RefCoordinateResult | undefined) || {}
}

export const computerTool = {
  definition: {
    name: 'computer',
    description:
      'Use a mouse and keyboard to interact with a web browser. Supports clicking, typing, scrolling, and more. Provide either coordinate [x, y] or ref (element reference) for targeting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to interact with. If not provided, uses the active tab.',
        },
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'middle_click', 'scroll', 'type', 'key', 'hover', 'drag', 'wait'],
          description: 'The action to perform.',
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          description: 'The [x, y] coordinate for the action. Required for coordinate-based interactions.',
        },
        ref: {
          type: 'string',
          description: 'Element reference ID (from read_page or find). Alternative to coordinate.',
        },
        text: {
          type: 'string',
          description: 'Text to type (for "type" action) or key combination (for "key" action, e.g., "Enter", "Control+c").',
        },
        scroll_direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Direction to scroll (for "scroll" action).',
        },
        scroll_amount: {
          type: 'number',
          description: 'Amount to scroll in pixels. Default is 300.',
        },
        duration: {
          type: 'number',
          description: 'Wait duration in milliseconds (for "wait" action).',
        },
        start_coordinate: {
          type: 'array',
          items: { type: 'number' },
          description: 'Starting [x, y] coordinate for drag action.',
        },
        modifiers: {
          type: 'string',
          description: 'Modifier keys to hold during action (e.g., "Control", "Shift", "Alt").',
        },
      },
      required: ['action'],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const {
      tabId,
      action,
      coordinate,
      ref,
      text,
      scroll_direction,
      scroll_amount = 300,
      duration,
      start_coordinate,
      modifiers,
    } = args as ComputerArgs

    try {
      throwIfAborted(context?.signal)
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

      // Resolve coordinates from ref if provided
      let coords: [number, number] | undefined = coordinate

      if (ref && !coords) {
        const resolution = await getElementCoordinates(targetTabId, ref)
        if (!resolution.coords) {
          return {
            content: [{ type: 'text', text: `Error: ${resolution.message || `Element with ref "${ref}" not found`}` }],
            isError: true,
          }
        }
        coords = resolution.coords
      }

      switch (action) {
        case 'screenshot': {
          // Delegate to screenshot tool
          const { screenshotTool } = await import('./screenshot')
          return screenshotTool.execute({ tabId: targetTabId })
        }

        case 'left_click': {
          throwIfAborted(context?.signal)
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(targetTabId, 'mousePressed', x, y, 'left', 1)
          await dispatchMouseEvent(targetTabId, 'mouseReleased', x, y, 'left', 1)
          return {
            content: [{ type: 'text', text: `Clicked at (${x}, ${y})` }],
          }
        }

        case 'right_click': {
          throwIfAborted(context?.signal)
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(targetTabId, 'mousePressed', x, y, 'right', 1)
          await dispatchMouseEvent(targetTabId, 'mouseReleased', x, y, 'right', 1)
          return {
            content: [{ type: 'text', text: `Right clicked at (${x}, ${y})` }],
          }
        }

        case 'double_click': {
          throwIfAborted(context?.signal)
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(targetTabId, 'mousePressed', x, y, 'left', 1)
          await dispatchMouseEvent(targetTabId, 'mouseReleased', x, y, 'left', 1)
          await dispatchMouseEvent(targetTabId, 'mousePressed', x, y, 'left', 2)
          await dispatchMouseEvent(targetTabId, 'mouseReleased', x, y, 'left', 2)
          return {
            content: [{ type: 'text', text: `Double clicked at (${x}, ${y})` }],
          }
        }

        case 'middle_click': {
          throwIfAborted(context?.signal)
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(targetTabId, 'mousePressed', x, y, 'middle', 1)
          await dispatchMouseEvent(targetTabId, 'mouseReleased', x, y, 'middle', 1)
          return {
            content: [{ type: 'text', text: `Middle clicked at (${x}, ${y})` }],
          }
        }

        case 'hover': {
          throwIfAborted(context?.signal)
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for hover action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(targetTabId, 'mouseMoved', x, y)
          return {
            content: [{ type: 'text', text: `Hovered at (${x}, ${y})` }],
          }
        }

        case 'scroll': {
          throwIfAborted(context?.signal)
          const [x, y] = coords || [0, 0]
          const deltaX = scroll_direction === 'left' ? -scroll_amount : scroll_direction === 'right' ? scroll_amount : 0
          const deltaY = scroll_direction === 'up' ? -scroll_amount : scroll_direction === 'down' ? scroll_amount : 0

          await sendDebuggerCommand(targetTabId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x,
            y,
            deltaX,
            deltaY,
          })
          return {
            content: [{ type: 'text', text: `Scrolled ${scroll_direction} by ${scroll_amount}px` }],
          }
        }

        case 'type': {
          throwIfAborted(context?.signal)
          if (!text) {
            return {
              content: [{ type: 'text', text: 'Error: text is required for type action' }],
              isError: true,
            }
          }

          // Type each character
          for (const char of text) {
            throwIfAborted(context?.signal)
            await sendDebuggerCommand(targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: char,
            })
            await sendDebuggerCommand(targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              text: char,
            })
            // Small delay between keystrokes
            await abortableDelay(12, context?.signal)
          }
          return {
            content: [{ type: 'text', text: `Typed "${text}"` }],
          }
        }

        case 'key': {
          throwIfAborted(context?.signal)
          if (!text) {
            return {
              content: [{ type: 'text', text: 'Error: text (key combination) is required for key action' }],
              isError: true,
            }
          }

          // Parse key combination (e.g., "Control+c", "Enter")
          const keys = text.split('+')
          const modifierFlags: number[] = []

          for (const key of keys) {
            throwIfAborted(context?.signal)
            const keyLower = key.toLowerCase()
            let keyCode: string
            let modifiers = 0

            // Map common key names
            const keyMap: Record<string, string> = {
              enter: 'Enter',
              tab: 'Tab',
              escape: 'Escape',
              backspace: 'Backspace',
              delete: 'Delete',
              arrowup: 'ArrowUp',
              arrowdown: 'ArrowDown',
              arrowleft: 'ArrowLeft',
              arrowright: 'ArrowRight',
              home: 'Home',
              end: 'End',
              pageup: 'PageUp',
              pagedown: 'PageDown',
              control: 'Control',
              alt: 'Alt',
              shift: 'Shift',
              meta: 'Meta',
            }

            keyCode = keyMap[keyLower] || key

            // Check if it's a modifier key
            if (['control', 'alt', 'shift', 'meta'].includes(keyLower)) {
              continue // Will be handled as modifier
            }

            await sendDebuggerCommand(targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: keyCode,
              modifiers: modifiers,
            })
            await sendDebuggerCommand(targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: keyCode,
              modifiers: modifiers,
            })
          }

          return {
            content: [{ type: 'text', text: `Pressed key: ${text}` }],
          }
        }

        case 'drag': {
          throwIfAborted(context?.signal)
          if (!start_coordinate || !coords) {
            return {
              content: [{ type: 'text', text: 'Error: start_coordinate and coordinate are required for drag action' }],
              isError: true,
            }
          }

          const [startX, startY] = start_coordinate
          const [endX, endY] = coords

          // Move to start, press, move to end, release
          await dispatchMouseEvent(targetTabId, 'mouseMoved', startX, startY)
          await dispatchMouseEvent(targetTabId, 'mousePressed', startX, startY)
          await dispatchMouseEvent(targetTabId, 'mouseMoved', endX, endY)
          await dispatchMouseEvent(targetTabId, 'mouseReleased', endX, endY)

          return {
            content: [{ type: 'text', text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})` }],
          }
        }

        case 'wait': {
          throwIfAborted(context?.signal)
          const waitTime = duration || 1000
          await abortableDelay(waitTime, context?.signal)
          return {
            content: [{ type: 'text', text: `Waited ${waitTime}ms` }],
          }
        }

        default:
          return {
            content: [{ type: 'text', text: `Error: Unknown action "${action}"` }],
            isError: true,
          }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return {
          content: [{ type: 'text', text: 'Cancelled' }],
          isError: true,
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error performing action: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}
