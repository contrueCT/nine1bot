import { GitLabApiError, type GitLabApiClient } from './api-client'
import { aggregateReviewFindings } from './finding-aggregator'
import { renderReviewSummaryComment } from './comment-renderer'
import { renderInlineFindingBody, validateGitLabInlinePosition } from './inline-position'
import { gitLabReviewFindingPublicationMarkers, gitLabReviewPublicationMarker } from './publication-markers'
import {
  assertGitLabReviewRenderedBodyBudget,
  encodeGitLabReviewPublicationForm,
  snapshotGitLabReviewPublicationContent,
} from './publication-budget'
import type { AggregatedReviewFinding, GitLabDiffManifest, GitLabReviewObjectType, ReviewFinding } from './types'

export type GitLabReviewPreparedReviewFinding = Readonly<
  Omit<ReviewFinding, 'suggestion'>
  & { suggestion?: Readonly<NonNullable<ReviewFinding['suggestion']>> }
>

export type GitLabReviewPreparedAggregatedFinding = Readonly<
  Omit<AggregatedReviewFinding, 'duplicates' | 'sources' | 'suggestion'>
  & {
    duplicates: readonly GitLabReviewPreparedReviewFinding[]
    sources: readonly string[]
    suggestion?: Readonly<NonNullable<ReviewFinding['suggestion']>>
  }
>

export type GitLabReviewPreparedFinding = Readonly<{
  finding: GitLabReviewPreparedAggregatedFinding
  markers?: Readonly<ReturnType<typeof gitLabReviewFindingPublicationMarkers>>
}>

export type GitLabReviewPreparedNote = Readonly<{
  body: string
  marker?: string
  encodedBytes: number
}>

export type GitLabReviewPreparedSummary = GitLabReviewPreparedNote & Readonly<{
  canonicalBody: string
  fallbackMarkers: readonly string[]
}>

export type GitLabReviewPreparedInline = Readonly<{
  finding: GitLabReviewPreparedAggregatedFinding
  body: string
  position: Readonly<Record<string, unknown>>
  inlineMarker?: string
  fallback: GitLabReviewPreparedNote
  encodedBytes: number
}>

export type GitLabReviewPreparedSummaryFallback = GitLabReviewPreparedNote & Readonly<{
  finding: GitLabReviewPreparedAggregatedFinding
  warning?: string
}>

export type GitLabReviewPreparedMarkerCatalog = Readonly<{
  summaryMarker?: string
  legacyFallbackMarker?: string
  fallbackMarkers: readonly string[]
  inlineMarkers: readonly string[]
  summaryFallbackMarkers: readonly string[]
  expectedMarkers: readonly string[]
}>

export type PrepareGitLabReviewPublicationPlanInput = {
  runId?: string
  objectType: GitLabReviewObjectType
  manifest: GitLabDiffManifest
  summary: string
  findings: ReviewFinding[]
  inlineComments: boolean
  warnings?: string[]
}

export type GitLabReviewPreparedPublicationPlan = Readonly<{
  resource: 'merge_requests' | 'repository/commits'
  summaryText: string
  findings: readonly GitLabReviewPreparedFinding[]
  summary: GitLabReviewPreparedSummary
  inline: readonly GitLabReviewPreparedInline[]
  summaryFallbacks: readonly GitLabReviewPreparedSummaryFallback[]
  warnings: readonly string[]
  baseWarnings: readonly string[]
  initialFallbackPosted: number
  markerCatalog: GitLabReviewPreparedMarkerCatalog
}>

export type GitLabReviewPublicationContext = {
  runId: string
  completedMarkers: ReadonlySet<string>
  onMarkerCompleted(marker: string): Promise<void> | void
}

export type PublishGitLabReviewInput = PrepareGitLabReviewPublicationPlanInput & {
  client: Pick<GitLabApiClient, 'createNote' | 'createDiscussion'>
  projectId: string | number
  objectId: string | number
  publication?: GitLabReviewPublicationContext
  plan?: GitLabReviewPreparedPublicationPlan
}

export type PublishGitLabReviewResult = {
  summaryPosted: boolean
  inlinePosted: number
  fallbackPosted: number
  warnings: string[]
}

export function aggregateGitLabReviewPublicationFindings(findings: ReviewFinding[]) {
  return aggregateReviewFindings(findings)
}

export function buildGitLabReviewPublicationPlan(input: {
  findings: ReviewFinding[]
  runId?: string
}) {
  const findings = aggregateGitLabReviewPublicationFindings(input.findings).map((finding) => ({
    finding,
    markers: input.runId
      ? gitLabReviewFindingPublicationMarkers({ runId: input.runId, finding })
      : undefined,
  }))
  return {
    summaryMarker: input.runId
      ? gitLabReviewPublicationMarker({ runId: input.runId, kind: 'summary' })
      : undefined,
    findings,
  }
}

