import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as os from 'node:os'
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
  await writeFile(process.env.NINE1BOT_CONFIG_PATH!, JSON.stringify({ model: 'fixture/test', customProviders: { secret: { name: 'fixture', protocol: 'openai', baseURL: 'https://example.invalid', models: [{ id: 'fixture' }], apiKey: 'do-not-return' } }, browser: { executablePath: '/missing-chrome' } }))
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

test('layered settings match startup; partial saves preserve inheritance and source env expressions', async () => {
  const { getGlobalConfigPath, loadConfig } = await import('../../nine1bot/src/config/loader')
  const { mkdir, readFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const { patchBrowserSettings } = await import('../../../opencode/packages/opencode/src/server/nine1bot-browser-settings')
  const homeMock = spyOn(os, 'homedir').mockReturnValue(root)
  const envPath = process.env.CHROME_EXEC
  process.env.CHROME_EXEC = '/opt/Environment Chrome/chrome'
  try {
    const global = getGlobalConfigPath()
    await mkdir(dirname(global), { recursive: true })
    await writeFile(global, JSON.stringify({ model: 'global/model', browser: { enabled: true, cdpPort: 9444, executablePath: '/opt/global/chrome' } }))
    await writeFile(process.env.NINE1BOT_CONFIG_PATH!, '{}')
    const inherited = await readBrowserSettings()
    expect(inherited.modelConfigured).toBe(true)
    expect(inherited.settings).toMatchObject({ enabled: true, cdpPort: 9444, executablePath: '/opt/global/chrome' })
    await patchBrowserSettings({ headless: true })
    expect(JSON.parse(await readFile(process.env.NINE1BOT_CONFIG_PATH!, 'utf8')).browser).toEqual({ headless: true })
    expect((await loadConfig(process.env.NINE1BOT_CONFIG_PATH)).browser.executablePath).toBe('/opt/global/chrome')

    await writeFile(process.env.NINE1BOT_CONFIG_PATH!, JSON.stringify({ browser: { executablePath: '{env:CHROME_EXEC}' } }))
    expect((await readBrowserSettings()).settings.executablePath).toBe(process.env.CHROME_EXEC)
    await patchBrowserSettings({ headless: true })
    expect(JSON.parse(await readFile(process.env.NINE1BOT_CONFIG_PATH!, 'utf8')).browser.executablePath).toBe('{env:CHROME_EXEC}')
    expect((await readBrowserSettings()).settings.headless).toBe(true)
    const beforeInvalid = await readFile(process.env.NINE1BOT_CONFIG_PATH!, 'utf8')
    process.env.CHROME_EXEC = 'relative-invalid'
    await expect(patchBrowserSettings({ headless: false })).rejects.toThrow('Invalid config')
    expect(await readFile(process.env.NINE1BOT_CONFIG_PATH!, 'utf8')).toBe(beforeInvalid)
    process.env.CHROME_EXEC = '/opt/Environment Chrome/chrome'

    const cleared = await patchBrowserSettings({ executablePath: null })
    expect(cleared.settings.executablePath).toBeUndefined()
    expect(JSON.parse(await readFile(process.env.NINE1BOT_CONFIG_PATH!, 'utf8')).browser.executablePath).toBeNull()
    expect((await loadConfig(process.env.NINE1BOT_CONFIG_PATH)).browser.executablePath).toBeUndefined()
    expect((await readBrowserSettings()).settings.executablePath).toBeUndefined()

    await writeFile(process.env.NINE1BOT_CONFIG_PATH!, JSON.stringify({ isolation: { disableGlobalConfig: true }, browser: { executablePath: '{env:CHROME_EXEC}' } }))
    const isolated = await readBrowserSettings()
    expect(isolated.modelConfigured).toBe(false)
    expect(isolated.settings.enabled).toBe(false)
    expect(isolated.settings.cdpPort).toBe(9222)
    await patchBrowserSettings({ headless: true })
    expect((await readBrowserSettings()).settings.executablePath).toBe(process.env.CHROME_EXEC)
    await patchBrowserSettings({ executablePath: null })
    expect((await loadConfig(process.env.NINE1BOT_CONFIG_PATH)).browser.executablePath).toBeUndefined()
  } finally {
    homeMock.mockRestore()
    if (envPath === undefined) delete process.env.CHROME_EXEC; else process.env.CHROME_EXEC = envPath
  }
})
