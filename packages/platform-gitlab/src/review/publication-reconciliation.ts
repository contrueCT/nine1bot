import { renderReviewFindingItem, renderReviewSummaryComment } from './comment-renderer'
import type { GitLabPublishedComment } from './api-client'
import { validateGitLabInlinePosition } from './inline-position'
import { gitLabReviewPublicationMarker } from './publication-markers'
import {
  buildGitLabReviewPublicationPlan,
  type GitLabReviewPreparedPublicationPlan,
} from './publisher'
import {
  GitLabReviewPublicationBudgetError,
  snapshotGitLabReviewPublicationContent,
} from './publication-budget'
import type {
  AggregatedReviewFinding,
  GitLabDiffManifest,
  GitLabReviewObjectType,
  ReviewFinding,
} from './types'

export const GITLAB_REVIEW_LEGACY_PUBLICATION_AMBIGUOUS = 'gitlab_review_publication_legacy_ambiguous'

const RECONCILIATION_COMMENT_CODE_UNIT_BUDGET = 256_000
// Legacy reconciliation is synchronous, so unique bodies and canonical finding patterns share one fixed budget.
const LEGACY_COMPATIBILITY_CODE_UNIT_BUDGET = 256_000
const PUBLICATION_MARKER_PREFIX = '<!-- nine1bot:gitlab-review-publication:'

export class GitLabReviewPublicationCompatibilityError extends Error {
  constructor() {
    super(GITLAB_REVIEW_LEGACY_PUBLICATION_AMBIGUOUS)
  }
}

export function reconcileGitLabReviewPublicationMarkers(input: {
  runId: string
  objectType: GitLabReviewObjectType
  inlineComments: boolean
  summary: string
  findings: ReviewFinding[]
  manifest: GitLabDiffManifest
  warnings?: string[]
  notes: GitLabPublishedComment[]
  discussions: GitLabPublishedComment[]
  plan?: GitLabReviewPreparedPublicationPlan
}) {
  const snapshot = snapshotReconciliationInput(input)
  const publicationPlan = input.plan
    ? publicationPlanFromPrepared(input.plan)
    : buildGitLabReviewPublicationPlan({ runId: snapshot.runId, findings: snapshot.findings })
  const summaryMarker = requiredMarker(publicationPlan.summaryMarker)
  const layout = input.plan
    ? buildPreparedPublicationLayout(input.plan, publicationPlan.findings)
    : buildLegacyPublicationLayout(snapshot, publicationPlan.findings)
  const markerCatalog = input.plan
    ? buildMarkerCatalogFromPrepared(snapshot.runId, input.plan)
    : buildMarkerCatalog({
        runId: snapshot.runId,
        summaryMarker,
        findings: publicationPlan.findings,
        summaryFindings: layout.summaryFindings,
      })
  const scanCache = new Map<string, ExtractedMarkerBody>()
  const notes = scanUniqueComments(snapshot.notes, 'note', markerCatalog, scanCache)
  const discussions = scanUniqueComments(snapshot.discussions, 'discussion', markerCatalog, scanCache)
  const completed = new Set<string>()

  for (const note of notes) {
    for (const marker of note.markers) {
      if (marker !== markerCatalog.legacyFallbackMarker) completed.add(marker)
    }
  }
  for (const discussion of discussions) {
    for (const marker of discussion.markers) completed.add(marker)
  }

  const legacyFallbackNotes = notes.filter((note) => note.markers.includes(markerCatalog.legacyFallbackMarker))
  const needsLegacySummary = layout.summaryFindings.some((finding) => !findingCompleted(finding, completed))
  const legacySummaryNotes = needsLegacySummary
    ? notes.filter((note) => note.markers.includes(summaryMarker))
    : []

  if (legacyFallbackNotes.length > 0 || needsLegacySummary) {
    const compatibility = buildLegacyCompatibilityContext({
      notes: [...legacyFallbackNotes, ...legacySummaryNotes],
      findings: uniqueFindings([
        ...(legacyFallbackNotes.length > 0 ? layout.inlineFindings : []),
        ...(needsLegacySummary ? layout.summaryFindings : []),
      ]),
    })
    reconcileLegacyRunFallbacks({
      notes: legacyFallbackNotes,
      manifest: snapshot.manifest,
      candidates: layout.inlineFindings,
      warnings: [
        ...layout.warnings,
        ...layout.summaryFindings.flatMap((finding) => {
          const warning = layout.summaryWarnings.get(finding)
          return warning ? [warning] : []
        }),
      ],
      compatibility,
      completed,
    })
    reconcileLegacySummaryFindings({
      notes: legacySummaryNotes,
      summary: snapshot.summary,
      manifest: snapshot.manifest,
      warnings: layout.warnings,
      summaryWarnings: layout.summaryWarnings,
      summaryFindings: layout.summaryFindings,
      inlineFindings: layout.inlineFindings,
      compatibility,
      completed,
    })
  }

  return [
    ...(completed.has(summaryMarker) ? [summaryMarker] : []),
    ...publicationPlan.findings.flatMap(({ markers }) => {
      return markers && completed.has(markers.fallbackMarker) ? [markers.fallbackMarker] : []
    }),
    ...publicationPlan.findings.flatMap(({ markers }) => {
      return markers && completed.has(markers.inlineMarker) ? [markers.inlineMarker] : []
    }),
  ]
}

