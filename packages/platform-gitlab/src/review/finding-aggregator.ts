import type { AggregatedReviewFinding, ReviewFinding } from './types'
import { assertGitLabReviewAggregateBodyBudget } from './publication-budget'

const severityRank = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
  blocker: 4,
} as const

export function aggregateReviewFindings(findings: ReviewFinding[]): AggregatedReviewFinding[] {
  const grouped = new Map<string, AggregatedReviewFinding>()

  for (const finding of findings) {
    assertGitLabReviewAggregateBodyBudget(finding.body)
    const key = findingKey(finding)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        ...finding,
        sources: finding.source ? [finding.source] : [],
        duplicates: [],
      })
      continue
    }

    existing.duplicates.push(finding)
    if (finding.source && !existing.sources.includes(finding.source)) {
      existing.sources.push(finding.source)
    }
    if (severityRank[finding.severity] > severityRank[existing.severity]) {
      existing.severity = finding.severity
    }
    existing.body = mergeBody(existing.body, finding.body)
    assertGitLabReviewAggregateBodyBudget(existing.body)
  }

  return [...grouped.values()]
}

function findingKey(finding: ReviewFinding) {
  return [
    finding.file ?? '',
    finding.oldLine ?? '',
    finding.newLine ?? '',
    finding.category ?? '',
    normalizeKeyText(finding.title),
  ].join(':')
}

function normalizeKeyText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function mergeBody(left: string, right: string) {
  if (!right || left.includes(right)) return left
  if (!left) return right
  return `${left}\n\n${right}`
}
