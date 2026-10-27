import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const enabled = process.env.RUN_WEB_BROWSER === '1'
if (!enabled) console.info('[web-browser] SKIPPED: set RUN_WEB_BROWSER=1 and CHROME_PATH for real browser coverage')

test.skipIf(!enabled)('REAL browser: production Markdown, terminal and native Blob lifecycles', async () => {
  if (!process.env.CHROME_PATH) throw new Error('CHROME_PATH is required when RUN_WEB_BROWSER=1')
  const { startBrowserFixture } = await import('./browser/fixture-server')
  const fixture = await startBrowserFixture()
  const profile = await mkdtemp(join(tmpdir(), 'nine1bot-web-browser-'))
  let browser: ReturnType<typeof Bun.spawn> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    browser = Bun.spawn([process.env.CHROME_PATH, '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', `--user-data-dir=${profile}`, fixture.url], { stdout: 'ignore', stderr: 'ignore' })
    const report = await Promise.race([
      fixture.completed,
      browser.exited.then(code => { throw new Error(`Chrome exited before reporting results (${code})`) }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Browser regression did not finish within 45s')), 45000) }),
    ])
    console.log(JSON.stringify(report, null, 2))
    expect(report.cases).toHaveLength(9)
    expect(report.cases.filter((item: { passed: boolean }) => !item.passed)).toEqual([])
    expect(report.errors).toEqual([])
    expect(report.passed).toBe(true)
  } finally {
    if (timeout) clearTimeout(timeout)
    browser?.kill()
    if (browser) await browser.exited
    await fixture.close()
    await rm(profile, { recursive: true, force: true })
  }
}, 60000)
