import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { BridgeServer } from '../../src/bridge/server'
import { getExtensionRelay } from '../../src/bridge/relay-routes'
import { evaluateScript, listCdpTargets } from '../../src/core/cdp'
import type { BrowserTarget } from '../../src/core/types'
import { artifactDirectory, cleanupResources, eventually, FIXTURE_ORIGIN, startChrome, verifyChromeForTesting, within, type OwnedChrome } from './harness'

type Step = { name: string; status: 'passed' | 'failed'; durationMs: number; error?: string }

/** Runs application browser code, not a model, mocked chrome.* APIs, or relay stand-ins. */
export async function runRealChromeRegression(): Promise<void> {
  const executable = process.env.CHROME_PATH
  assert.ok(executable, 'RUN_REAL_CHROME=1 requires CHROME_PATH pointing to an existing Chrome for Testing binary')
  const artifacts = artifactDirectory()
  await mkdir(artifacts, { recursive: true })
  const steps: Step[] = []
  const failures: unknown[] = []
  let passed = false
  const evidence = async () => writeFile(resolve(artifacts, 'evidence.json'), JSON.stringify({
    kind: 'real-chrome-integration',
    passed,
    recordedAt: new Date().toISOString(),
    runtime: { bunVersion: Bun.version, bunRevision: Bun.revision },
    steps,
    scope: 'Production browser bridge + bot CDP + built unpacked MV3 extension; local fixture only; no LLM calls',
  }, null, 2))
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    try {
      const value = await run()
      steps.push({ name, status: 'passed', durationMs: Date.now() - started })
      console.info(`[real-chrome] PASS ${name}`)
      return value
    } catch (error) {
      steps.push({ name, status: 'failed', durationMs: Date.now() - started, error: String(error) })
      throw error
    } finally {
      await evidence()
    }
  }

  let bot: OwnedChrome | undefined
  let user: OwnedChrome | undefined
  let bridge: BridgeServer | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    await step('verify full Chrome for Testing binary', () => verifyChromeForTesting(executable, artifacts))
    const extensionDir = resolve(import.meta.dir, '../../../browser-extension/dist')
    const manifest = JSON.parse(await readFile(resolve(extensionDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.name, 'Nine1Bot Browser Control', 'Build the actual repository extension before running')
    assert.equal(manifest.manifest_version, 3)
    const html = await readFile(resolve(import.meta.dir, 'fixtures/interaction.html'), 'utf8')
    const app = new Hono()
    app.get('/fixture/*', c => c.html(html))
    // The real extension initially uses port 4096. Own that port BEFORE launching it,
    // so a disposable extension can never attach to someone's existing Nine1Bot.
    // EADDRINUSE is a hard prerequisite failure, never a reason to kill a listener.
    server = Bun.serve({ hostname: '127.0.0.1', port: 4096, fetch: app.fetch, websocket })
    bot = await step('launch isolated bot Chrome with sandbox intact', () => startChrome('bot', executable, artifacts))
    bridge = new BridgeServer({ autoLaunch: false, cdpPort: bot.port, serverOrigin: FIXTURE_ORIGIN, instanceId: 'real-chrome-regression' })
    await bridge.start()
    app.route('/browser', bridge.getRoutes())
    const activeBridge = bridge
    const relay = getExtensionRelay()

    const ready = (tabId: string, browser: BrowserTarget) => eventually(`${browser} fixture ready`, async () =>
      await activeBridge.evaluate(tabId, 'document.documentElement.dataset.fixtureReady === "true"', browser) === true)
    const currentPath = (tabId: string, browser: BrowserTarget, path: string) => eventually(`${browser} path ${path}`, async () =>
      await activeBridge.evaluate(tabId, 'location.pathname', browser) === path)
    const newTab = async (browser: BrowserTarget, path: string) => {
      const result = await activeBridge.navigate('', { action: 'new_tab', url: `${FIXTURE_ORIGIN}${path}` }, browser)
      assert.ok(result.tabId, `${browser} new_tab must return a real target ID`)
      await ready(result.tabId, browser)
      return result.tabId
    }

    const interact = async (tabId: string, browser: BrowserTarget) => {
      const snapshot = await activeBridge.snapshot(tabId, { maxChars: 10000 }, browser)
      assert.match(snapshot.title, /Nine1Bot real Chrome fixture/)
      assert.match(snapshot.snapshot, /Display name/)
      const field = (await activeBridge.locateElements(tabId, { query: 'Display name' }, browser)).matches.find(match => match.tag.toLowerCase() === 'input')
      assert.ok(field, `${browser} locator must identify the actual input`)
      const value = `Nine1Bot ${browser} & 中文`
      const fill = await activeBridge.fillForm(tabId, field.targetId, value, browser)
      assert.equal(fill.success, true)
      const button = (await activeBridge.locateElements(tabId, { query: 'Save profile' }, browser)).matches.find(match => match.tag.toLowerCase() === 'button')
      assert.ok(button)
      await activeBridge.clickElement(tabId, { targetId: button.targetId }, browser)
      await eventually(`${browser} real submit event`, async () =>
        await activeBridge.evaluate(tabId, 'document.querySelector("#result").textContent', browser) === `Saved: ${value}`)
      const offscreen = (await activeBridge.locateElements(tabId, { query: 'Offscreen action', viewportOnly: false }, browser)).matches.find(match => match.tag.toLowerCase() === 'button')
      assert.ok(offscreen)
      await activeBridge.clickElement(tabId, { targetId: offscreen.targetId }, browser)
      assert.equal(await activeBridge.evaluate(tabId, 'document.querySelector("#offscreen-result").textContent', browser), 'Offscreen clicked')
      const screenshot = await activeBridge.screenshot(tabId, { format: 'png', fullPage: true }, browser)
      const png = Buffer.from(screenshot.data, 'base64')
      assert.equal(png.subarray(1, 4).toString(), 'PNG')
      assert.ok(png.readUInt32BE(20) > 1000, `${browser} screenshot must include the tall fixture, not just the viewport`)
      await writeFile(resolve(artifacts, `${browser}-full-page.png`), png)
    }

    await step('disconnected user channel fails explicitly; bot is ready', async () => {
      const status = await activeBridge.getStatus()
      assert.equal(status.bot?.running, true)
      assert.equal(status.user?.connected, false)
      await assert.rejects(activeBridge.listTabs('user'), /not connected/i)
    })
    const botTab = await step('bot creates a real tab with encoded URL/query', () => newTab('bot', '/fixture/start?literal=a%26b&unicode=%E4%B8%AD%E6%96%87'))
    await step('bot snapshot, stable targets, fill, real click, offscreen click, full-page PNG', () => interact(botTab, 'bot'))
    await step('bot navigation, back, forward, reload', async () => {
      await activeBridge.navigate(botTab, { url: `${FIXTURE_ORIGIN}/fixture/second` }, 'bot')
      await currentPath(botTab, 'bot', '/fixture/second')
      await activeBridge.navigate(botTab, { action: 'back' }, 'bot')
      await currentPath(botTab, 'bot', '/fixture/start')
      assert.equal(await activeBridge.evaluate(botTab, 'new URL(location.href).searchParams.get("literal")', 'bot'), 'a&b')
      await activeBridge.navigate(botTab, { action: 'forward' }, 'bot')
      await currentPath(botTab, 'bot', '/fixture/second')
      await activeBridge.navigate(botTab, { action: 'reload' }, 'bot')
      await ready(botTab, 'bot')
    })
    await step('bot closed-tab command fails; another tab remains usable', async () => {
      const disposable = await newTab('bot', '/fixture/closed')
      await activeBridge.navigate(disposable, { action: 'close_tab' }, 'bot')
      await eventually('bot tab removed', async () => !(await activeBridge.listTabs('bot')).some(tab => tab.id === disposable))
      await assert.rejects(activeBridge.evaluate(disposable, 'document.title', 'bot'), /target|not found/i)
      assert.equal(await activeBridge.evaluate(botTab, '2 + 3', 'bot'), 5)
    })

    user = await step('launch a second isolated Chrome with the built MV3 extension', () => startChrome('extension', executable, artifacts, extensionDir))
    const extensionChrome = user
    const worker = await step('extension service worker loads and pairs with the real relay', async () => {
      const target = await eventually('installed extension service worker', async () =>
        (await listCdpTargets(extensionChrome.cdpUrl)).find(target => target.type === 'service_worker' && /^chrome-extension:\/\//.test(target.url) && target.url.endsWith('/background/index.js')))
      assert.ok(target.webSocketDebuggerUrl)
      await eventually('extension hello', async () => relay.getHello() || undefined, 20000)
      const hello = relay.getHello()!
      assert.equal(hello.pairedInstanceId, 'real-chrome-regression')
      assert.equal(hello.serverOrigin, FIXTURE_ORIGIN)
      assert.ok(hello.tools.includes('computer'))
      assert.ok(hello.tools.includes('tabs_create_mcp'))
      assert.equal(await evaluateScript(target.webSocketDebuggerUrl, 'chrome.runtime.getManifest().name'), 'Nine1Bot Browser Control')
      await writeFile(resolve(artifacts, 'extension-hello.json'), JSON.stringify(hello, null, 2))
      return target.webSocketDebuggerUrl
    })
    const userTab = await step('extension creates an actual managed tab', () => newTab('user', '/fixture/extension'))
    await step('extension snapshot, stable targets, fill, real click, offscreen click, full-page PNG', () => interact(userTab, 'user'))
    await step('extension navigation, back, forward, reload', async () => {
      await activeBridge.navigate(userTab, { url: `${FIXTURE_ORIGIN}/fixture/extension-second` }, 'user')
      await currentPath(userTab, 'user', '/fixture/extension-second')
      await activeBridge.navigate(userTab, { action: 'back' }, 'user')
      await currentPath(userTab, 'user', '/fixture/extension')
      await activeBridge.navigate(userTab, { action: 'forward' }, 'user')
      await currentPath(userTab, 'user', '/fixture/extension-second')
      await activeBridge.navigate(userTab, { action: 'reload' }, 'user')
      await ready(userTab, 'user')
    })
    await step('extension command deadline rejects promptly and allows the next command', async () => {
      await within('extension deadline response', assert.rejects(activeBridge.callExtensionTool(userTab, 'computer', {
        action: 'wait', duration: 5000,
      }, { timeoutMs: 150 }), /timeout|timed out|deadline/i), 3000)
      assert.equal(await activeBridge.evaluate(userTab, '3 + 4', 'user'), 7)
    })
    await step('closing a real tab cancels an in-flight extension command', async () => {
      const closingTab = await newTab('user', '/fixture/closing')
      const pending = activeBridge.callExtensionTool(closingTab, 'computer', { action: 'wait', duration: 15000 })
      // Attach the rejection handler before inducing the fault.
      const outcome = pending.then(() => null, error => error)
      await eventually('extension command active', async () => relay.getAgentStates().some(state => state.tabId === Number(closingTab) && state.state === 'active'))
      // Fault injection uses the real Chrome API, never a replacement implementation.
      await evaluateScript(worker, `chrome.tabs.remove(${JSON.stringify(Number(closingTab))})`)
      assert.match(String(await within('removed-tab command response', outcome, 5000)), /cancel|removed|closed|no longer|not found/i)
      await eventually('extension closed tab gone', async () => !(await activeBridge.listTabs('user')).some(tab => tab.id === closingTab))
      assert.equal(await activeBridge.evaluate(userTab, '4 + 5', 'user'), 9)
    })
    await step('relay disconnect rejects pending work and extension reconnects without reload', async () => {
      const pending = activeBridge.callExtensionTool(userTab, 'computer', { action: 'wait', duration: 15000 })
      const outcome = pending.then(() => null, error => error)
      await eventually('extension command active before disconnect', async () => relay.getAgentStates().some(state => state.tabId === Number(userTab) && state.state === 'active'))
      await relay.stop()
      assert.match(String(await within('disconnected command response', outcome, 5000)), /disconnect|closed/i)
      assert.equal(activeBridge.isExtensionConnected, false)
      await assert.rejects(activeBridge.evaluate(userTab, '1', 'user'), /not connected/i)
      await eventually('extension reconnect and fresh hello', async () => relay.getHello()?.pairedInstanceId === 'real-chrome-regression', 20000)
      assert.equal(await activeBridge.evaluate(userTab, '5 + 6', 'user'), 11)
      assert.equal((await activeBridge.getStatus()).runtime?.extension.connected, true)
    })
    await step('owned bot process exit rejects in-flight CDP work and updates status', async () => {
      const pending = activeBridge.evaluate(botTab, 'new Promise(() => {})', 'bot')
      const outcome = pending.then(() => null, error => error)
      await Bun.sleep(150)
      await bot!.stop()
      assert.match(String(await within('CDP process exit response', outcome, 10000)), /closed|disconnect|fetch|connect|ECONN|socket|target/i)
      assert.equal((await activeBridge.getStatus()).bot?.running, false)
      assert.equal(await activeBridge.evaluate(userTab, '6 + 7', 'user'), 13)
    })
    await writeFile(resolve(artifacts, 'final-status.json'), JSON.stringify(await activeBridge.getStatus(), null, 2))
  } catch (error) {
    failures.push(error)
  } finally {
    // Close only resources created here. No global kill, shared profiles, or policy bypasses.
    const cleanup = await cleanupResources([
      ...(user ? [{ name: 'dispose extension Chrome and profile', dispose: () => user!.stop() }] : []),
      ...(bot ? [{ name: 'dispose bot Chrome and profile', dispose: () => bot!.stop() }] : []),
      ...(bridge ? [{ name: 'stop production browser bridge', dispose: () => bridge!.stop() }] : []),
      ...(server ? [{ name: 'stop fixture HTTP/WebSocket server', dispose: async () => {
        await server!.stop(true)
        assert.equal(server!.pendingRequests, 0, 'Fixture HTTP requests must drain')
        assert.equal(server!.pendingWebSockets, 0, 'Fixture WebSocket connections must drain')
      } }] : []),
    ])
    // stop(true) was awaited above. A failed runtime must not retain the test
    // process; its failure still prevents a pass and is thrown below.
    server?.unref()
    for (const result of cleanup) {
      if (result.status === 'failed') failures.push(result.error)
      steps.push({
        name: result.name, status: result.status, durationMs: result.durationMs,
        ...(result.status === 'failed' ? { error: String(result.error) } : {}),
      })
      console.info(`[real-chrome] ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.name}`)
    }
    passed = failures.length === 0
    await evidence()
    console.info(`[real-chrome] Evidence: ${artifacts}`)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Real Chrome regression and cleanup failures')
}