export function prepareGitLabReviewPublicationPlan(
  input: PrepareGitLabReviewPublicationPlanInput,
): GitLabReviewPreparedPublicationPlan {
  const snapshot = snapshotGitLabReviewPublicationContent({
    runId: input.runId,
    summary: input.summary,
    findings: input.findings,
    warnings: input.warnings,
  })
  const markerPlan = buildGitLabReviewPublicationPlan({
    findings: snapshot.findings,
    runId: snapshot.runId,
  })
  const resource = resourceForObject(input.objectType)
  const baseWarnings = [...(snapshot.warnings ?? [])]
  const warnings = [...baseWarnings]
  const summaryFindings: typeof markerPlan.findings = input.inlineComments && input.objectType === 'mr'
    ? []
    : [...markerPlan.findings]
  const inlineCandidates: Array<{
    publicationFinding: (typeof markerPlan.findings)[number]
    position: Record<string, unknown>
  }> = []
  const summaryWarnings = new Map<(typeof markerPlan.findings)[number], string>()
  let initialFallbackPosted = 0

  if (input.inlineComments && input.objectType === 'mr') {
    for (const publicationFinding of markerPlan.findings) {
      const validation = validateGitLabInlinePosition(
        publicationFinding.finding,
        input.manifest.files,
        input.manifest.diffRefs,
      )
      if (validation.ok) {
        inlineCandidates.push({ publicationFinding, position: { ...validation.position } })
        continue
      }
      const warning = `Inline fallback for ${publicationFinding.finding.file ?? publicationFinding.finding.title}: ${validation.reason}`
      summaryFindings.push(publicationFinding)
      summaryWarnings.set(publicationFinding, warning)
      warnings.push(warning)
      initialFallbackPosted += 1
    }
  } else if (input.inlineComments && input.objectType === 'commit') {
    const warning = 'Inline comments are skipped for commit review runs; findings are included in the summary comment.'
    baseWarnings.push(warning)
    warnings.push(warning)
  }

  const preparedFindings = markerPlan.findings.map(({ finding, markers }) => Object.freeze({
    finding: freezeAggregatedFinding(finding),
    markers: markers ? Object.freeze({ ...markers }) : undefined,
  }))
  const preparedByFinding = new Map(markerPlan.findings.map((finding, index) => (
    [finding, preparedFindings[index]!] as const
  )))
  const preparedSummaryFindings = summaryFindings.map((finding) => preparedByFinding.get(finding)!)
  const preparedInlineFindings = inlineCandidates.map(({ publicationFinding }) => (
    preparedByFinding.get(publicationFinding)!
  ))

  const summaryCanonicalBody = renderReviewSummaryComment({
    summary: snapshot.summary,
    findings: preparedSummaryFindings.map(({ finding }) => mutableAggregatedFinding(finding)),
    inlineFindings: preparedInlineFindings.map(({ finding }) => mutableAggregatedFinding(finding)),
    manifest: input.manifest,
    warnings,
  })
  const summaryFallbackMarkers = preparedSummaryFindings.flatMap(({ markers }) => (
    markers ? [markers.fallbackMarker] : []
  ))
  const summary = freezeSummaryOperation({
    canonicalBody: summaryCanonicalBody,
    body: withMarkers(summaryCanonicalBody, [markerPlan.summaryMarker, ...summaryFallbackMarkers]),
    marker: markerPlan.summaryMarker,
    fallbackMarkers: summaryFallbackMarkers,
    resource,
  })

  const summaryFallbacks = summaryFindings.map((publicationFinding) => freezeSummaryFallbackOperation({
    preparedFinding: preparedByFinding.get(publicationFinding)!,
    resource,
    manifest: input.manifest,
    warnings,
    warning: summaryWarnings.get(publicationFinding),
  }))
  const inline = inlineCandidates.map(({ publicationFinding, position }) => {
    const preparedFinding = preparedByFinding.get(publicationFinding)!
    const inlineMarker = preparedFinding.markers?.inlineMarker
    const body = checkedRenderedBody(withMarkers(
      renderInlineFindingBody(mutableAggregatedFinding(preparedFinding.finding)),
      [inlineMarker],
    ))
    const frozenPosition = Object.freeze({ ...position })
    const encoded = encodeGitLabReviewPublicationForm({
      type: 'discussion',
      body,
      position: frozenPosition,
    })
    return Object.freeze({
      finding: preparedFinding.finding,
      body,
      position: frozenPosition,
      inlineMarker,
      fallback: freezeFallbackOperation({
        preparedFinding,
        resource,
        manifest: input.manifest,
        warnings,
      }),
      encodedBytes: encoded.encodedBytes,
    })
  })

  const fallbackMarkers = preparedFindings.flatMap(({ markers }) => markers ? [markers.fallbackMarker] : [])
  const inlineMarkers = preparedFindings.flatMap(({ markers }) => markers ? [markers.inlineMarker] : [])
  const legacyFallbackMarker = snapshot.runId
    ? gitLabReviewPublicationMarker({ runId: snapshot.runId, kind: 'fallback' })
    : undefined
  const expectedMarkers = [
    markerPlan.summaryMarker,
    legacyFallbackMarker,
    ...fallbackMarkers,
    ...inlineMarkers,
  ].filter((marker): marker is string => Boolean(marker))
  const markerCatalog = Object.freeze({
    summaryMarker: markerPlan.summaryMarker,
    legacyFallbackMarker,
    fallbackMarkers: Object.freeze(fallbackMarkers),
    inlineMarkers: Object.freeze(inlineMarkers),
    summaryFallbackMarkers: Object.freeze([...summaryFallbackMarkers]),
    expectedMarkers: Object.freeze(expectedMarkers),
  })

  return Object.freeze({
    resource,
    summaryText: snapshot.summary,
    findings: Object.freeze(preparedFindings),
    summary,
    inline: Object.freeze(inline),
    summaryFallbacks: Object.freeze(summaryFallbacks),
    warnings: Object.freeze([...warnings]),
    baseWarnings: Object.freeze([...baseWarnings]),
    initialFallbackPosted,
    markerCatalog,
  })
}

