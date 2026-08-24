import type { ReviewFinding } from './types'
import {
  GitLabReviewPublicationBudgetError,
  gitLabReviewPublicationBudget,
  snapshotGitLabReviewPublicationContent,
} from './publication-budget'

export type ReviewStageResult = {
  stage: string
  status: 'ok' | 'blocked' | 'failed'
  summary: string
  findings: ReviewFinding[]
  nextActions?: string[]
}

export const reviewStageResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'status', 'summary', 'findings'],
  properties: {
    stage: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'blocked', 'failed'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['title', 'body', 'severity'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical', 'blocker'] },
          category: { type: 'string' },
          file: { type: 'string' },
          oldLine: { type: 'number' },
          newLine: { type: 'number' },
          suggestion: {
            type: 'object',
            additionalProperties: false,
            required: ['replacement'],
            properties: {
              replacement: { type: 'string' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
          source: { type: 'string' },
        },
      },
    },
    nextActions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} satisfies Record<string, unknown>

export function parseReviewStageResult(input: unknown, options: { runId?: string } = {}): ReviewStageResult {
  if (!isRecord(input)) throw new Error('Review stage result must be an object.')
  const findingsInput = input.findings
  if (!Array.isArray(findingsInput)) throw new Error('Review stage result findings must be an array.')
  if (findingsInput.length > gitLabReviewPublicationBudget.maxFindings) {
    throw new GitLabReviewPublicationBudgetError()
  }
  const nextActionsInput = input.nextActions
  if (Array.isArray(nextActionsInput) && nextActionsInput.length > gitLabReviewPublicationBudget.maxWarnings) {
    throw new GitLabReviewPublicationBudgetError()
  }
  const parsed = {
    runId: options.runId,
    stage: stringField(input.stage, 'stage'),
    summary: stringField(input.summary, 'summary'),
    findings: findingsInput.map(parseFinding),
    warnings: Array.isArray(nextActionsInput)
      ? nextActionsInput.filter((item): item is string => typeof item === 'string')
      : undefined,
  }
  const snapshot = snapshotGitLabReviewPublicationContent(parsed)
  return {
    stage: snapshot.stage!,
    status: statusField(input.status),
    summary: snapshot.summary,
    findings: snapshot.findings,
    nextActions: snapshot.warnings,
  }
}

function parseFinding(input: unknown): ReviewFinding {
  if (!isRecord(input)) throw new Error('Review finding must be an object.')
  return {
    id: optionalString(input.id),
    title: stringField(input.title, 'finding.title'),
    body: stringField(input.body, 'finding.body'),
    severity: severityField(input.severity),
    category: optionalString(input.category),
    file: optionalString(input.file),
    oldLine: optionalNumber(input.oldLine),
    newLine: optionalNumber(input.newLine),
    suggestion: optionalSuggestion(input.suggestion),
    source: optionalString(input.source),
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function stringField(input: unknown, field: string) {
  if (typeof input !== 'string') throw new Error(`${field} must be a string.`)
  return input
}

function optionalString(input: unknown) {
  return typeof input === 'string' ? input : undefined
}

function optionalNumber(input: unknown) {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined
}

function optionalSuggestion(input: unknown): ReviewFinding['suggestion'] {
  if (!isRecord(input)) return undefined
  const replacement = optionalString(input.replacement)
  if (!replacement) return undefined
  const confidence = suggestionConfidence(input.confidence)
  return {
    replacement,
    confidence,
  }
}

function suggestionConfidence(input: unknown): NonNullable<ReviewFinding['suggestion']>['confidence'] | undefined {
  if (input === 'low' || input === 'medium' || input === 'high') return input
  return undefined
}

function statusField(input: unknown): ReviewStageResult['status'] {
  if (input === 'ok' || input === 'blocked' || input === 'failed') return input
  throw new Error('status must be ok, blocked, or failed.')
}

function severityField(input: unknown): ReviewFinding['severity'] {
  if (input === 'info' || input === 'minor' || input === 'major' || input === 'critical' || input === 'blocker') return input
  throw new Error('finding.severity is invalid.')
}
