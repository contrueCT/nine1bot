import type { ToolDefinition, ToolResult } from './index'

interface FormInputArgs {
  tabId?: number
  ref: string
  value: unknown
}

export const formInputTool = {
  definition: {
    name: 'form_input',
    description: 'Set values in form elements using element reference ID from the read_page tool. Works with input, textarea, select, and contenteditable elements.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab containing the form. If not provided, uses the active tab.',
        },
        ref: {
          type: 'string',
          description: 'The element reference ID from read_page or find tool.',
        },
        value: {
          description: 'The value to set. Can be a string, number, boolean, or array (for multi-select).',
        },
      },
      required: ['ref', 'value'],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { tabId, ref, value } = args as FormInputArgs

    if (!ref) {
      return {
        content: [{ type: 'text', text: 'Error: ref is required' }],
        isError: true,
      }
    }

    if (value === undefined) {
      return {
        content: [{ type: 'text', text: 'Error: value is required' }],
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
        func: (refId, inputValue) => {
          const element = document.querySelector(`[data-mcp-ref="${refId}"]`)

          if (!element) {
            return { success: false, error: `Element with ref "${refId}" not found` }
          }

          try {
            // Handle different element types
            if (element instanceof HTMLInputElement) {
              const inputType = element.type.toLowerCase()

              if (inputType === 'checkbox') {
                element.checked = Boolean(inputValue)
                element.dispatchEvent(new Event('change', { bubbles: true }))
              } else if (inputType === 'radio') {
                element.checked = Boolean(inputValue)
                element.dispatchEvent(new Event('change', { bubbles: true }))
              } else if (inputType === 'file') {
                return { success: false, error: 'Cannot set file input value programmatically' }
              } else {
                // Text, number, email, password, etc.
                element.value = String(inputValue)
                element.dispatchEvent(new Event('input', { bubbles: true }))
                element.dispatchEvent(new Event('change', { bubbles: true }))
              }
            } else if (element instanceof HTMLTextAreaElement) {
              element.value = String(inputValue)
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
            } else if (element instanceof HTMLSelectElement) {
              if (Array.isArray(inputValue)) {
                // Multi-select
                for (const option of element.options) {
                  option.selected = inputValue.includes(option.value)
                }
              } else {
                element.value = String(inputValue)
              }
              element.dispatchEvent(new Event('change', { bubbles: true }))
            } else if (element.getAttribute('contenteditable') === 'true') {
              element.textContent = String(inputValue)
              element.dispatchEvent(new Event('input', { bubbles: true }))
            } else {
              // Try to set value property anyway
              ;(element as HTMLInputElement).value = String(inputValue)
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
            }

            return {
              success: true,
              elementType: element.tagName.toLowerCase(),
              inputType: (element as HTMLInputElement).type || undefined,
            }
          } catch (e) {
            return { success: false, error: String(e) }
          }
        },
        args: [ref, value],
      })

      const result = results[0]?.result as { success: boolean; error?: string; elementType?: string; inputType?: string }

      if (!result || !result.success) {
        return {
          content: [{ type: 'text', text: `Error: ${result?.error || 'Unknown error setting form value'}` }],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Set value on ${result.elementType}${result.inputType ? `[type=${result.inputType}]` : ''} element`,
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error setting form value: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}
