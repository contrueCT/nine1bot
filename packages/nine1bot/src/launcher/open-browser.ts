import open from 'open'

/** `open` already chooses the platform launcher; xdg-open is Linux-specific. */
export async function openBrowserSafely(
  url: string,
  launch: (url: string) => Promise<unknown> = (target) => open(target, { wait: false }),
  report: (message: string) => void = console.log,
): Promise<void> {
  try {
    await launch(url)
  } catch {
    report(`Server running at ${url}\nBrowser could not be opened automatically. Open this URL in your browser.`)
  }
}
