import { afterEach, describe, expect, it } from 'bun:test'
import { api, projectApi, setApiDirectory, type Session } from '../src/api/client'
import { useGlobalRecentSessions } from '../src/composables/useGlobalRecentSessions'
import { useSession } from '../src/composables/useSession'

function session(id: string, directory = '/workspace/one'): Session {
  return {
    id,
    title: id,
    directory,
    time: { created: 1, updated: 1 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const originalFetch = globalThis.fetch
const originalGetSessions = api.getSessions
const originalProjectSessions = projectApi.sessions
const globalRecents = useGlobalRecentSessions()

afterEach(() => {
  globalThis.fetch = originalFetch
  api.getSessions = originalGetSessions
  projectApi.sessions = originalProjectSessions
  setApiDirectory('')
  globalRecents.resetGlobalRecentSessions()
})

describe('session history loading', () => {
  it('uses the directory header for project routing without filtering history to one directory', async () => {
    let requestedUrl = ''
    let requestedHeaders: Headers | undefined
    globalThis.fetch = async (input, options) => {
      requestedUrl = String(input)
      requestedHeaders = new Headers(options?.headers)
      return Response.json([session('one'), session('two', '/workspace/two')])
    }
    setApiDirectory('/workspace/one')

    const result = await api.getSessions()

    expect(result.map((item) => item.id)).toEqual(['one', 'two'])
    expect(requestedUrl).toBe('/session?roots=true')
    expect(requestedHeaders?.get('x-opencode-directory')).toBe(encodeURIComponent('/workspace/one'))
  })

  it('reports an HTTP failure so the sidebar can retry instead of treating it as empty history', async () => {
    globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 })
    await expect(api.getSessions()).rejects.toThrow('Failed to list sessions: 503')

    globalThis.fetch = async () => Response.json({ error: 'temporary error' })
    await expect(api.getSessions()).rejects.toThrow('Invalid session list response')
  })

  it('keeps a previous list on failure and ignores an older response after a newer load', async () => {
    const history = useSession()
    api.getSessions = async () => [session('existing')]
    expect(await history.loadSessions()).toBe(true)

    api.getSessions = async () => { throw new Error('temporary failure') }
    expect(await history.loadSessions()).toBe(false)
    expect(history.sessions.value.map((item) => item.id)).toEqual(['existing'])
    expect(history.sessionsLoadError.value).toBe(true)

    const older = deferred<Session[]>()
    api.getSessions = async () => older.promise
    const olderLoad = history.loadSessions()
    api.getSessions = async () => [session('newer')]
    expect(await history.loadSessions()).toBe(true)
    older.resolve([session('stale')])
    await olderLoad

    expect(history.sessions.value.map((item) => item.id)).toEqual(['newer'])
    expect(history.sessionsLoadError.value).toBe(false)
  })

  it('shows completed projects while another project history is still loading', async () => {
    const slowProject = deferred<Session[]>()
    projectApi.sessions = async (projectID) =>
      projectID === 'fast' ? [session('fast-session')] : slowProject.promise

    const loading = globalRecents.loadGlobalRecentSessions([
      { id: 'fast', worktree: '/workspace/fast' },
      { id: 'slow', worktree: '/workspace/slow' },
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(globalRecents.isLoading.value).toBe(true)
    expect(globalRecents.recentSessions.value.map((item) => item.id)).toEqual(['fast-session'])

    slowProject.resolve([session('slow-session')])
    await loading
    expect(globalRecents.recentSessions.value.map((item) => item.id)).toEqual(['fast-session', 'slow-session'])
  })

  it('retains visible history when every project refresh fails', async () => {
    const projects = [{ id: 'one', worktree: '/workspace/one' }]
    projectApi.sessions = async () => [session('existing')]
    await globalRecents.loadGlobalRecentSessions(projects)

    const originalError = console.error
    console.error = () => {}
    try {
      projectApi.sessions = async () => { throw new Error('temporary failure') }
      await globalRecents.loadGlobalRecentSessions(projects)
    } finally {
      console.error = originalError
    }

    expect(globalRecents.recentSessions.value.map((item) => item.id)).toEqual(['existing'])
    expect(globalRecents.loadError.value).toBe(true)
  })

  it('keeps the failed project history while applying successful project updates', async () => {
    const projects = [
      { id: 'one', worktree: '/workspace/one' },
      { id: 'two', worktree: '/workspace/two' },
    ]
    projectApi.sessions = async (projectID) => [session(`${projectID}-old`)]
    await globalRecents.loadGlobalRecentSessions(projects)

    const originalError = console.error
    console.error = () => {}
    try {
      projectApi.sessions = async (projectID) => {
        if (projectID === 'one') throw new Error('temporary failure')
        return []
      }
      await globalRecents.loadGlobalRecentSessions(projects)
    } finally {
      console.error = originalError
    }

    expect(globalRecents.recentSessions.value.map((item) => item.id)).toEqual(['one-old'])
    expect(globalRecents.loadError.value).toBe(true)
  })
})
