import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserConfigSchema } from '../../nine1bot/src/config/schema'
import { chromeStartupHint } from '../src/core/chrome'
import { BrowserSettingsPatch, browserReadiness, inspectChromeExecutable, readBrowserSettings } from '../../../opencode/packages/opencode/src/server/nine1bot-browser-settings'
import { clearBridgeServer, setBridgeServer } from '../../../opencode/packages/opencode/src/browser/bridge'

let root: string
let original: string | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nine1-readiness-'))
  original = process.env.NINE1BOT_CONFIG_PATH
  process.env.NINE1BOT_CONFIG_PATH = join(root, 'config.jsonc')
  clearBridgeServer()
})
afterEach(async () => {
  if (original === undefined) delete process.env.NINE1BOT_CONFIG_PATH
  else process.env.NINE1BOT_CONFIG_PATH = original
  clearBridgeServer()
  await rm(root, { recursive: true, force: true })
})
test('accepts absolute Chrome paths with spaces and validates port and path', () => {
  for (const executablePath of ['/opt/My Chrome/chrome', 'C:\\Program Files\\Google\\chrome.exe', '\\\\host\\share\\chrome.exe']) {
    expect(BrowserConfigSchema.parse({ executablePath }).executablePath).toBe(executablePath)
  }
  for (const executablePath of ['chrome', '"/opt/chrome"', '/opt/chrome\n--no-sandbox', '']) {
    expect(BrowserConfigSchema.safeParse({ executablePath }).success).toBe(false)
  }
  for (const cdpPort of [0, 65536, 1.1]) expect(BrowserConfigSchema.safeParse({ cdpPort }).success).toBe(false)
  expect(BrowserSettingsPatch.parse({ executablePath: null })).toEqual({ executablePath: null })
  expect(BrowserSettingsPatch.safeParse({ sidepanel: {} }).success).toBe(false)
})
test('readiness never calls a model or launches Chrome, even with model configuration', async () => {
  await writeFile(process.env.NINE1BOT_CONFIG_PATH!, JSON.stringify({ model: 'fixture/test', customProviders: { secret: { apiKey: 'do-not-return' } }, browser: { executablePath: '/missing-chrome' } }))
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
  try {
    const result = await browserReadiness()
    expect(result.modelConfigured).toBe(true)
    expect(result.modelVerification).toBe('not-tested')
    expect(result.chrome.state).toBe('invalid')
    expect(result.bot).toBe('stopped')
    expect(JSON.stringify(result)).not.toContain('do-not-return')
    expect(fetch).not.toHaveBeenCalled()
  } finally { fetch.mockRestore() }
})
test('inspects file availability without executing it and rejects directories', async () => {
  const file = join(root, 'chrome')
  await writeFile(file, 'not an executable format')
  await chmod(file, 0o700)
  expect((await inspectChromeExecutable(file)).state).toBe('available')
  expect((await inspectChromeExecutable(root)).state).toBe('invalid')
  if (process.platform !== 'win32') {
    await chmod(file, 0o600)
    expect((await inspectChromeExecutable(file)).state).toBe('invalid')
  }
})
test('missing source path is read-only and defaults do not pretend browser is active', async () => {
  delete process.env.NINE1BOT_CONFIG_PATH
  const result = await readBrowserSettings()
  expect(result.writable).toBe(false)
  expect(result.settings.enabled).toBe(false)
})
test('reports saved/runtime mismatch and unknown rather than success on failed status', async () => {
  await writeFile(process.env.NINE1BOT_CONFIG_PATH!, JSON.stringify({ browser: { enabled: true, cdpPort: 9333 } }))
  setBridgeServer({ getStatus: async () => ({ bot: { running: true }, user: { connected: false }, runtime: { configuration: { cdpPort: 9222, autoLaunch: true, headless: false }, issues: [] } }) } as any)
  expect((await browserReadiness()).restartRequired).toBe(true)
  setBridgeServer({ getStatus: async () => { throw new Error('fixture disconnected') } } as any)
  const result = await browserReadiness()
  expect(result.bot).toBe('unknown')
  expect(result.extension).toBe('unknown')
})
test('startup guidance remains actionable without sandbox bypass advice', () => {
  expect(chromeStartupHint('ENOENT')).toContain('browser.executablePath')
  expect(chromeStartupHint('EACCES')).toContain('account')
  expect(chromeStartupHint('No usable sandbox')).toContain('do not disable')
  expect(chromeStartupHint('Missing X server')).toContain('headless')
  expect(chromeStartupHint('CDP endpoint not available')).toContain('port')
})
