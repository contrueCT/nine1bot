import { expect, test } from 'bun:test'
import { InputOwnership } from '../src/background/input-ownership'

const press = { type: 'mousePressed', button: 'left', x: 1, y: 2 }
const release = { type: 'mouseReleased', button: 'left', x: 1, y: 2, clickCount: 0 }
const method = 'Input.dispatchMouseEvent'

test('read-only and different-button input does not take a held button lease', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  await leases.send(a, 11, method, press, async () => ({}))
  await leases.send(b, 11, 'Runtime.evaluate', { expression: 'document.title' }, async () => ({}))
  await leases.send(b, 11, method, { ...press, button: 'right' }, async () => ({}))
  const assertA = await leases.assertOwned(a, 11, method, release)
  expect(assertA).not.toThrow()
  await leases.send(a, 11, method, release, async () => ({}))
  expect(await leases.assertOwned(b, 11, method, { ...release, button: 'right' })).toBeFunction()
})

test('a newer accepted press takes only that specific input from the previous owner', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  await leases.send(a, 11, method, press, async () => ({}))
  const assertA = await leases.assertOwned(a, 11, method, release)
  await leases.send(b, 11, method, press, async () => ({}))
  expect(assertA).toThrow('no longer owns')
  await expect(leases.assertOwned(a, 11, method, release)).rejects.toThrow('no longer owns')
})

test('older cleanup waits for a pending newer press and is denied if it succeeds', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  await leases.send(a, 11, method, press, async () => ({}))
  let finish!: () => void
  const pending = leases.send(b, 11, method, press, () => new Promise<void>(resolve => { finish = resolve }))
  const cleanup = leases.assertOwned(a, 11, method, release)
  const rejected = cleanup.catch(error => error)
  finish(); await pending
  expect(await rejected).toBeInstanceOf(Error)
  expect((await rejected).message).toContain('no longer owns')
})

test('a rejected competing press restores the previous accepted owner', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  await leases.send(a, 11, method, press, async () => ({}))
  let fail!: (error: Error) => void
  const pending = leases.send(b, 11, method, press, () => new Promise<void>((_, reject) => { fail = reject }))
  const rejected = pending.catch(error => error)
  const cleanup = leases.assertOwned(a, 11, method, release)
  fail(new Error('fixture rejected'))
  expect((await rejected).message).toBe('fixture rejected')
  expect(await cleanup).toBeFunction()
})

test('a release is not resurrected when a newer overlapping press fails', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  await leases.send(a, 11, method, press, async () => ({}))
  let finishRelease!: () => void, failPress!: (error: Error) => void
  const releasing = leases.send(a, 11, method, release, () => new Promise<void>(resolve => { finishRelease = resolve }))
  const pressing = leases.send(b, 11, method, press, () => new Promise<void>((_, reject) => { failPress = reject }))
  const rejected = pressing.catch(error => error)
  finishRelease(); await releasing; failPress(new Error('fixture rejected'))
  expect((await rejected).message).toBe('fixture rejected')
  await expect(leases.assertOwned(a, 11, method, release)).rejects.toThrow('no longer owns')
})

test('keys are independent and clearing a target invalidates old cleanup closures', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  await leases.send(a, 11, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'A' }, async () => ({}))
  await leases.send(b, 11, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'B' }, async () => ({}))
  const assertA = await leases.assertOwned(a, 11, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'A' })
  expect(assertA).not.toThrow()
  leases.forgetTab(11)
  expect(assertA).toThrow('no longer owns')
})

test('a release during overlapping pending presses cannot restore an already released older owner', async () => {
  const leases = new InputOwnership(), a = {}, b = {}, c = {}
  await leases.send(a, 11, method, press, async () => ({}))
  let failB!: (error: Error) => void, failC!: (error: Error) => void
  let finishRelease!: () => void
  const pendingB = leases.send(b, 11, method, press, () => new Promise<void>((_, reject) => { failB = reject })).catch(error => error)
  const releasing = leases.send(b, 11, method, release, () => new Promise<void>(resolve => { finishRelease = resolve }))
  const pendingC = leases.send(c, 11, method, press, () => new Promise<void>((_, reject) => { failC = reject })).catch(error => error)
  finishRelease(); await releasing
  failB(new Error('rejected B')); await pendingB
  failC(new Error('rejected C')); await pendingC
  await expect(leases.assertOwned(a, 11, method, release)).rejects.toThrow('no longer owns')
})

test('a failed release keeps ownership for an eventual best-effort release', async () => {
  const leases = new InputOwnership(), a = {}
  await leases.send(a, 11, method, press, async () => ({}))
  await expect(leases.send(a, 11, method, release, async () => { throw new Error('release failed') })).rejects.toThrow('release failed')
  expect(await leases.assertOwned(a, 11, method, release)).toBeFunction()
})

test('native key fields and text-only presses share the same logical-key ownership', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  const keyMethod = 'Input.dispatchKeyEvent'
  const native = { type: 'rawKeyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65 }
  await leases.send(a, 11, keyMethod, native, async () => ({}))
  const assertA = await leases.assertOwned(a, 11, keyMethod, { ...native, type: 'keyUp' })
  await leases.send(b, 11, keyMethod, { type: 'keyDown', text: 'a' }, async () => ({}))
  expect(assertA).toThrow('no longer owns')
  await expect(leases.assertOwned(a, 11, keyMethod, { ...native, type: 'keyUp' })).rejects.toThrow('no longer owns')
  expect(await leases.assertOwned(b, 11, keyMethod, { type: 'keyUp', key: 'a' })).toBeFunction()
})

test('a rejected key press restores every prior identity alias', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  const keyMethod = 'Input.dispatchKeyEvent'
  const params = { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
  await leases.send(a, 11, keyMethod, params, async () => ({}))
  await expect(leases.send(b, 11, keyMethod, { type: 'rawKeyDown', key: 'Enter' }, async () => { throw new Error('rejected') })).rejects.toThrow('rejected')
  expect(await leases.assertOwned(a, 11, keyMethod, { ...params, type: 'keyUp' })).toBeFunction()
})

test('unspecified virtual-key codes do not merge different keys', async () => {
  const leases = new InputOwnership(), a = {}, b = {}
  const keyMethod = 'Input.dispatchKeyEvent'
  const params = { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 }
  await leases.send(a, 11, keyMethod, params, async () => ({}))
  await leases.send(b, 11, keyMethod, { ...params, key: 'B', code: 'KeyB' }, async () => ({}))
  expect(await leases.assertOwned(a, 11, keyMethod, { ...params, type: 'keyUp' })).toBeFunction()
})
