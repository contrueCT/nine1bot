import { createApp, h, nextTick, ref } from 'vue'
import MarkdownText from '../../src/components/MarkdownText.vue'
import TerminalContent from '../../src/components/TerminalContent.vue'
import AgentTerminalViewer from '../../src/components/AgentTerminalViewer.vue'
import { useAgentTerminal } from '../../src/composables/useAgentTerminal'
import { markdownWorkerClient } from '../../src/utils/markdown-worker-client'
import { createPreviewWindowOpener } from '../../src/utils/preview-window'

const tests: Array<{ name: string; run: () => Promise<void> }> = []
const cases: Array<{ name: string; passed: boolean; error?: string }> = []
const errors: string[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = performance.now() + 8000
  while (!(await check())) { if (performance.now() > deadline) throw new Error(message); await delay() }
}
async function control(settings: Record<string, unknown>) {
  await fetch('/__fixture/control', { method: 'POST', body: JSON.stringify(settings) })
}
const state = async () => (await fetch('/__fixture/state')).json()
function mount(component: any, props: any) {
  const host = document.createElement('section')
  document.querySelector('#stage')!.appendChild(host)
  const app = createApp({ render: () => h(component, typeof props === 'function' ? props() : props) })
  app.mount(host)
  return { host, close() { app.unmount(); host.remove() } }
}
const terminal = useAgentTerminal()
const output = (seq: number, data: string) => terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: { id: 'term', sessionID: 'fixture', seq, data } })
const visibleTerminal = (host: HTMLElement) => host.querySelector('.xterm-rows')?.textContent || ''

tests.push({ name: 'terminal reset merges in-flight live output and keeps the real xterm tail', async run() {
  await control({ clearCounts: true, buffer: { buffer: 'history\r\n', latestSeq: 1 } })
  terminal.setSessionContext('fixture')
  const view = mount(TerminalContent, {})
  try {
    await until(() => visibleTerminal(view.host).includes('history'), 'initial xterm history missing')
    assert((await state()).bufferCalls === 1, 'viewer fetched the buffer a second time')
    await control({ pauseBuffer: true })
    const recovery = terminal.recoverTerminalOutput('term', -1)
    await until(async () => (await state()).pendingBuffers === 1, 'reset request never reached fixture')
    output(2, 'LIVE_TAIL')
    await nextTick()
    await fetch('/__fixture/release-buffer')
    await recovery
    await until(() => visibleTerminal(view.host).includes('LIVE_TAIL'), 'reset removed live tail from xterm')
    assert(terminal.activeScreen.value?.latestSeq === 2, 'reset rewound sequence')
    assert(terminal.activeScreen.value?.outputData === 'history\r\nLIVE_TAIL', 'reset failed to merge complete history')
    const text = visibleTerminal(view.host)
    assert(text.indexOf('LIVE_TAIL') === text.lastIndexOf('LIVE_TAIL'), 'live tail duplicated')
  } finally { view.close(); terminal.clearTerminals() }
} })

tests.push({ name: 'batched output and viewer remount preserve history without another HTTP buffer read', async run() {
  await control({ clearCounts: true })
  terminal.setSessionContext('fixture')
  let view = mount(TerminalContent, {})
  try {
    await until(() => visibleTerminal(view.host).includes('history'), 'initial history missing')
    output(2, 'FIRST_'); output(3, 'SECOND_'); output(4, 'THIRD')
    await until(() => visibleTerminal(view.host).includes('FIRST_SECOND_THIRD'), 'Vue batching dropped an intermediate chunk')
    view.close()
    view = mount(TerminalContent, {})
    await until(() => visibleTerminal(view.host).includes('FIRST_SECOND_THIRD'), 'remount lost retained output')
    assert((await state()).bufferCalls === 1, 'remount issued a redundant buffer request')
  } finally { view.close(); terminal.clearTerminals() }
} })

