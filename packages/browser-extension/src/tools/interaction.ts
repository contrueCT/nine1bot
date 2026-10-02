import type { ToolDefinition, ToolResult } from './index'
import { assertExecutionActive, executionDelay, type ToolExecutionContext } from './execution-context'

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

type OwnedInput = { method: string; release: Record<string, unknown> }

function recordInput(inputs: Map<string, OwnedInput>, method: string, params?: Record<string, unknown>): void {
  if (method === 'Input.dispatchMouseEvent') {
    const key = `mouse:${params?.button ?? 'left'}`
    if (params?.type === 'mousePressed') {
      inputs.set(key, { method, release: { type: 'mouseReleased', x: params.x, y: params.y, button: params.button ?? 'left', clickCount: 0 } })
    } else if (params?.type === 'mouseReleased') {
      inputs.delete(key)
    } else if (params?.type === 'mouseMoved') {
      for (const [name, input] of inputs) {
        if (name.startsWith('mouse:')) Object.assign(input.release, { x: params.x, y: params.y })
      }
    }
  } else if (method === 'Input.dispatchKeyEvent') {
    const key = `key:${params?.key ?? params?.text ?? ''}`
    if (params?.type === 'keyDown') {
      const { text: _text, ...release } = params
      inputs.set(key, { method, release: { ...release, type: 'keyUp' } })
    } else if (params?.type === 'keyUp') {
      inputs.delete(key)
    }
  }
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

async function sendDebuggerCommand(context: ToolExecutionContext | undefined, inputs: Map<string, OwnedInput>, tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  await assertExecutionActive(context)
  await ensureDebuggerAttached(tabId)
  await assertExecutionActive(context)
  const result = await chrome.debugger.sendCommand({ tabId }, method, params)
  recordInput(inputs, method, params)
  return result
}

async function dispatchMouseEvent(
  context: ToolExecutionContext | undefined,
  inputs: Map<string, OwnedInput>,
  tabId: number,
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  x: number,
  y: number,
  button: 'left' | 'middle' | 'right' = 'left',
  clickCount = 1
): Promise<void> {
  const buttonMap = { left: 'left', middle: 'middle', right: 'right' }
  await sendDebuggerCommand(context, inputs, tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: buttonMap[button],
    clickCount,
  })
}

