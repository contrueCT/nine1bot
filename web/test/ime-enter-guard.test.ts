import { describe, expect, it } from 'bun:test'

// 现有 harness 无法挂载组件，这里对源码做结构化断言：
// Enter 分支内，IME 组合态防护必须出现在 preventDefault/发送之前。
describe('IME composition guard on Enter', () => {
  it('InputBox ignores Enter while IME composition is active', async () => {
    const source = await Bun.file(new URL('../src/components/InputBox.vue', import.meta.url)).text()
    const fnStart = source.indexOf('function handleKeydown')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const fn = source.slice(fnStart, source.indexOf('\nfunction ', fnStart + 1))

    const enterIdx = fn.indexOf("e.key === 'Enter'")
    const guardIdx = fn.indexOf('e.isComposing || e.keyCode === 229')
    const preventIdx = fn.indexOf('e.preventDefault()')
    expect(enterIdx).toBeGreaterThanOrEqual(0)
    expect(guardIdx).toBeGreaterThan(enterIdx)
    expect(guardIdx).toBeLessThan(preventIdx)
  })

  it('SearchOverlay ignores Enter while IME composition is active', async () => {
    const source = await Bun.file(new URL('../src/components/SearchOverlay.vue', import.meta.url)).text()
    const enterIdx = source.indexOf("if (e.key === 'Enter') {")
    expect(enterIdx).toBeGreaterThanOrEqual(0)

    const guardIdx = source.indexOf('e.isComposing || e.keyCode === 229', source.indexOf('function handleKeydown'))
    const selectIdx = source.indexOf("emit('select'", enterIdx)
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    expect(guardIdx).toBeLessThan(selectIdx)
  })
})