function snapshotReconciliationInput(
  input: Parameters<typeof reconcileGitLabReviewPublicationMarkers>[0],
): Parameters<typeof reconcileGitLabReviewPublicationMarkers>[0] {
  let publicationInput: ReturnType<typeof snapshotGitLabReviewPublicationContent>
  if (input.plan) {
    publicationInput = {
      runId: input.runId,
      summary: input.plan.summaryText,
      findings: input.plan.findings.map(({ finding }) => finding as ReviewFinding),
      warnings: [...input.plan.baseWarnings],
    }
  } else {
    try {
      publicationInput = snapshotGitLabReviewPublicationContent({
        runId: input.runId,
        summary: input.summary,
        findings: input.findings,
        warnings: input.warnings,
      })
    } catch (error) {
      if (error instanceof GitLabReviewPublicationBudgetError) {
        throw new GitLabReviewPublicationCompatibilityError()
      }
      throw error
    }
  }

  const commentBodies = new Set<string>()
  let commentCodeUnits = 0
  const snapshotComments = (comments: GitLabPublishedComment[]) => comments.map((comment) => {
    const body = snapshotRequiredReconciliationString(comment.body)
    if (body.length > RECONCILIATION_COMMENT_CODE_UNIT_BUDGET) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
    if (!commentBodies.has(body)) {
      commentCodeUnits = addReconciliationInputCodeUnits(
        commentCodeUnits,
        body.length,
        RECONCILIATION_COMMENT_CODE_UNIT_BUDGET,
      )
      commentBodies.add(body)
    }
    return { id: comment.id, body }
  })
  const notes = snapshotComments(input.notes)
  const discussions = snapshotComments(input.discussions)

  return {
    runId: publicationInput.runId!,
    objectType: input.objectType,
    inlineComments: input.inlineComments,
    summary: publicationInput.summary,
    findings: publicationInput.findings,
    manifest: input.manifest,
    warnings: publicationInput.warnings,
    notes,
    discussions,
    plan: input.plan,
  }
}

function snapshotRequiredReconciliationString(value: string) {
  if (typeof value !== 'string') throw new GitLabReviewPublicationCompatibilityError()
  return value
}

function addReconciliationInputCodeUnits(current: number, amount: number, budget: number) {
  const next = current + amount
  if (next > budget) throw new GitLabReviewPublicationCompatibilityError()
  return next
}

type PublicationFinding = ReturnType<typeof buildGitLabReviewPublicationPlan>['findings'][number]

function publicationPlanFromPrepared(plan: GitLabReviewPreparedPublicationPlan): {
  summaryMarker?: string
  findings: PublicationFinding[]
} {
  return {
    summaryMarker: plan.markerCatalog.summaryMarker,
    findings: plan.findings.map(({ finding, markers }) => ({
      finding: finding as AggregatedReviewFinding,
      markers: markers ? { ...markers } : undefined,
    })),
  }
}

