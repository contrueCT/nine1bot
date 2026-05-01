import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FilePlatformSecretStore } from './secrets'

const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.NINE1BOT_TEST_PLATFORM_SECRET
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), 'nine1bot-platform-secrets-'))
  tempDirs.push(dir)
  return new FilePlatformSecretStore(join(dir, 'platform-secrets.json'))
}

describe('FilePlatformSecretStore', () => {
  it('reads and writes nine1bot-local secrets', async () => {
    const store = await createStore()
    const ref = {
      provider: 'nine1bot-local' as const,
      key: 'platform:gitlab:default:token',
    }

    expect(await store.has(ref)).toBe(false)
    expect(await store.get(ref)).toBeUndefined()

    await store.set(ref, 'secret-token')

    expect(await store.has(ref)).toBe(true)
    expect(await store.get(ref)).toBe('secret-token')

    await store.delete(ref)

    expect(await store.has(ref)).toBe(false)
    expect(await store.get(ref)).toBeUndefined()
  })

  it('treats missing secret files as empty stores', async () => {
    const store = await createStore()

    expect(await store.get({
      provider: 'nine1bot-local',
      key: 'missing',
    })).toBeUndefined()
  })

  it('reads env secrets but refuses to mutate them', async () => {
    const store = await createStore()
    const ref = {
      provider: 'env' as const,
      key: 'NINE1BOT_TEST_PLATFORM_SECRET',
    }
    process.env.NINE1BOT_TEST_PLATFORM_SECRET = 'from-env'

    expect(await store.has(ref)).toBe(true)
    expect(await store.get(ref)).toBe('from-env')
    await expect(store.set(ref, 'new-value')).rejects.toThrow('read-only')
    await expect(store.delete(ref)).rejects.toThrow('read-only')
  })

  it('treats external secrets as unavailable and not writable', async () => {
    const store = await createStore()
    const ref = {
      provider: 'external' as const,
      key: 'platform:feishu:cli',
    }

    expect(await store.has(ref)).toBe(false)
    expect(await store.get(ref)).toBeUndefined()
    await expect(store.set(ref, 'new-value')).rejects.toThrow('managed outside Nine1Bot')
    await expect(store.delete(ref)).rejects.toThrow('managed outside Nine1Bot')
  })
})
