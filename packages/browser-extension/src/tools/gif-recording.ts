import type { ToolDefinition, ToolResult } from './index'
import type { ToolExecutionContext } from './execution-context'
import { isAbortError, throwIfAborted } from './execution-context'

type GifAction = 'start' | 'frame' | 'stop' | 'export' | 'clear' | 'play_sound'

interface GifRecordingArgs {
  action: GifAction
  id?: string
  dataUrl?: string
  data?: string
  mimeType?: string
  label?: string
  timestamp?: number
  sound?: 'success' | 'error' | 'confirm'
}
async function ensureOffscreenDocument(): Promise<void> {
  const hasDocument = typeof chrome.offscreen.hasDocument === 'function' ? await chrome.offscreen.hasDocument() : false
  if (hasDocument) return

  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Nine1Bot records visual steps and plays completion/error sounds.',
  })
}

async function sendOffscreenCommand(command: string, payload: Record<string, unknown>): Promise<any> {
  const response = await chrome.runtime.sendMessage({
    type: 'nine1bot-offscreen-command',
    command,
    payload,
  })
  if (!response?.ok) {
    throw new Error(response?.error || `Offscreen command failed: ${command}`)
  }
  return response
}

function normalizeDataUrl(args: GifRecordingArgs): string {
  if (typeof args.dataUrl === 'string' && args.dataUrl.trim()) return args.dataUrl
  if (typeof args.data === 'string' && args.data.trim()) {
    const mimeType = typeof args.mimeType === 'string' && args.mimeType.trim() ? args.mimeType : 'image/png'
    return `data:${mimeType};base64,${args.data}`
  }
  return ''
}

export const gifRecordingTool = {
  definition: {
    name: 'gif_recording',
    description: 'Record step frames and export minimal replay metadata via Offscreen document. Also supports notification sound playback.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'frame', 'stop', 'export', 'clear', 'play_sound'],
          description: 'Recording action.',
        },
        id: { type: 'string', description: 'Recording ID.' },
        dataUrl: { type: 'string', description: 'Frame image Data URL for frame action.' },
        data: { type: 'string', description: 'Frame image as base64 string (alternative to dataUrl).' },
        mimeType: { type: 'string', description: 'MIME type for base64 frame data (default image/png).' },
        label: { type: 'string', description: 'Optional step label for frame.' },
        timestamp: { type: 'number', description: 'Frame timestamp in ms.' },
        sound: { type: 'string', enum: ['success', 'error', 'confirm'], description: 'Sound kind for play_sound.' },
      },
      required: ['action'],
    },
  } satisfies ToolDefinition,

  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const args = (rawArgs || {}) as GifRecordingArgs

    try {
      throwIfAborted(context?.signal)
      await ensureOffscreenDocument()
      throwIfAborted(context?.signal)

      const recordingId = args.id || `recording_${Date.now()}`

      if (args.action === 'start') {
        const result = await sendOffscreenCommand('record-start', { id: recordingId })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      if (args.action === 'frame') {
        const dataUrl = normalizeDataUrl(args)
        if (!dataUrl) {
          return { content: [{ type: 'text', text: 'Error: dataUrl or data is required for frame action' }], isError: true }
        }
        const result = await sendOffscreenCommand('record-frame', {
          id: recordingId,
          dataUrl,
          label: args.label,
          timestamp: args.timestamp,
        })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      if (args.action === 'stop') {
        const result = await sendOffscreenCommand('record-stop', { id: recordingId })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      if (args.action === 'export') {
        const result = await sendOffscreenCommand('record-export-gif', { id: recordingId })
        const content: ToolResult['content'] = [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ]
        if (typeof result.previewDataUrl === 'string' && result.previewDataUrl.startsWith('data:image/')) {
          const commaIndex = result.previewDataUrl.indexOf(',')
          if (commaIndex > 0) {
            const meta = result.previewDataUrl.slice(5, commaIndex)
            const data = result.previewDataUrl.slice(commaIndex + 1)
            const mimeType = meta.split(';')[0] || 'image/png'
            content.push({ type: 'image', data, mimeType })
          }
        }
        return { content }
      }

      if (args.action === 'clear') {
        const result = await sendOffscreenCommand('record-clear', { id: recordingId })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      if (args.action === 'play_sound') {
        const result = await sendOffscreenCommand('play-sound', { sound: args.sound || 'success' })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      return { content: [{ type: 'text', text: `Error: Unsupported action ${String(args.action)}` }], isError: true }
    } catch (error) {
      if (isAbortError(error)) {
        return { content: [{ type: 'text', text: 'Cancelled' }], isError: true }
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error in gif_recording: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}