function buildPreparedPublicationLayout(
  plan: GitLabReviewPreparedPublicationPlan,
  findings: PublicationFinding[],
) {
  const preparedByFinding = new Map(plan.findings.map(({ finding }, index) => (
    [finding, findings[index]!] as const
  )))
  const summaryWarnings = new Map<PublicationFinding, string>()
  const summaryFindings = plan.summaryFallbacks.map((fallback) => {
    const finding = requiredPreparedFinding(preparedByFinding.get(fallback.finding))
    if (fallback.warning) summaryWarnings.set(finding, fallback.warning)
    return finding
  })
  const inlineFindings = plan.inline.map(({ finding }) => (
    requiredPreparedFinding(preparedByFinding.get(finding))
  ))
  return {
    warnings: [...plan.baseWarnings],
    summaryWarnings,
    summaryFindings,
    inlineFindings,
  }
}

function requiredPreparedFinding(finding: PublicationFinding | undefined) {
  if (!finding) throw new GitLabReviewPublicationCompatibilityError()
  return finding
}

function buildLegacyPublicationLayout(
  input: {
    objectType: GitLabReviewObjectType
    inlineComments: boolean
    manifest: GitLabDiffManifest
    warnings?: string[]
  },
  findings: PublicationFinding[],
) {
  const warnings = [...(input.warnings ?? [])]
  const summaryWarnings = new Map<PublicationFinding, string>()
  const summaryFindings: PublicationFinding[] = input.inlineComments && input.objectType === 'mr'
    ? []
    : [...findings]
  const inlineFindings: PublicationFinding[] = []

  if (input.inlineComments && input.objectType === 'mr') {
    for (const finding of findings) {
      const validation = validateGitLabInlinePosition(
        finding.finding,
        input.manifest.files,
        input.manifest.diffRefs,
      )
      if (validation.ok) {
        inlineFindings.push(finding)
        continue
      }
      summaryFindings.push(finding)
      summaryWarnings.set(
        finding,
        `Inline fallback for ${finding.finding.file ?? finding.finding.title}: ${validation.reason}`,
      )
    }
  } else if (input.inlineComments && input.objectType === 'commit') {
    warnings.push('Inline comments are skipped for commit review runs; findings are included in the summary comment.')
  }

  return { warnings, summaryWarnings, summaryFindings, inlineFindings }
}

type MarkerCatalog = ReturnType<typeof buildMarkerCatalog>

function buildMarkerCatalog(input: {
  runId: string
  summaryMarker: string
  findings: PublicationFinding[]
  summaryFindings: PublicationFinding[]
}) {
  const fallbackMarkers = input.findings.map(({ markers }) => requiredMarker(markers?.fallbackMarker))
  const inlineMarkers = input.findings.map(({ markers }) => requiredMarker(markers?.inlineMarker))
  const summaryFallbackMarkers = input.summaryFindings.map(({ markers }) => requiredMarker(markers?.fallbackMarker))
  const legacyFallbackMarker = gitLabReviewPublicationMarker({ runId: input.runId, kind: 'fallback' })
  return {
    encodedRunId: encodeURIComponent(input.runId),
    summaryMarker: input.summaryMarker,
    legacyFallbackMarker,
    fallbackMarkers: new Set(fallbackMarkers),
    inlineMarkers: new Set(inlineMarkers),
    summaryFallbackMarkers,
    expectedMarkers: new Set([
      input.summaryMarker,
      legacyFallbackMarker,
      ...fallbackMarkers,
      ...inlineMarkers,
    ]),
  }
}

function buildMarkerCatalogFromPrepared(
  runId: string,
  plan: GitLabReviewPreparedPublicationPlan,
) {
  const summaryMarker = requiredMarker(plan.markerCatalog.summaryMarker)
  const legacyFallbackMarker = requiredMarker(plan.markerCatalog.legacyFallbackMarker)
  return {
    encodedRunId: encodeURIComponent(runId),
    summaryMarker,
    legacyFallbackMarker,
    fallbackMarkers: new Set(plan.markerCatalog.fallbackMarkers),
    inlineMarkers: new Set(plan.markerCatalog.inlineMarkers),
    summaryFallbackMarkers: [...plan.markerCatalog.summaryFallbackMarkers],
    expectedMarkers: new Set(plan.markerCatalog.expectedMarkers),
  }
}

