import type { AggregatedReviewFinding, GitLabDiffManifest } from './types'

export function renderBlockedDiffComment(reason: string) {
  return [
    'GitLab review blocked',
    '',
    reason,
    '',
    'The diff evidence could not be loaded reliably enough for automated review. Please check the GitLab diff, split the MR if it is too large, or request a manual review.',
  ].join('\n')
}

export function renderReviewSummaryComment(input: {
  title?: string
  summary: string
  findings: AggregatedReviewFinding[]
  inlineFindings?: AggregatedReviewFinding[]
  manifest?: GitLabDiffManifest
  warnings?: string[]
}) {
  const inlineFindings = input.inlineFindings ?? []
  const findingCount = input.findings.length + inlineFindings.length
  const lines = [
    `## ${input.title ?? 'Nine1bot GitLab Review'}`,
    '',
    input.summary,
    '',
    `Findings: ${findingCount}`,
  ]

  if (input.manifest) {
    lines.push(
      `Diff files: ${input.manifest.stats.includedFileCount}/${input.manifest.stats.fileCount}`,
      `Skipped files: ${input.manifest.stats.skippedFileCount}`,
    )
  }

  if (input.warnings?.length) {
    lines.push('', '### Warnings', ...input.warnings.map((warning) => `- ${warning}`))
  }

  if (inlineFindings.length) {
    lines.push('', '### Inline Comments')
    lines.push('', `${inlineFindings.length} finding${inlineFindings.length === 1 ? '' : 's'} were posted as GitLab diff threads.`)
    for (const finding of inlineFindings) {
      const location = findingLocation(finding)
      lines.push(`- **${finding.severity.toUpperCase()}** ${finding.title}${location ? ` (${location})` : ''}`)
    }
  }

  if (input.findings.length) {
    lines.push('', inlineFindings.length ? '### Summary Findings' : '### Findings')
    for (const group of groupFindingsByFile(input.findings)) {
      lines.push('', `#### ${group.file ? `\`${group.file}\`` : 'General'}`)
      for (const finding of group.findings) {
        lines.push('', renderReviewFindingItem(finding))
      }
    }
  }

  return lines.join('\n')
}

export function renderReviewFindingItem(finding: AggregatedReviewFinding) {
  const location = findingLocation(finding)
  const lines = [
    `- **${finding.severity.toUpperCase()}** ${finding.title}${location ? ` (${location})` : ''}`,
    '',
    finding.body,
  ]
  if (finding.sources.length > 1) {
    lines.push('', `Sources: ${finding.sources.map((source) => `\`${source}\``).join(', ')}`)
  }
  if (finding.suggestion?.replacement) {
    lines.push('', 'Suggested replacement:', '', safeCodeBlock(finding.suggestion.replacement))
  }
  return lines.join('\n')
}

function findingLocation(finding: AggregatedReviewFinding) {
  if (!finding.file && !finding.newLine && !finding.oldLine) return ''
  const line = finding.newLine ?? finding.oldLine
  if (finding.file && line !== undefined) return `${finding.file}:${line}`
  if (finding.file) return finding.file
  return line !== undefined ? `:${line}` : ''
}

function groupFindingsByFile(findings: AggregatedReviewFinding[]) {
  const groups = new Map<string, { file?: string; findings: AggregatedReviewFinding[] }>()
  for (const finding of findings) {
    const key = finding.file ?? '__general__'
    const existing = groups.get(key)
    if (existing) {
      existing.findings.push(finding)
      continue
    }
    groups.set(key, {
      file: finding.file,
      findings: [finding],
    })
  }
  return Array.from(groups.values())
}

export function diffSnippet(diff: string, input: { newLine?: number; oldLine?: number } = {}) {
  const hunks = parseDiffHunks(diff)
  if (!hunks.length) return undefined
  const matched = hunks.find((hunk) => {
    if (input.newLine !== undefined && hunk.newChangedLines.has(input.newLine)) return true
    if (input.oldLine !== undefined && hunk.oldChangedLines.has(input.oldLine)) return true
    return false
  }) ?? hunks[0]
  return trimSnippet(matched.lines)
}

function parseDiffHunks(diff: string) {
  const hunks: Array<{
    lines: string[]
    oldChangedLines: Set<number>
    newChangedLines: Set<number>
  }> = []
  let current: (typeof hunks)[number] | undefined
  let oldLine = 0
  let newLine = 0

  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      current = {
        lines: [line],
        oldChangedLines: new Set(),
        newChangedLines: new Set(),
      }
      hunks.push(current)
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }
    if (!current) continue
    current.lines.push(line)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.newChangedLines.add(newLine)
      newLine += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.oldChangedLines.add(oldLine)
      oldLine += 1
      continue
    }
    if (!line.startsWith('\\')) {
      oldLine += 1
      newLine += 1
    }
  }

  return hunks
}

function trimSnippet(lines: string[], maxLines = 16, maxChars = 1800) {
  const trimmed = lines.slice(0, maxLines)
  if (lines.length > maxLines) trimmed.push('...')
  let text = trimmed.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}\n...`
  return text
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
