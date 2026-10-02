import open from 'open'
import type { ChildProcess } from 'node:child_process'

type BrowserProcess = Pick<ChildProcess, 'once'>

/** `open` already chooses the platform launcher; xdg-open is Linux-specific. */
export async function openBrowserSafely(
  url: string,
  launch: (url: string) => Promise<BrowserProcess | void> = (target) => open(target, { wait: false }),
  report: (message: string) => void = console.log,
): Promise<void> {
  let reported = false
  const fallback = () => {
    if (reported) return
    reported = true
    report(`Server running at ${url}\nBrowser could not be opened automatically. Open this URL in your browser.`)
  }
  try {
    const child = await launch(url)
    // wait:false resolves after spawn, before a missing executable or URL handler
    // reports failure. Observe those events without waiting for the browser to exit.
    child?.once('error', fallback)
    child?.once('close', (code: number | null) => {
      if (code !== null && code !== 0) fallback()
    })
  } catch {
    fallback()
  }
}