type ExtractedMarkerBody = {
  body: string
  occurrences: Array<{ marker: string; index: number }>
  trailingMarkers: Array<{ marker: string; index: number }>
  strippedBody?: string
}

type ScannedComment = {
  body: string
  markers: string[]
  strippedBody?: string
}

function scanUniqueComments(
  comments: GitLabPublishedComment[],
  source: 'note' | 'discussion',
  catalog: MarkerCatalog,
  cache: Map<string, ExtractedMarkerBody>,
) {
  const unique = new Map<string, ScannedComment>()
  for (const comment of comments) {
    const body = normalizeCommentBody(comment.body)
    if (unique.has(body)) continue
    let extracted = cache.get(body)
    if (!extracted) {
      extracted = extractMarkerBody(body, catalog)
      cache.set(body, extracted)
    }
    unique.set(body, validateMarkerBody(extracted, source, catalog))
  }
  return [...unique.values()]
}

function extractMarkerBody(body: string, catalog: MarkerCatalog): ExtractedMarkerBody {
  const occurrences = scanPublicationMarkerCandidates(body, catalog)
  if (occurrences.length === 0) return { body, occurrences, trailingMarkers: [] }

  const trailingMarkers = extractTrailingMarkerBlock(body, catalog.expectedMarkers)
  if (
    occurrences.length !== trailingMarkers.length
    || occurrences.some((occurrence, index) => {
      const trailing = trailingMarkers[index]
      return occurrence.marker !== trailing?.marker || occurrence.index !== trailing.index
    })
  ) {
    throw new GitLabReviewPublicationCompatibilityError()
  }
  const markerBlockStart = trailingMarkers[0]!.index
  if (markerBlockStart > 0 && !body.slice(0, markerBlockStart).endsWith('\n\n')) {
    throw new GitLabReviewPublicationCompatibilityError()
  }
  let strippedEnd = markerBlockStart
  while (strippedEnd > 0 && body[strippedEnd - 1] === '\n') strippedEnd -= 1
  return {
    body,
    occurrences,
    trailingMarkers,
    strippedBody: body.slice(0, strippedEnd),
  }
}

function scanPublicationMarkerCandidates(
  body: string,
  catalog: MarkerCatalog,
): ExtractedMarkerBody['occurrences'] {
  const occurrences: ExtractedMarkerBody['occurrences'] = []
  let cursor = 0
  while (cursor < body.length) {
    const start = body.indexOf(PUBLICATION_MARKER_PREFIX, cursor)
    if (start < 0) break
    let end = start + PUBLICATION_MARKER_PREFIX.length
    while (end < body.length && body[end] !== '>' && body[end] !== '\r' && body[end] !== '\n') {
      end += 1
    }
    if (body[end] === '>' && body[end - 1] === '-' && body[end - 2] === '-') {
      const marker = body.slice(start, end + 1)
      if (catalog.expectedMarkers.has(marker)) {
        occurrences.push({ marker, index: start })
      } else if (publicationMarkerRunId(marker) === catalog.encodedRunId) {
        throw new GitLabReviewPublicationCompatibilityError()
      }
    }
    cursor = end < body.length ? end + 1 : body.length
  }
  return occurrences
}

function extractTrailingMarkerBlock(body: string, expectedMarkers: ReadonlySet<string>) {
  const reversed: Array<{ marker: string; index: number }> = []
  let lineEnd = body.length
  while (lineEnd >= 0) {
    const separator = body.lastIndexOf('\n', lineEnd - 1)
    const lineStart = separator + 1
    const marker = body.slice(lineStart, lineEnd)
    if (!expectedMarkers.has(marker)) break
    reversed.push({ marker, index: lineStart })
    if (separator < 0) break
    lineEnd = separator
  }
  return reversed.reverse()
}

