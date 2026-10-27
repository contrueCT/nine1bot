export interface MarkdownWorker {
  onmessage: ((event: MessageEvent<{ id: number; blocks?: string[]; error?: string }>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: { id: number; source: string }): void
  terminate(): void
}

// One worker serves all visible messages; canceled requests do not retain their
// source strings or component callbacks while waiting for another job.
export function createMarkdownWorkerClient(createWorker: () => MarkdownWorker, options: { timeoutMs?: number; idleMs?: number } = {}) {
  let worker: MarkdownWorker | undefined
  let active: number | undefined
  let nextID = 0
  let idle: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<number, { source: string; done: (blocks: string[] | null) => void }>()

  const terminate = () => {
    if (idle !== undefined) clearTimeout(idle)
    idle = undefined
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
    const previous = worker
    worker = undefined
    active = undefined
    if (previous) {
      previous.onmessage = null
      previous.onerror = null
      previous.terminate()
    }
  }
  const fail = () => {
    terminate()
    const jobs = [...pending.values()]
    pending.clear()
    jobs.forEach(job => job.done(null))
  }
  const pump = () => {
    if (active !== undefined) return
    const next = pending.entries().next().value
    if (!next) {
      if (worker && idle === undefined) idle = setTimeout(terminate, options.idleMs ?? 1000)
      return
    }
    if (idle !== undefined) clearTimeout(idle)
    idle = undefined
    try {
      if (!worker) {
        worker = createWorker()
        worker.onmessage = event => {
          if (event.data.id !== active) return
          if (deadline !== undefined) clearTimeout(deadline)
          deadline = undefined
          const job = pending.get(active)
          pending.delete(active)
          active = undefined
          job?.done(event.data.blocks ?? null)
          pump()
        }
        worker.onerror = fail
      }
      const [id, job] = next
      active = id
      worker.postMessage({ id, source: job.source })
      job.source = ''
      deadline = setTimeout(() => {
        if (active !== id) return
        pending.delete(id)
        terminate()
        job.done(null)
        pump()
      }, options.timeoutMs ?? 5000)
    } catch {
      fail()
    }
  }

  return {
    render(source: string, done: (blocks: string[] | null) => void) {
      const id = ++nextID
      pending.set(id, { source, done })
      pump()
      return () => {
        pending.delete(id)
        if (active === id) {
          // A discarded slow parse must not hold up other visible messages.
          terminate()
          pump()
        } else if (!pending.size) terminate()
      }
    },
    dispose: fail,
  }
}

export const markdownWorkerClient = createMarkdownWorkerClient(() =>
  new Worker(new URL('../workers/markdown-render.worker.ts', import.meta.url), { type: 'module' }),
)