tests.push({ name: 'late screen response cannot overwrite live xterm output after a reset', async run() {
  await control({ pauseScreen: true, clearCounts: true })
  terminal.setSessionContext('fixture')
  const view = mount(TerminalContent, {})
  try {
    await until(() => visibleTerminal(view.host).includes('history'), 'buffer recovery incorrectly waited for screen')
    output(2, 'KEEP_ME')
    await fetch('/__fixture/release-screen')
    await until(() => visibleTerminal(view.host).includes('KEEP_ME'), 'late screen removed live tail')
    assert(terminal.activeScreen.value?.latestSeq === 2, 'late screen rewound sequence')
  } finally { await fetch('/__fixture/release-screen'); view.close(); terminal.clearTerminals() }
} })

tests.push({ name: 'real xterm appends across retained-window trimming and resets for a new epoch', async run() {
  const data = ref('ABC'), offset = ref(0), epoch = ref(1)
  const view = mount(AgentTerminalViewer, () => ({ terminalId: 'term', sessionId: 'fixture', screen: '', screenAnsi: '', outputData: data.value, outputOffset: offset.value, outputResetToken: epoch.value, rows: 24, cols: 80 }))
  try {
    await until(() => visibleTerminal(view.host).includes('ABC'), 'initial output missing')
    offset.value = 2; data.value = 'CDEF'
    await until(() => visibleTerminal(view.host).includes('ABCDEF'), 'trimming duplicated or dropped output')
    epoch.value = 2; offset.value = 0; data.value = 'NEW_EPOCH'
    await until(() => visibleTerminal(view.host).includes('NEW_EPOCH'), 'new epoch missing')
    assert(!visibleTerminal(view.host).includes('ABCDEF'), 'old epoch was not cleared')
  } finally { view.close() }
} })

tests.push({ name: 'coherent server screen survives truncated ANSI, a render gap and a cropped-cache remount', async run() {
  await control({ truncated: true, clearCounts: true })
  terminal.setSessionContext('fixture')
  let view = mount(TerminalContent, {})
  try {
    await until(() => visibleTerminal(view.host).includes('HEADER') && visibleTerminal(view.host).includes('STATUS 50%'), 'truncated ring lost persistent screen state')
    assert((await state()).bufferCalls === 1, 'initial coherent snapshot caused a redundant buffer fetch')
    await control({ pauseBuffer: true })
    const recovery = terminal.recoverTerminalOutput('term', -1)
    await until(async () => (await state()).pendingBuffers === 1, 'reset request missing')
    output(11, '\rSTATUS 100%')
    await fetch('/__fixture/release-buffer'); await recovery
    await until(() => visibleTerminal(view.host).includes('HEADER') && visibleTerminal(view.host).includes('STATUS 100%'), 'coherent screen overwrote its live tail')

    // One update jumps beyond the retained window: the mounted Viewer must get
    // a coherent snapshot instead of replaying a tail that no longer has HEADER.
    await control({ truncated: true, tail: '\rPROGRESS', latestSeq: 12 })
    output(12, '\rPROGRESS'.repeat(250000))
    await until(async () => (await state()).bufferCalls === 3 && visibleTerminal(view.host).includes('HEADER') && visibleTerminal(view.host).includes('PROGRESS'), 'render-gap recovery lost the screen baseline')

    // Consume smaller updates individually: the mounted xterm keeps its screen,
    // but the cropped cache can no longer initialize a different Viewer alone.
    output(13, '\rAFTER'.repeat(110000)); await nextTick(); await delay(100)
    output(14, '\rAFTER'.repeat(110000)); await nextTick(); await delay(100)
    const current = terminal.activeScreen.value!
    assert((current.outputOffset ?? 0) > (current.outputSnapshotOffset ?? 0), 'test did not crop the baseline')
    assert((await state()).bufferCalls === 3, 'continuous updates triggered redundant recovery')
    await control({ truncated: true, tail: '\rAFTER', latestSeq: 14 })
    view.close(); view = mount(TerminalContent, {})
    await until(async () => (await state()).bufferCalls === 4 && visibleTerminal(view.host).includes('HEADER') && visibleTerminal(view.host).includes('AFTER'), 'cropped-cache remount lost persistent screen state')
  } finally { await fetch('/__fixture/release-buffer'); view.close(); terminal.clearTerminals() }
} })