function validateMarkerBody(
  extracted: ExtractedMarkerBody,
  source: 'note' | 'discussion',
  catalog: MarkerCatalog,
): ScannedComment {
  const markers = extracted.trailingMarkers.map(({ marker }) => marker)
  if (markers.length === 0) return { body: extracted.body, markers }

  if (source === 'discussion') {
    if (markers.length !== 1 || !catalog.inlineMarkers.has(markers[0]!)) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
  } else {
    validateNoteMarkerBlock(markers, catalog)
  }
  return { body: extracted.body, markers, strippedBody: extracted.strippedBody }
}

function validateNoteMarkerBlock(markers: string[], catalog: MarkerCatalog) {
  if (markers.some((marker) => catalog.inlineMarkers.has(marker))) {
    throw new GitLabReviewPublicationCompatibilityError()
  }
  if (markers.includes(catalog.legacyFallbackMarker)) {
    if (markers.length !== 1) throw new GitLabReviewPublicationCompatibilityError()
    return
  }
  if (markers[0] === catalog.summaryMarker) {
    const summaryFallbacks = markers.slice(1)
    if (
      summaryFallbacks.some((marker) => !catalog.fallbackMarkers.has(marker))
      || !isOrderedSubset(summaryFallbacks, catalog.summaryFallbackMarkers)
    ) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
    return
  }
  if (markers.length === 1 && catalog.fallbackMarkers.has(markers[0]!)) return
  throw new GitLabReviewPublicationCompatibilityError()
}

function isOrderedSubset(values: string[], expected: string[]) {
  let expectedIndex = 0
  for (const value of values) {
    while (expectedIndex < expected.length && expected[expectedIndex] !== value) expectedIndex += 1
    if (expectedIndex === expected.length) return false
    expectedIndex += 1
  }
  return true
}

function publicationMarkerRunId(marker: string) {
  if (!marker.startsWith(PUBLICATION_MARKER_PREFIX) || !marker.endsWith('-->')) {
    return undefined
  }
  return marker.slice(PUBLICATION_MARKER_PREFIX.length, -3).trimEnd().split(':')[1]
}

function normalizeCommentBody(body: string) {
  return body.includes('\r') ? body.replace(/\r\n?/g, '\n') : body
}

type LegacyCompatibilityContext = ReturnType<typeof buildLegacyCompatibilityContext>

function buildLegacyCompatibilityContext(input: {
  notes: ScannedComment[]
  findings: PublicationFinding[]
}) {
  let work = 0
  const uniqueBodies = new Set<string>()
  for (const note of input.notes) {
    const body = requiredStrippedBody(note)
    if (uniqueBodies.has(body)) continue
    uniqueBodies.add(body)
    work = addLegacyWork(work, body.length)
  }

  const renderedItems = input.findings.map((finding) => {
    const rendered = `\n${renderReviewFindingItem(finding.finding)}`
    work = addLegacyWork(work, rendered.length)
    return rendered
  })
  const matcher = buildMultiPatternMatcher(renderedItems)
  const matchesByBody = new Map<string, ReadonlySet<PublicationFinding>>()

  return {
    matches(body: string) {
      const cached = matchesByBody.get(body)
      if (cached) return cached
      const matches = new Set<PublicationFinding>()
      for (const index of matcher(body)) matches.add(input.findings[index]!)
      matchesByBody.set(body, matches)
      return matches
    },
  }
}

function addLegacyWork(current: number, amount: number) {
  const next = current + amount
  if (next > LEGACY_COMPATIBILITY_CODE_UNIT_BUDGET) {
    throw new GitLabReviewPublicationCompatibilityError()
  }
  return next
}

type PatternNode = {
  next: Map<string, number>
  failure: number
  outputs: number[]
}

