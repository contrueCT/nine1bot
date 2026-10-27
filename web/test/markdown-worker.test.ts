import { describe, expect, it } from 'bun:test'
import { createMarkdownWorkerClient, type MarkdownWorker } from '../src/utils/markdown-worker-client'
import { createCodeRenderer, markdownRenderMode } from '../src/utils/markdown-renderer'
import { createMarkdownBlockRenderer } from '../src/utils/markdown-blocks'

function fakeWorker() {
  const sent: Array<{ id: number; source: string }> = []
  let terminated = false
  const worker: MarkdownWorker = { onmessage: null, onerror: null, postMessage: value => { sent.push({ ...value }) }, terminate() { terminated = true } }
  return { worker, sent, terminated: () => terminated, reply(id: number, blocks: string[]) { worker.onmessage?.({ data: { id, blocks } } as MessageEvent) } }
}

describe('bounded Markdown rendering', () => {
  it('keeps large streaming tails and oversized complete messages off the synchronous parser', () => {
    expect(markdownRenderMode(1000, true)).toBe('inline')
    expect(markdownRenderMode(100000, true)).toBe('text')
    expect(markdownRenderMode(100000, false)).toBe('worker')
    expect(markdownRenderMode(100001, false)).toBe('text')
  })

  it('preserves reference links and escaped copyable code in the worker renderer', () => {
    const render = createMarkdownBlockRenderer({ markedOptions: { renderer: createCodeRenderer() } })
    const blocks = render('[文档][d]\n\n```html\n<script>alert(1)</script>\n```\n\n[d]: https://example.org')
    expect(blocks.join('')).toContain('href="https://example.org"')
    expect(blocks.join('')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(blocks.join('')).toContain('class="copy-code"')
  })

  it('shares a single worker and drops canceled queued component callbacks', () => {
    const fake = fakeWorker()
    let creations = 0
    const client = createMarkdownWorkerClient(() => { creations++; return fake.worker })
    const output: string[] = []
    client.render('first', blocks => output.push(blocks?.[0] || 'failed'))
    const cancel = client.render('obsolete', () => output.push('obsolete'))
    client.render('latest', blocks => output.push(blocks?.[0] || 'failed'))
    cancel()
    expect(fake.sent.map(job => job.source)).toEqual(['first'])
    fake.reply(fake.sent[0].id, ['one'])
    expect(fake.sent.map(job => job.source)).toEqual(['first', 'latest'])
    fake.reply(fake.sent[1].id, ['three'])
    expect(output).toEqual(['one', 'three'])
    expect(creations).toBe(1)
    client.dispose()
  })

  it('terminates canceled work when the last component leaves', () => {
    const fake = fakeWorker()
    const client = createMarkdownWorkerClient(() => fake.worker)
    let applied = false
    const cancel = client.render('large', () => { applied = true })
    const staleReply = fake.worker.onmessage!
    cancel()
    expect(fake.terminated()).toBe(true)
    staleReply({ data: { id: fake.sent[0].id, blocks: ['stale'] } } as MessageEvent)
    expect(applied).toBe(false)
  })

  it('restarts a canceled active parse immediately for another visible message', () => {
    const workers: ReturnType<typeof fakeWorker>[] = []
    const client = createMarkdownWorkerClient(() => { const value = fakeWorker(); workers.push(value); return value.worker })
    const output: string[] = []
    const cancel = client.render('old', () => output.push('old'))
    client.render('visible', blocks => output.push(blocks?.[0] || 'failed'))
    cancel()
    expect(workers[0].terminated()).toBe(true)
    expect(workers[1].sent[0].source).toBe('visible')
    workers[1].reply(workers[1].sent[0].id, ['visible'])
    expect(output).toEqual(['visible'])
    client.dispose()
  })

  it('times out a stuck parse, retains safe text and continues the queue', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = []
    const client = createMarkdownWorkerClient(() => { const value = fakeWorker(); workers.push(value); return value.worker }, { timeoutMs: 20 })
    const output: Array<string[] | null> = []
    client.render('stuck', value => output.push(value))
    client.render('next', value => output.push(value))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(workers[0].terminated()).toBe(true)
    expect(workers[1].sent[0].source).toBe('next')
    workers[1].reply(workers[1].sent[0].id, ['next'])
    expect(output).toEqual([null, ['next']])
    client.dispose()
  })

  it('falls back to safe text if worker creation is blocked', () => {
    const client = createMarkdownWorkerClient(() => { throw new Error('CSP') })
    let result: string[] | null | undefined
    client.render('<script>unsafe</script>', value => { result = value })
    expect(result).toBe(null)
    client.dispose()
  })

  it('releases all waiting callbacks when the worker fails', () => {
    const fake = fakeWorker()
    const client = createMarkdownWorkerClient(() => fake.worker)
    const output: Array<string[] | null> = []
    client.render('one', value => output.push(value))
    client.render('two', value => output.push(value))
    fake.worker.onerror!({} as ErrorEvent)
    expect(output).toEqual([null, null])
    expect(fake.terminated()).toBe(true)
    client.dispose()
  })
})