export function isGitLabReviewPublicationComplete(input: {
  completedMarkers: ReadonlySet<string>
  plan: GitLabReviewPreparedPublicationPlan
} | {
  completedMarkers: ReadonlySet<string>
  runId: string
  findings: ReviewFinding[]
}) {
  if ('plan' in input) {
    const summaryMarker = input.plan.summary.marker
    if (!summaryMarker || !input.completedMarkers.has(summaryMarker)) return false
    return input.plan.findings.every(({ markers }) => Boolean(
      markers
      && (
        input.completedMarkers.has(markers.inlineMarker)
        || input.completedMarkers.has(markers.fallbackMarker)
      ),
    ))
  }
  const markerPlan = buildGitLabReviewPublicationPlan({ runId: input.runId, findings: input.findings })
  if (!markerPlan.summaryMarker || !input.completedMarkers.has(markerPlan.summaryMarker)) return false
  return markerPlan.findings.every(({ markers }) => Boolean(
    markers
    && (
      input.completedMarkers.has(markers.inlineMarker)
      || input.completedMarkers.has(markers.fallbackMarker)
    ),
  ))
}

export async function publishGitLabReviewResult(input: PublishGitLabReviewInput): Promise<PublishGitLabReviewResult> {
  const plan = input.plan ?? prepareGitLabReviewPublicationPlan({
    ...input,
    runId: input.runId ?? input.publication?.runId,
  })
  const warnings = [...plan.warnings]
  let inlinePosted = 0
  let fallbackPosted = plan.initialFallbackPosted
  let summaryPosted = false

  if (!isCompleted(input.publication, plan.summary.marker)) {
    await input.client.createNote({
      projectId: input.projectId,
      resource: plan.resource,
      resourceId: input.objectId,
      body: plan.summary.body,
    })
    summaryPosted = true
    await completeMarker(input.publication, plan.summary.marker)
    for (const marker of plan.summary.fallbackMarkers) await completeMarker(input.publication, marker)
  } else if (input.publication) {
    for (const fallback of plan.summaryFallbacks) {
      if (isCompleted(input.publication, fallback.marker)) continue
      await input.client.createNote({
        projectId: input.projectId,
        resource: plan.resource,
        resourceId: input.objectId,
        body: fallback.body,
      })
      await completeMarker(input.publication, fallback.marker)
    }
  }

  for (const operation of plan.inline) {
    if (
      isCompleted(input.publication, operation.inlineMarker)
      || isCompleted(input.publication, operation.fallback.marker)
    ) {
      continue
    }
    try {
      await input.client.createDiscussion({
        projectId: input.projectId,
        resource: plan.resource,
        resourceId: input.objectId,
        body: operation.body,
        position: operation.position,
      })
      inlinePosted += 1
      await completeMarker(input.publication, operation.inlineMarker)
    } catch (error) {
      if (!(error instanceof GitLabApiError) || error.status !== 400) throw error
      const detail = summarizeGitLabApiError(error)
      warnings.push(
        `Inline fallback for ${operation.finding.file ?? operation.finding.title}: GitLab API returned 400${detail ? `: ${detail}` : ''}.`,
      )
      fallbackPosted += 1
      await input.client.createNote({
        projectId: input.projectId,
        resource: plan.resource,
        resourceId: input.objectId,
        body: operation.fallback.body,
      })
      await completeMarker(input.publication, operation.fallback.marker)
    }
  }

  return { summaryPosted, inlinePosted, fallbackPosted, warnings }
}

