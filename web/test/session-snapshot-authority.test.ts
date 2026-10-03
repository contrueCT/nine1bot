import { expect, test } from 'bun:test'
import { reactive } from 'vue'
import { acknowledgeSessionDirectory, beginSessionRead, deriveSessionSnapshot, markSessionSnapshot, sessionSnapshotOrder } from '../src/api/session-snapshot-authority'

const session = () => ({ id: 'A', title: 'A', directory: '/old', time: { created: 1, updated: 1 } })
for (const [entrypoint, changes] of [
  ['model', { runtime: { currentModel: { providerID: 'p', modelID: 'new' } } }],
  ['profile config', { runtime: { profileSnapshotId: 'profile-new' } }],
  ['sidebar decoration', { projectDisplayName: 'project' }],
  ['history normalization', { createdAt: '1970-01-01T00:00:00.001Z' }],
  ['live title', { title: 'new title' }],
  ['directory projection', { directory: '/committed' }],
] as const) test(`${entrypoint} derivation inherits its source read, never observation time`, () => {
  const started = beginSessionRead()
  const source = markSessionSnapshot(session(), started)
  const ack = acknowledgeSessionDirectory()
  const derived = deriveSessionSnapshot(reactive(source), changes)
  expect(sessionSnapshotOrder(derived)).toBe(started)
  expect(sessionSnapshotOrder(reactive(derived))).toBe(started)
  expect(sessionSnapshotOrder(derived)).toBeLessThan(ack)
  expect(JSON.stringify(derived)).not.toContain('readStarted')
})

test('arbitrary copies and unknown records cannot manufacture authority by being observed late', () => {
  const original = markSessionSnapshot(session(), beginSessionRead())
  const copy = { ...original }
  const ack = acknowledgeSessionDirectory()
  expect(sessionSnapshotOrder(copy)).toBe(0)
  expect(sessionSnapshotOrder(copy)).toBe(0)
  expect(sessionSnapshotOrder(deriveSessionSnapshot(copy, { title: 'late observation' }))).toBe(0)
  expect(sessionSnapshotOrder(copy)).toBeLessThan(ack)
  const fresh = markSessionSnapshot({ ...original, directory: '/server-fresh' }, beginSessionRead())
  expect(sessionSnapshotOrder(fresh)).toBeGreaterThan(ack)
  const acknowledged = markSessionSnapshot(deriveSessionSnapshot(original, { directory: '/ack' }), acknowledgeSessionDirectory())
  expect(sessionSnapshotOrder(acknowledged)).toBeGreaterThan(sessionSnapshotOrder(fresh))
})

// Cover every API boundary that returns selectable Session records. Debug,
// model/config summaries, and history return other shapes and may not mint a
// new directory provenance when merged into an existing Session.
for (const boundary of ['local-list', 'project-list', 'search', 'creation', 'title-patch'] as const) {
  test(`${boundary} API normalization carries request-start provenance`, async () => {
    const { api, projectApi, getApiClientSurface, setApiClientSurface } = await import('../src/api/client')
    const originalFetch = globalThis.fetch
    const surface = getApiClientSurface()
    setApiClientSurface('web')
    const record = session()
    const body = boundary === 'search' ? { results: [{ session: record, snippet: '' }], hasMore: false }
      : boundary === 'creation' ? { session: record }
      : boundary === 'title-patch' ? record : [record]
    const load = async () => {
      switch (boundary) {
        case 'local-list': return (await api.getSessions('/old'))[0]!
        case 'project-list': return (await projectApi.sessions('project'))[0]!
        case 'search': return (await api.searchSessions('A', '/old')).results[0]!.session
        case 'creation': return api.createSession('/old')
        case 'title-patch': return api.updateSession('A', { title: 'renamed' })
      }
    }
    let release!: (response: Response) => void
    globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve })
    try {
      const pending = load()
      const ack = acknowledgeSessionDirectory()
      release(Response.json(body))
      const old = await pending
      expect(sessionSnapshotOrder(old)).toBeGreaterThan(0)
      expect(sessionSnapshotOrder(old)).toBeLessThan(ack)
      globalThis.fetch = async () => Response.json(body)
      const fresh = await load()
      expect(sessionSnapshotOrder(fresh)).toBeGreaterThan(ack)
    } finally {
      globalThis.fetch = originalFetch
      setApiClientSurface(surface)
    }
  })
}
