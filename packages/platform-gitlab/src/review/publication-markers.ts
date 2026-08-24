import { createHash } from 'node:crypto'

import type { ReviewFinding } from './types'

const MARKER_VERSION = 'v1'
const MARKER_HASH_LENGTH = 24

export type GitLabReviewPublicationMarkerInput = {
  runId: string
  kind: 'summary' | 'inline' | 'fallback'
  findingKey?: string
}

export function gitLabReviewFindingKey(finding: ReviewFinding): string {
  return markerHash([
    normalizeSeverity(finding.severity),
    normalizeFile(finding.file),
    String(finding.newLine ?? finding.oldLine ?? ''),
    normalizeTitle(finding.title),
    normalizeBody(finding.body),
  ])
}

export function gitLabReviewFindingPublicationMarkers(input: {
  runId: string
  finding: ReviewFinding
}) {
  const findingKey = gitLabReviewFindingKey(input.finding)
  return {
    findingKey,
    inlineMarker: gitLabReviewPublicationMarker({
      runId: input.runId,
      kind: 'inline',
      findingKey,
    }),
    fallbackMarker: gitLabReviewPublicationMarker({
      runId: input.runId,
      kind: 'fallback',
      findingKey,
    }),
  }
}

export function gitLabReviewPublicationMarker(input: GitLabReviewPublicationMarkerInput): string {
  const runId = encodeURIComponent(input.runId)
  const hash = input.findingKey && /^[a-f0-9]{24}$/.test(input.findingKey)
    ? input.findingKey
    : markerHash([input.findingKey ?? input.kind])
  return `<!-- nine1bot:gitlab-review-publication:${MARKER_VERSION}:${runId}:${input.kind}:${hash} -->`
}

function markerHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, MARKER_HASH_LENGTH)
}

function normalizeSeverity(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeFile(value: string | undefined): string {
  return normalizeText(value ?? '').replace(/\\/g, '/')
}

function normalizeTitle(value: string): string {
  return normalizeText(value).toLowerCase().replace(/\s+/g, ' ')
}

function normalizeBody(value: string): string {
  return normalizeText(value)
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}
