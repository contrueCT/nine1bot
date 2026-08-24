import type { ReviewFinding } from './types'

export const GITLAB_REVIEW_PUBLICATION_INPUT_TOO_LARGE = 'gitlab_review_publication_input_too_large'

export const gitLabReviewPublicationBudget = Object.freeze({
  maxFindings: 500,
  maxWarnings: 500,
  maxTotalCodeUnits: 256_000,
  maxTotalUtf8Bytes: 512_000,
  maxMetadataFieldCodeUnits: 4_096,
  maxWarningCodeUnits: 16_384,
  maxAggregateBodyCodeUnits: 256_000,
  maxAggregateBodyUtf8Bytes: 512_000,
  maxRenderedBodyCodeUnits: 512_000,
  maxRenderedBodyUtf8Bytes: 1_024_000,
  maxOutboundFormBytes: 2_000_000,
  maxManagementRequestBytes: 2_000_000,
})

export class GitLabReviewPublicationBudgetError extends Error {
  constructor() {
    super(GITLAB_REVIEW_PUBLICATION_INPUT_TOO_LARGE)
  }
}

export type GitLabReviewPublicationContent = {
  runId?: string
  stage?: string
  summary: string
  findings: ReviewFinding[]
  warnings?: string[]
}

export function snapshotGitLabReviewPublicationContent(
  input: GitLabReviewPublicationContent,
): GitLabReviewPublicationContent {
  const findingsInput = input.findings
  if (!Array.isArray(findingsInput) || findingsInput.length > gitLabReviewPublicationBudget.maxFindings) {
    throw new GitLabReviewPublicationBudgetError()
  }
  const warningsInput = input.warnings
  if (warningsInput !== undefined && (
    !Array.isArray(warningsInput)
    || warningsInput.length > gitLabReviewPublicationBudget.maxWarnings
  )) {
    throw new GitLabReviewPublicationBudgetError()
  }

  const budget = publicationTextBudget()
  const runId = snapshotOptionalString(input.runId, gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits, budget)
  const stage = snapshotOptionalString(input.stage, gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits, budget)
  const summary = snapshotRequiredString(input.summary, gitLabReviewPublicationBudget.maxTotalCodeUnits, budget)
  const warnings = warningsInput?.map((warning) => (
    snapshotRequiredString(warning, gitLabReviewPublicationBudget.maxWarningCodeUnits, budget)
  ))
  const findings = findingsInput.map((finding): ReviewFinding => {
    const id = snapshotOptionalString(finding.id, gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits, budget)
    const title = snapshotRequiredString(
      finding.title,
      gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits,
      budget,
    )
    const body = snapshotRequiredString(finding.body, gitLabReviewPublicationBudget.maxTotalCodeUnits, budget)
    const category = snapshotOptionalString(
      finding.category,
      gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits,
      budget,
    )
    const file = snapshotOptionalString(
      finding.file,
      gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits,
      budget,
    )
    const source = snapshotOptionalString(
      finding.source,
      gitLabReviewPublicationBudget.maxMetadataFieldCodeUnits,
      budget,
    )
    const suggestionInput = finding.suggestion
    let suggestion: ReviewFinding['suggestion']
    if (suggestionInput !== undefined) {
      suggestion = {
        replacement: snapshotRequiredString(
          suggestionInput.replacement,
          gitLabReviewPublicationBudget.maxTotalCodeUnits,
          budget,
        ),
        confidence: suggestionInput.confidence,
      }
    }
    return {
      id,
      title,
      body,
      severity: finding.severity,
      category,
      file,
      oldLine: finding.oldLine,
      newLine: finding.newLine,
      suggestion,
      source,
    }
  })

  return { runId, stage, summary, findings, warnings }
}

export function assertGitLabReviewAggregateBodyBudget(body: string) {
  assertStringBudget(
    body,
    gitLabReviewPublicationBudget.maxAggregateBodyCodeUnits,
    gitLabReviewPublicationBudget.maxAggregateBodyUtf8Bytes,
  )
}

export function assertGitLabReviewRenderedBodyBudget(body: string) {
  assertStringBudget(
    body,
    gitLabReviewPublicationBudget.maxRenderedBodyCodeUnits,
    gitLabReviewPublicationBudget.maxRenderedBodyUtf8Bytes,
  )
}

export type GitLabReviewPublicationFormInput =
  | {
      type: 'note'
      resource: 'merge_requests' | 'repository/commits'
      body: string
    }
  | {
      type: 'discussion'
      body: string
      position?: Readonly<Record<string, unknown>>
    }

export type GitLabReviewEncodedPublicationForm = Readonly<{
  form: URLSearchParams
  encodedBytes: number
}>

export function encodeGitLabReviewPublicationForm(
  input: GitLabReviewPublicationFormInput,
): GitLabReviewEncodedPublicationForm {
  const form = input.type === 'note' && input.resource === 'repository/commits'
    ? new URLSearchParams({ note: input.body })
    : new URLSearchParams({ body: input.body })
  if (input.type === 'discussion' && input.position) {
    for (const [key, value] of Object.entries(input.position)) {
      if (value === undefined || value === null) continue
      form.set(`position[${key}]`, String(value))
    }
  }
  const encodedBytes = utf8Length(form.toString())
  if (encodedBytes > gitLabReviewPublicationBudget.maxOutboundFormBytes) {
    throw new GitLabReviewPublicationBudgetError()
  }
  return Object.freeze({ form, encodedBytes })
}

function publicationTextBudget() {
  let codeUnits = 0
  let utf8Bytes = 0
  return (value: string, maxFieldCodeUnits: number) => {
    if (value.length > maxFieldCodeUnits) throw new GitLabReviewPublicationBudgetError()
    codeUnits += value.length
    if (codeUnits > gitLabReviewPublicationBudget.maxTotalCodeUnits) {
      throw new GitLabReviewPublicationBudgetError()
    }
    utf8Bytes += utf8Length(value)
    if (utf8Bytes > gitLabReviewPublicationBudget.maxTotalUtf8Bytes) {
      throw new GitLabReviewPublicationBudgetError()
    }
  }
}

function snapshotRequiredString(
  value: string,
  maxFieldCodeUnits: number,
  add: ReturnType<typeof publicationTextBudget>,
) {
  if (typeof value !== 'string') throw new GitLabReviewPublicationBudgetError()
  add(value, maxFieldCodeUnits)
  return value
}

function snapshotOptionalString(
  value: string | undefined,
  maxFieldCodeUnits: number,
  add: ReturnType<typeof publicationTextBudget>,
) {
  if (value === undefined) return undefined
  return snapshotRequiredString(value, maxFieldCodeUnits, add)
}

function assertStringBudget(value: string, maxCodeUnits: number, maxUtf8Bytes: number) {
  if (value.length > maxCodeUnits || utf8Length(value) > maxUtf8Bytes) {
    throw new GitLabReviewPublicationBudgetError()
  }
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength
}