function freezeSummaryOperation(input: {
  canonicalBody: string
  body: string
  marker?: string
  fallbackMarkers: string[]
  resource: 'merge_requests' | 'repository/commits'
}): GitLabReviewPreparedSummary {
  const body = checkedRenderedBody(input.body)
  const encoded = encodeGitLabReviewPublicationForm({ type: 'note', resource: input.resource, body })
  return Object.freeze({
    canonicalBody: input.canonicalBody,
    body,
    marker: input.marker,
    fallbackMarkers: Object.freeze([...input.fallbackMarkers]),
    encodedBytes: encoded.encodedBytes,
  })
}

function freezeSummaryFallbackOperation(input: {
  preparedFinding: GitLabReviewPreparedFinding
  resource: 'merge_requests' | 'repository/commits'
  manifest: GitLabDiffManifest
  warnings: string[]
  warning?: string
}): GitLabReviewPreparedSummaryFallback {
  const fallback = freezeFallbackOperation(input)
  return Object.freeze({
    ...fallback,
    finding: input.preparedFinding.finding,
    warning: input.warning,
  })
}

function freezeFallbackOperation(input: {
  preparedFinding: GitLabReviewPreparedFinding
  resource: 'merge_requests' | 'repository/commits'
  manifest: GitLabDiffManifest
  warnings: string[]
}): GitLabReviewPreparedNote {
  const canonicalBody = renderReviewSummaryComment({
    title: 'Nine1bot Inline Publish Fallback',
    summary: 'A validated inline comment could not be posted as a GitLab diff thread after the summary was created.',
    findings: [mutableAggregatedFinding(input.preparedFinding.finding)],
    manifest: input.manifest,
    warnings: input.warnings,
  })
  const body = checkedRenderedBody(withMarkers(canonicalBody, [input.preparedFinding.markers?.fallbackMarker]))
  const encoded = encodeGitLabReviewPublicationForm({ type: 'note', resource: input.resource, body })
  return Object.freeze({
    body,
    marker: input.preparedFinding.markers?.fallbackMarker,
    encodedBytes: encoded.encodedBytes,
  })
}

function checkedRenderedBody(body: string) {
  assertGitLabReviewRenderedBodyBudget(body)
  return body
}

function withMarkers(body: string, markers: Array<string | undefined>) {
  const completed = markers.filter((marker): marker is string => Boolean(marker))
  return completed.length > 0 ? `${body}\n\n${completed.join('\n')}` : body
}

function resourceForObject(objectType: GitLabReviewObjectType): 'merge_requests' | 'repository/commits' {
  return objectType === 'mr' ? 'merge_requests' : 'repository/commits'
}

function isCompleted(publication: GitLabReviewPublicationContext | undefined, marker: string | undefined) {
  return marker !== undefined && publication?.completedMarkers.has(marker) === true
}

async function completeMarker(publication: GitLabReviewPublicationContext | undefined, marker: string | undefined) {
  if (publication && marker) await publication.onMarkerCompleted(marker)
}

function summarizeGitLabApiError(error: GitLabApiError) {
  return error.sanitizedDetail
}

function freezeAggregatedFinding(finding: AggregatedReviewFinding): GitLabReviewPreparedAggregatedFinding {
  const duplicates = finding.duplicates.map((duplicate) => Object.freeze({
    ...duplicate,
    suggestion: duplicate.suggestion ? Object.freeze({ ...duplicate.suggestion }) : undefined,
  }))
  return Object.freeze({
    ...finding,
    suggestion: finding.suggestion ? Object.freeze({ ...finding.suggestion }) : undefined,
    sources: Object.freeze([...finding.sources]),
    duplicates: Object.freeze(duplicates),
  })
}

function mutableAggregatedFinding(finding: GitLabReviewPreparedAggregatedFinding): AggregatedReviewFinding {
  return finding as AggregatedReviewFinding
}
