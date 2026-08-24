import type { GitLabChangedFile, GitLabDiffRefs, GitLabInlineValidation, ReviewFinding } from './types'

export function validateGitLabInlinePosition(
  finding: ReviewFinding,
  files: GitLabChangedFile[],
  diffRefs?: GitLabDiffRefs,
): GitLabInlineValidation {
  if (!finding.file || (!finding.newLine && !finding.oldLine)) {
    return fallback(finding, 'Finding does not include a file and diff line.')
  }

  const file = files.find((candidate) => candidate.newPath === finding.file || candidate.oldPath === finding.file)
  if (!file) return fallback(finding, 'Finding file is not part of the included diff.')

  const ranges = changedLineRanges(file.diff)
  const newLine = finding.newLine
  const oldLine = finding.oldLine
  const validNewLine = newLine !== undefined && ranges.newLines.has(newLine)
  const validOldLine = oldLine !== undefined && ranges.oldLines.has(oldLine)
  const contextOldLineFromNew = newLine !== undefined ? ranges.contextNewToOld.get(newLine) : undefined
  const contextNewLineFromOld = oldLine !== undefined ? ranges.contextOldToNew.get(oldLine) : undefined
  const validContextNewLine = newLine !== undefined && contextOldLineFromNew !== undefined
  const validContextOldLine = oldLine !== undefined && contextNewLineFromOld !== undefined

  if (!validNewLine && !validOldLine && !validContextNewLine && !validContextOldLine) {
    return fallback(finding, `Line ${newLine ?? oldLine} is not inside the diff hunk.`)
  }

  const positionLines = resolvePositionLines({
    newLine,
    oldLine,
    validNewLine,
    validOldLine,
    contextOldLineFromNew,
    contextNewLineFromOld,
  })

  return {
    ok: true,
    position: {
      position_type: 'text',
      base_sha: diffRefs?.baseSha,
      start_sha: diffRefs?.startSha,
      head_sha: diffRefs?.headSha,
      old_path: file.oldPath,
      new_path: file.newPath,
      old_line: positionLines.oldLine,
      new_line: positionLines.newLine,
    },
  }
}

export function changedLineRanges(diff: string) {
  const oldLines = new Set<number>()
  const newLines = new Set<number>()
  const contextNewToOld = new Map<number, number>()
  const contextOldToNew = new Map<number, number>()
  let oldLine = 0
  let newLine = 0
  let insideHunk = false

  for (const line of diffLines(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      insideHunk = true
      continue
    }
    if (line.startsWith('diff --git ')) {
      insideHunk = false
      continue
    }
    if (!insideHunk) continue
    if (line.startsWith('+')) {
      newLines.add(newLine)
      newLine += 1
      continue
    }
    if (line.startsWith('-')) {
      oldLines.add(oldLine)
      oldLine += 1
      continue
    }
    if (!line.startsWith('\\')) {
      contextNewToOld.set(newLine, oldLine)
      contextOldToNew.set(oldLine, newLine)
      oldLine += 1
      newLine += 1
    }
  }

  return { oldLines, newLines, contextNewToOld, contextOldToNew }
}

function resolvePositionLines(input: {
  newLine?: number
  oldLine?: number
  validNewLine: boolean
  validOldLine: boolean
  contextOldLineFromNew?: number
  contextNewLineFromOld?: number
}) {
  if (input.validNewLine) {
    return { newLine: input.newLine, oldLine: undefined }
  }
  if (input.validOldLine) {
    return { newLine: undefined, oldLine: input.oldLine }
  }
  if (input.newLine !== undefined && input.contextOldLineFromNew !== undefined) {
    return { newLine: input.newLine, oldLine: input.contextOldLineFromNew }
  }
  if (input.oldLine !== undefined && input.contextNewLineFromOld !== undefined) {
    return { newLine: input.contextNewLineFromOld, oldLine: input.oldLine }
  }
  return { newLine: undefined, oldLine: undefined }
}

function diffLines(diff: string) {
  return diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
}

export function renderInlineFallbackFinding(finding: ReviewFinding, reason: string) {
  return [
    `### ${finding.title}`,
    '',
    `Inline comment fallback: ${reason}`,
    finding.file ? `File: \`${finding.file}\`${finding.newLine || finding.oldLine ? `:${finding.newLine ?? finding.oldLine}` : ''}` : undefined,
    '',
    finding.body,
    finding.suggestion ? ['', 'Suggested replacement:', '', safeCodeBlock(finding.suggestion.replacement)].join('\n') : undefined,
  ].filter(Boolean).join('\n')
}

export function renderInlineFindingBody(finding: ReviewFinding) {
  const suggestion = renderSuggestionBlock(finding)
  return [
    finding.body,
    suggestion ? ['', suggestion].join('\n') : undefined,
  ].filter(Boolean).join('\n')
}

export function renderSuggestionBlock(finding: ReviewFinding) {
  const replacement = finding.suggestion?.replacement
  if (!replacement) return undefined
  if (replacement.includes('```')) return undefined
  if (replacement.length > 4000) return undefined
  return [
    '```suggestion',
    replacement.trimEnd(),
    '```',
  ].join('\n')
}

function fallback(finding: ReviewFinding, reason: string): GitLabInlineValidation {
  return {
    ok: false,
    reason,
    fallbackMarkdown: renderInlineFallbackFinding(finding, reason),
  }
}

function safeCodeBlock(content: string) {
  const fence = markdownFence(content)
  return [
    fence,
    content,
    fence,
  ].join('\n')
}

function markdownFence(content: string) {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g)).map((match) => match[0].length))
  return '`'.repeat(longest + 1)
}
