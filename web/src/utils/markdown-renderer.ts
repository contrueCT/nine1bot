import { marked } from 'marked'
import { escapeHtml } from './highlight'

// Keep escaped code markup and copy controls identical in both render paths.
export function createCodeRenderer() {
  const renderer = new marked.Renderer()
  renderer.code = ({ text, lang }) => {
    const language = lang ? escapeHtml(lang.split(/\s/)[0]) : ''
    return `<pre${language ? ` data-lang="${language}"` : ''}><button type="button" class="copy-code" aria-label="复制代码">复制</button><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(text)}</code></pre>`
  }
  return renderer
}

export const ASYNC_MARKDOWN_CHARACTERS = 12_000
// Very large logs remain fully readable/copyable as text without generating an
// unbounded rich-text DOM or sending huge strings through a worker.
export const MAX_RICH_MARKDOWN_CHARACTERS = 100_000

export function markdownRenderMode(length: number, streaming: boolean): 'inline' | 'worker' | 'text' {
  if (length > MAX_RICH_MARKDOWN_CHARACTERS) return 'text'
  if (length <= ASYNC_MARKDOWN_CHARACTERS) return 'inline'
  return streaming ? 'text' : 'worker'
}
