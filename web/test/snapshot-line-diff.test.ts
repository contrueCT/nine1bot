import { expect, test } from 'bun:test'
import { snapshotLineDiff } from '../src/utils/snapshot-line-diff'
test('line diff preserves context, replacement and both line numbers', () => {
  expect(snapshotLineDiff('same\nold\n', 'same\nnew\n').lines).toEqual([
    { kind: 'context', text: 'same', before: 1, after: 1 },
    { kind: 'removed', text: 'old', before: 2 },
    { kind: 'added', text: 'new', after: 2 },
  ])
})
test('newlines, empty additions, deletions and untrusted text are represented literally', () => {
  expect(snapshotLineDiff('', '<script>').lines[0]).toMatchObject({ kind: 'added', text: '<script> ⟪无末尾换行⟫', after: 1 })
  expect(snapshotLineDiff('a', 'a\n').lines.map(x => x.kind)).toEqual(['removed', 'added'])
  expect(snapshotLineDiff('a\n', '').lines[0]?.kind).toBe('removed')
})
test('large and binary inputs use an explicit bounded fallback', () => {
  expect(snapshotLineDiff('a\n'.repeat(1500), 'b\n'.repeat(1500)).unavailable).toBeDefined()
  expect(snapshotLineDiff('\0', 'x').unavailable).toBeDefined()
  expect(snapshotLineDiff('', 'x'.repeat(200_001)).unavailable).toBeDefined()
})