const malicious = '<SCRIPT>window.__unsafeCount++</SCRIPT>\n\n<img src="data:,invalid" onerror="window.__unsafeCount++">\n\n<svg onload="window.__unsafeCount++"></svg>\n\n<a href="javascript:window.__unsafeCount++">unsafe link</a>\n\n'
for (const worker of [false, true]) tests.push({ name: `${worker ? 'native Worker' : 'inline'} Markdown uses real DOMPurify before inserting HTML`, async run() {
  ;(window as any).__unsafeCount = 0
  const source = malicious + '**SAFE_BOLD** [safe][ref]\n\n```html\n<SCRIPT>escaped code</SCRIPT>\n```\n\n' + (worker ? 'body '.repeat(3000) : '') + '\n\n[ref]: https://example.org'
  const view = mount(MarkdownText, { text: source, streaming: false })
  try {
    await nextTick()
    if (worker) assert(view.host.querySelector('[aria-busy="true"]'), 'completed long text did not enter native Worker path')
    await until(() => !!view.host.querySelector('strong'), 'Markdown never produced formatted output')
    assert(view.host.querySelector('strong')!.textContent === 'SAFE_BOLD', 'valid formatting lost')
    assert(view.host.querySelector('a[href="https://example.org"]'), 'reference link lost')
    assert(view.host.querySelector('code')?.textContent === '<SCRIPT>escaped code</SCRIPT>', 'code was not escaped correctly')
    assert(view.host.querySelector('.copy-code'), 'code copy button lost')
    assert(!view.host.querySelector('script,[onerror],[onload],a[href^="javascript:"]'), 'unsafe HTML survived DOMPurify')
    await delay(100)
    assert((window as any).__unsafeCount === 0, 'unsafe HTML executed')
  } finally { view.close() }
} })

tests.push({ name: 'native Worker cancellation cannot replace newer text or write after unmount', async run() {
  const source = ref('obsolete **body** '.repeat(3000))
  const view = mount(MarkdownText, () => ({ text: source.value, streaming: false }))
  source.value = 'CURRENT_TEXT'
  await nextTick(); await delay(100)
  assert(view.host.textContent === 'CURRENT_TEXT', 'stale Worker overwrote newer text')
  source.value = 'unmounted body '.repeat(3000)
  await nextTick()
  view.close()
  await delay(100)
} })

tests.push({ name: 'native Blob stays readable after load and is reclaimed on close (window host stub)', async run() {
  const target = { closed: false, document: { URL: 'about:blank', readyState: 'complete' } }
  let tick!: () => void
  let blobURL = ''
  const opener = createPreviewWindowOpener({
    open(url: string) { blobURL = url; return target as unknown as Window },
    setInterval(callback: () => void) { tick = callback; return 1 }, clearInterval() {}, addEventListener() {}, removeEventListener() {},
  } as any)
  try {
    opener.open({ id: 'local', mime: 'text/html', content: btoa('<p>retained</p>') })
    target.document.URL = blobURL; tick()
    assert(await (await fetch(blobURL)).text() === '<p>retained</p>', 'load revoked URL too early')
    target.closed = true; tick()
    let failed = false
    try { await fetch(blobURL) } catch { failed = true }
    assert(failed, 'closed window retained native Blob')
  } finally { opener.dispose() }
} })

for (const test of tests) {
  try { await test.run(); cases.push({ name: test.name, passed: true }) }
  catch (error) { cases.push({ name: test.name, passed: false, error: String(error) }) }
}
markdownWorkerClient.dispose()
const report = { browser: navigator.userAgent, cases, errors, passed: cases.every(test => test.passed) && errors.length === 0 }
document.querySelector('#result')!.textContent = JSON.stringify(report, null, 2)
document.title = report.passed ? 'PASS: Web lifecycle regression' : 'FAIL: Web lifecycle regression'
await fetch('/__fixture/result', { method: 'POST', body: JSON.stringify(report) })
