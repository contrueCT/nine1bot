export interface DiffLine { kind: 'context' | 'added' | 'removed'; text: string; before?: number; after?: number }
export interface LineDiff { lines: DiffLine[]; unavailable?: string }
// Bound both memory and CPU before allocating the LCS matrix. Large snapshots
// remain readable in the original before/after view without claiming a partial diff.
export function snapshotLineDiff(before: string, after: string): LineDiff {
  if (before.includes('\0') || after.includes('\0')) return { lines: [], unavailable: '此快照包含非文本内容，请查看原始快照或工作区' }
  if (before.length + after.length > 200_000) return { lines: [], unavailable: '快照较大，请使用变更前后视图' }
  const split = (value: string) => value ? value.match(/[^\n]*\n|[^\n]+$/g)! : []
  const a = split(before), b = split(after)
  if ((a.length + 1) * (b.length + 1) > 1_000_000 || a.length + b.length > 4000) return { lines: [], unavailable: '快照行数较多，请使用变更前后视图' }
  const width = b.length + 1
  const lcs = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
  }
  const lines: DiffLine[] = []
  const text = (line: string) => line.endsWith('\n') ? line.slice(0, -1) : `${line} ⟪无末尾换行⟫`
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'context', text: text(a[i]!), before: ++i, after: ++j }); continue }
    if (i < a.length && (j === b.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      lines.push({ kind: 'removed', text: text(a[i]!), before: ++i })
    } else lines.push({ kind: 'added', text: text(b[j]!), after: ++j })
  }
  return { lines }
}