function buildMultiPatternMatcher(patterns: string[]) {
  const nodes: PatternNode[] = [{ next: new Map(), failure: 0, outputs: [] }]
  for (const [patternIndex, pattern] of patterns.entries()) {
    let state = 0
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index]!
      let next = nodes[state]!.next.get(character)
      if (next === undefined) {
        next = nodes.length
        nodes[state]!.next.set(character, next)
        nodes.push({ next: new Map(), failure: 0, outputs: [] })
      }
      state = next
    }
    nodes[state]!.outputs.push(patternIndex)
  }

  const queue = [...nodes[0]!.next.values()]
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const state = queue[queueIndex]!
    for (const [character, next] of nodes[state]!.next) {
      queue.push(next)
      let failure = nodes[state]!.failure
      while (failure !== 0 && !nodes[failure]!.next.has(character)) {
        failure = nodes[failure]!.failure
      }
      nodes[next]!.failure = nodes[failure]!.next.get(character) ?? 0
      nodes[next]!.outputs.push(...nodes[nodes[next]!.failure]!.outputs)
    }
  }

  return (body: string) => {
    const matches = new Set<number>()
    let state = 0
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index]!
      while (state !== 0 && !nodes[state]!.next.has(character)) {
        state = nodes[state]!.failure
      }
      state = nodes[state]!.next.get(character) ?? 0
      for (const output of nodes[state]!.outputs) matches.add(output)
    }
    return matches
  }
}

function reconcileLegacyRunFallbacks(input: {
  notes: ScannedComment[]
  manifest: GitLabDiffManifest
  candidates: PublicationFinding[]
  warnings: string[]
  compatibility: LegacyCompatibilityContext
  completed: Set<string>
}) {
  const reconciled = new Map<string, PublicationFinding[]>()
  for (const note of input.notes) {
    const body = requiredStrippedBody(note)
    let matched = reconciled.get(body)
    if (!matched) {
      const bodyMatches = input.compatibility.matches(body)
      matched = input.candidates.filter((finding) => bodyMatches.has(finding))
      if (matched.length === 0) throw new GitLabReviewPublicationCompatibilityError()
      const expected = renderReviewSummaryComment({
        title: 'Nine1bot Inline Publish Fallback',
        summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
        findings: matched.map(({ finding }) => finding),
        manifest: input.manifest,
      })
      const dynamicWarnings = legacyFallbackDynamicWarnings({
        body,
        expectedWithoutWarnings: expected,
        fixedWarnings: input.warnings,
        findings: matched,
      })
      if (!dynamicWarnings) throw new GitLabReviewPublicationCompatibilityError()
      const roundTrip = renderReviewSummaryComment({
        title: 'Nine1bot Inline Publish Fallback',
        summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
        findings: matched.map(({ finding }) => finding),
        manifest: input.manifest,
        warnings: [...input.warnings, ...dynamicWarnings],
      })
      if (body !== roundTrip) throw new GitLabReviewPublicationCompatibilityError()
      reconciled.set(body, matched)
    }
    for (const finding of matched) {
      input.completed.add(requiredMarker(finding.markers?.fallbackMarker))
    }
  }
}

function reconcileLegacySummaryFindings(input: {
  notes: ScannedComment[]
  summary: string
  manifest: GitLabDiffManifest
  warnings: string[]
  summaryWarnings: ReadonlyMap<PublicationFinding, string>
  summaryFindings: PublicationFinding[]
  inlineFindings: PublicationFinding[]
  compatibility: LegacyCompatibilityContext
  completed: Set<string>
}) {
  if (input.summaryFindings.every((finding) => findingCompleted(finding, input.completed))) return
  let matchedAny = false
  const reconciled = new Map<string, PublicationFinding[]>()
  for (const note of input.notes) {
    const body = requiredStrippedBody(note)
    let matched = reconciled.get(body)
    if (!matched) {
      const bodyMatches = input.compatibility.matches(body)
      matched = input.summaryFindings.filter((finding) => bodyMatches.has(finding))
      const expected = renderReviewSummaryComment({
        summary: input.summary,
        findings: matched.map(({ finding }) => finding),
        inlineFindings: input.inlineFindings.map(({ finding }) => finding),
        manifest: input.manifest,
        warnings: [
          ...input.warnings,
          ...matched.flatMap((finding) => {
            const warning = input.summaryWarnings.get(finding)
            return warning ? [warning] : []
          }),
        ],
      })
      if (body !== expected) throw new GitLabReviewPublicationCompatibilityError()
      reconciled.set(body, matched)
    }
    matchedAny = true
    for (const finding of matched) {
      input.completed.add(requiredMarker(finding.markers?.fallbackMarker))
    }
  }
  if (!matchedAny) throw new GitLabReviewPublicationCompatibilityError()
}