async function getElementCoordinates(tabId: number, ref: string, context?: ToolExecutionContext): Promise<[number, number] | null> {
  await assertExecutionActive(context)
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (refId) => {
      const selector = `[data-mcp-ref="${CSS.escape(refId)}"]`
      const resolve = () => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
          style.visibility !== 'collapse' && style.opacity !== '0' && rect.width > 0 && rect.height > 0
        const left = Math.max(0, rect.x)
        const top = Math.max(0, rect.y)
        const right = Math.min(window.innerWidth, rect.x + rect.width)
        const bottom = Math.min(window.innerHeight, rect.y + rect.height)
        return { element, visible, inViewport: right > left && bottom > top, x: (left + right) / 2, y: (top + bottom) / 2 }
      }
      let target = resolve()
      if (!target) return null
      if (!target.visible) throw new Error(`Element with ref "${refId}" is not visible`)
      if (!target.inViewport) {
        target.element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
        target = resolve()
      }
      if (!target?.visible || !target.inViewport || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
        throw new Error(`Element with ref "${refId}" is not interactable in the viewport after scrolling`)
      }
      return [target.x, target.y]
    },
    args: [ref],
  })

  await assertExecutionActive(context)
  return results[0]?.result as [number, number] | null
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

    const inputs = new Map<string, OwnedInput>()
    let targetTabId: number | undefined
    try {
      await assertExecutionActive(context)

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
        const refCoords = await getElementCoordinates(targetTabId, ref, context)
        if (!refCoords) {
          return {
            content: [{ type: 'text', text: `Error: Element with ref "${ref}" not found` }],
            isError: true,
          }
        }
        coords = refCoords
      }

      await assertExecutionActive(context)
      switch (action) {
        case 'screenshot': {
          // Delegate to screenshot tool
          const { screenshotTool } = await import('./screenshot')
          return screenshotTool.execute({ tabId: targetTabId }, context)
        }

        case 'left_click': {
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mousePressed', x, y, 'left', 1)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseReleased', x, y, 'left', 1)
          return {
            content: [{ type: 'text', text: `Clicked at (${x}, ${y})` }],
          }
        }

        case 'right_click': {
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mousePressed', x, y, 'right', 1)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseReleased', x, y, 'right', 1)
          return {
            content: [{ type: 'text', text: `Right clicked at (${x}, ${y})` }],
          }
        }

        case 'double_click': {
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mousePressed', x, y, 'left', 1)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseReleased', x, y, 'left', 1)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mousePressed', x, y, 'left', 2)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseReleased', x, y, 'left', 2)
          return {
            content: [{ type: 'text', text: `Double clicked at (${x}, ${y})` }],
          }
        }

        case 'middle_click': {
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for click action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', x, y)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mousePressed', x, y, 'middle', 1)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseReleased', x, y, 'middle', 1)
          return {
            content: [{ type: 'text', text: `Middle clicked at (${x}, ${y})` }],
          }
        }

        case 'hover': {
          if (!coords) {
            return {
              content: [{ type: 'text', text: 'Error: coordinate or ref is required for hover action' }],
              isError: true,
            }
          }
          const [x, y] = coords
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', x, y)
          return {
            content: [{ type: 'text', text: `Hovered at (${x}, ${y})` }],
          }
        }

        case 'scroll': {
          const [x, y] = coords || [0, 0]
          const deltaX = scroll_direction === 'left' ? -scroll_amount : scroll_direction === 'right' ? scroll_amount : 0
          const deltaY = scroll_direction === 'up' ? -scroll_amount : scroll_direction === 'down' ? scroll_amount : 0

          await sendDebuggerCommand(context, inputs, targetTabId, 'Input.dispatchMouseEvent', {
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
          if (!text) {
            return {
              content: [{ type: 'text', text: 'Error: text is required for type action' }],
              isError: true,
            }
          }

          // Type each character
          for (const char of text) {
            await sendDebuggerCommand(context, inputs, targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: char,
            })
            await sendDebuggerCommand(context, inputs, targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              text: char,
            })
            // Small delay between keystrokes
            await executionDelay(12, context)
          }
          return {
            content: [{ type: 'text', text: `Typed "${text}"` }],
          }
        }

        case 'key': {
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

            await sendDebuggerCommand(context, inputs, targetTabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: keyCode,
              modifiers: modifiers,
            })
            await sendDebuggerCommand(context, inputs, targetTabId, 'Input.dispatchKeyEvent', {
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
          if (!start_coordinate || !coords) {
            return {
              content: [{ type: 'text', text: 'Error: start_coordinate and coordinate are required for drag action' }],
              isError: true,
            }
          }

          const [startX, startY] = start_coordinate
          const [endX, endY] = coords

          // Move to start, press, move to end, release
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', startX, startY)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mousePressed', startX, startY)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseMoved', endX, endY)
          await dispatchMouseEvent(context, inputs, targetTabId, 'mouseReleased', endX, endY)

          return {
            content: [{ type: 'text', text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})` }],
          }
        }

        case 'wait': {
          const waitTime = duration || 1000
          await executionDelay(waitTime, context)
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
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error performing action: ${errorMessage}` }],
        isError: true,
      }
    } finally {
      // Release only inputs successfully pressed by this command, and only while
      // it retains its target lease. Never move/click a target that has become
      // unmanaged or release an input after a newer command has taken over.
      if (targetTabId !== undefined && context?.releaseOwnedInput) {
        for (const input of inputs.values()) {
          try {
            await context.releaseOwnedInput(input.method, input.release)
          } catch {
            // Already-dispatched input cannot be undone. Cleanup is best-effort
            // and is deliberately skipped once the target boundary is lost.
          }
        }
      }
      inputs.clear()
    }
  },
}
