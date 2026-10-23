import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChrome, type ChromeInstance } from '../src/core/chrome'

let root: string
let instance: ChromeInstance | undefined
let fetchMock: ReturnType<typeof spyOn>
const originalTmp = process.env.TMPDIR
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nine1-chrome-test-'))
  process.env.TMPDIR = root
  fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fixture CDP unavailable'))
})
afterEach(async () => {
  await instance?.stop()
  instance = undefined
  fetchMock.mockRestore()
  if (originalTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmp
  await rm(root, { recursive: true, force: true })
})
async function executable(script: string, mode = 0o700) {
  const path = join(root, 'chrome-fixture.sh')
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, mode)
  return path
}

describe('Chrome child launch lifecycle (synthetic executables only)', () => {
  test('reports early exit and stderr before the startup deadline', async () => {
    const executablePath = await executable("printf 'fixture: sandbox refused\\n' >&2; exit 23")
    // The reported exit code distinguishes a child exit from the 30s startup
    // deadline. Avoid treating OS spawn scheduling as a 2s product deadline.
    let message = ''
    try { await launchChrome({ executablePath }) } catch (error) { message = String(error) }
    expect(message).toContain('code 23')
    expect(message).toContain('fixture: sandbox refused')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root)).filter(name => name.startsWith('browser-mcp-chrome-'))).toEqual(['browser-mcp-chrome-profile'])
  })
  test('handles asynchronous spawn errors without an unhandled error event', async () => {
    const executablePath = await executable('exit 0', 0o600)
    const start = Date.now()
    await expect(launchChrome({ executablePath })).rejects.toThrow(/EACCES|permission denied/i)
    expect(Date.now() - start).toBeLessThan(2000)
    await expect(launchChrome({ executablePath: join(root, 'missing') })).rejects.toThrow(/ENOENT|no such file/i)
  })
  test('startup deadline bounds a fetch that never settles and preserves supplied profiles', async () => {
    const executablePath = await executable('exec sleep 30')
    const userDataDir = join(root, 'supplied-profile')
    await mkdir(userDataDir)
    await writeFile(join(userDataDir, 'keep.txt'), 'fixture profile')
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const start = Date.now()
    await expect(launchChrome({ executablePath, userDataDir, startupTimeoutMs: 40 })).rejects.toThrow('40ms')
    expect(Date.now() - start).toBeLessThan(2000)
    expect(await readFile(join(userDataDir, 'keep.txt'), 'utf8')).toBe('fixture profile')
  })
  test('drains noisy stderr and truncates the diagnostic tail', async () => {
    const executablePath = await executable("i=0; while [ $i -lt 1200 ]; do printf 'noisy diagnostic line\\n' >&2; i=$((i+1)); done; printf 'last diagnosis\\n' >&2; exit 9")
    let message = ''
    try { await launchChrome({ executablePath }) } catch (error) { message = String(error) }
    expect(message).toContain('last diagnosis')
    expect(message.length).toBeLessThan(4500)
  })
  test('stop is idempotent and retains the existing profile path', async () => {
    const executablePath = await executable('exec sleep 30')
    fetchMock.mockResolvedValue(Response.json({ Browser: 'Fixture' }))
    instance = await launchChrome({ executablePath })
    const profile = instance.userDataDir
    expect(existsSync(profile)).toBe(true)
    const start = Date.now()
    await Promise.all([instance.stop(), instance.stop()])
    expect(Date.now() - start).toBeLessThan(2000)
    expect(existsSync(profile)).toBe(true)
    expect(profile).toBe(join(root, 'browser-mcp-chrome-profile'))
    expect(instance.process.spawnargs).not.toContain('--no-sandbox')
    expect(instance.process.spawnargs).not.toContain('--disable-web-security')
  })
  test('stop resolves immediately for an already exited owned child', async () => {
    const executablePath = await executable('sleep 0.05; exit 0')
    fetchMock.mockResolvedValue(Response.json({ Browser: 'Fixture' }))
    instance = await launchChrome({ executablePath })
    await new Promise<void>(resolve => instance!.process.once('close', () => resolve()))
    const start = Date.now()
    await instance.stop()
    expect(Date.now() - start).toBeLessThan(100)
  })
})

test('force-stops only the owned child if it ignores graceful termination', async () => {
  const readyPath = join(root, 'signal-handler-ready')
  const quotedReadyPath = `'${readyPath.replaceAll("'", "'\\''")}'`
  const executablePath = await executable(`trap '' TERM; printf 'ready' > ${quotedReadyPath}; while :; do :; done`)
  let pid: number | undefined
  fetchMock.mockImplementation(async () => {
    // A fixed delay can race a slow spawn. The marker is written only after
    // the fixture has installed the handler that this test intends to exercise.
    const deadline = Date.now() + 2000
    while (!await Bun.file(readyPath).exists()) {
      if (Date.now() > deadline) throw new Error('Fixture did not install its signal handler')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return Response.json({ Browser: 'Fixture' })
  })
  instance = await launchChrome({ executablePath })
  pid = instance.pid
  await instance.stop()
  expect(instance.process.signalCode).toBe('SIGKILL')
  expect(() => process.kill(pid!, 0)).toThrow()
}, 10000)