function legacyFallbackDynamicWarnings(input: {
  body: string
  expectedWithoutWarnings: string
  fixedWarnings: string[]
  findings: PublicationFinding[]
}) {
  const findingsHeading = '\n\n### Findings'
  const findingsIndex = input.expectedWithoutWarnings.indexOf(findingsHeading)
  if (findingsIndex < 0) return undefined
  const bodyPrefix = `${input.expectedWithoutWarnings.slice(0, findingsIndex)}\n\n### Warnings\n`
  const bodySuffix = input.expectedWithoutWarnings.slice(findingsIndex)
  if (!input.body.startsWith(bodyPrefix) || !input.body.endsWith(bodySuffix)) return undefined

  const warningSection = input.body.slice(bodyPrefix.length, input.body.length - bodySuffix.length)
  const fixedSection = input.fixedWarnings.map((warning) => `- ${warning}`).join('\n')
  let dynamicSection = warningSection
  if (fixedSection) {
    if (!warningSection.startsWith(`${fixedSection}\n`)) return undefined
    dynamicSection = warningSection.slice(fixedSection.length + 1)
  }
  return parseLegacyFallbackDynamicWarnings(dynamicSection, input.findings)
}

function parseLegacyFallbackDynamicWarnings(section: string, findings: PublicationFinding[]) {
  const warningPrefixes = findings.map(({ finding }) => {
    return `Inline fallback for ${finding.file ?? finding.title}: GitLab API returned 400`
  })
  if (new Set(warningPrefixes).size !== warningPrefixes.length) return undefined

  const memo = new Map<string, string[] | null>()
  const parseAt = (findingIndex: number, position: number): string[] | undefined => {
    const key = `${findingIndex}:${position}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached ?? undefined
    if (findingIndex === findings.length) {
      const result = position === section.length ? [] : undefined
      memo.set(key, result ?? null)
      return result
    }

    let warningStart = position
    if (findingIndex > 0) {
      if (section[warningStart] !== '\n') {
        memo.set(key, null)
        return undefined
      }
      warningStart += 1
    }
    const warningPrefix = warningPrefixes[findingIndex]!
    const renderedPrefix = `- ${warningPrefix}`
    if (!section.startsWith(renderedPrefix, warningStart)) {
      memo.set(key, null)
      return undefined
    }
    const suffixStart = warningStart + renderedPrefix.length
    const candidates: Array<{ end: number; warning: string }> = []
    if (section[suffixStart] === '.') {
      candidates.push({ end: suffixStart + 1, warning: `${warningPrefix}.` })
    }
    if (section.startsWith(': ', suffixStart)) {
      const detailStart = suffixStart + 2
      const detailLimit = Math.min(section.length, detailStart + 240)
      for (let terminal = detailStart + 1; terminal <= detailLimit; terminal += 1) {
        if (section[terminal] !== '.') continue
        const detail = section.slice(detailStart, terminal)
        if (detail.trim() !== detail || detail.includes('\n- ')) continue
        candidates.push({
          end: terminal + 1,
          warning: `${warningPrefix}: ${detail}.`,
        })
      }
    }

    for (const candidate of candidates) {
      const remaining = parseAt(findingIndex + 1, candidate.end)
      if (!remaining) continue
      const result = [candidate.warning, ...remaining]
      memo.set(key, result)
      return result
    }
    memo.set(key, null)
    return undefined
  }

  return parseAt(0, 0)
}

function uniqueFindings(findings: PublicationFinding[]) {
  return [...new Set(findings)]
}

function requiredStrippedBody(note: ScannedComment) {
  if (note.strippedBody === undefined) throw new GitLabReviewPublicationCompatibilityError()
  return note.strippedBody
}

function findingCompleted(finding: PublicationFinding, completed: ReadonlySet<string>) {
  return Boolean(
    finding.markers
    && (
      completed.has(finding.markers.inlineMarker)
      || completed.has(finding.markers.fallbackMarker)
    ),
  )
}

function requiredMarker(marker: string | undefined) {
  if (!marker) throw new GitLabReviewPublicationCompatibilityError()
  return marker
}
