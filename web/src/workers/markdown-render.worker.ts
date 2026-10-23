import { createMarkdownBlockRenderer } from '../utils/markdown-blocks'
import { createCodeRenderer } from '../utils/markdown-renderer'

// Workers have no DOM. The component sanitizes this HTML before insertion.
const render = createMarkdownBlockRenderer({ markedOptions: { renderer: createCodeRenderer() } })
const context = self as unknown as {
  onmessage: (event: MessageEvent<{ id: number; source: string }>) => void
  postMessage(message: { id: number; blocks?: string[]; error?: string }): void
}
context.onmessage = ({ data }) => {
  try {
    context.postMessage({ id: data.id, blocks: render(data.source) })
  } catch {
    context.postMessage({ id: data.id, error: 'Markdown rendering failed' })
  }
}
