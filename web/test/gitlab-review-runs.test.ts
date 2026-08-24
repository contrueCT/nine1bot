import { describe, expect, test } from 'bun:test'
import type { GitLabReviewRun } from '../src/api/client'
import {
  canRetryGitLabReviewRun,
  isIgnoredGitLabReviewRun,
  isOperationalGitLabReviewRun,
  reviewRunStatusLabel,
} from '../src/lib/gitlab-review-runs'

function run(input: Partial<GitLabReviewRun> & Pick<GitLabReviewRun, 'id' | 'status'>): GitLabReviewRun {
  return {
    platform: 'gitlab',
    rootRunId: input.id,
    attempt: 1,
    triggerKey: 'trigger-a',
    generation: `generation-${input.id}`,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
}

describe('GitLab review run component policy', () => {
  test('shows retry only for the latest recoverable configuration rejection', () => {
    const previous = run({
      id: 'attempt-1',
      status: 'rejected',
      recoverable: true,
      rejectionKind: 'configuration',
      error: 'project_binding_missing',
      attempt: 1,
    })
    const repairedCandidate = run({
      id: 'attempt-2',
      status: 'rejected',
      recoverable: true,
      rejectionKind: 'configuration',
      error: 'project_binding_missing',
      rootRunId: previous.id,
      retryOf: previous.id,
      attempt: 2,
      updatedAt: 2,
    })
    const runs = [repairedCandidate, previous]

    expect(isOperationalGitLabReviewRun(repairedCandidate)).toBe(true)
    expect(isIgnoredGitLabReviewRun(repairedCandidate)).toBe(false)
    expect(canRetryGitLabReviewRun(repairedCandidate, runs)).toBe(true)
    expect(canRetryGitLabReviewRun(previous, runs)).toBe(false)
    expect(reviewRunStatusLabel(repairedCandidate)).toBe('配置待修复')
  })

  test('suppresses retry for failed, policy, authentication, and published attempts', () => {
    const failed = run({ id: 'failed', status: 'failed', error: 'runtime_failed' })
    const policy = run({
      id: 'policy',
      status: 'rejected',
      error: 'gitlab_review_head_changed',
      rejectionKind: 'policy',
      recoverable: false,
      triggerKey: 'trigger-policy',
    })
    const authentication = run({
      id: 'auth',
      status: 'rejected',
      error: 'invalid_gitlab_webhook_token',
      rejectionKind: 'authentication',
      recoverable: false,
      triggerKey: 'trigger-auth',
    })
    const published = run({
      id: 'published',
      status: 'rejected',
      error: 'project_binding_missing',
      rejectionKind: 'configuration',
      recoverable: true,
      publishedAt: 3,
      triggerKey: 'trigger-published',
    })
    const runs = [failed, policy, authentication, published]

    expect(runs.map((candidate) => canRetryGitLabReviewRun(candidate, runs))).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(isOperationalGitLabReviewRun(failed)).toBe(true)
    expect(isIgnoredGitLabReviewRun(policy)).toBe(true)
    expect(isIgnoredGitLabReviewRun(authentication)).toBe(true)
  })
})
