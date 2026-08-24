import type { GitLabReviewRun } from '../api/client'

const recoverableConfigurationErrors = new Set([
  'project_profile_missing',
  'project_profile_disabled',
  'project_binding_missing',
  'project_profile_identity_duplicate',
  'gitlab_token_missing',
  'gitlab_token_unavailable',
])

export function isRecoverableGitLabReviewConfigurationRun(run: GitLabReviewRun) {
  if (run.status !== 'rejected' || run.publishedAt) return false
  const recoverable = run.recoverable ?? recoverableConfigurationErrors.has(run.error ?? '')
  const configuration = run.rejectionKind === 'configuration'
    || (run.rejectionKind === undefined && recoverableConfigurationErrors.has(run.error ?? ''))
  return recoverable && configuration
}

export function canRetryGitLabReviewRun(run: GitLabReviewRun, runs: readonly GitLabReviewRun[]) {
  if (!isRecoverableGitLabReviewConfigurationRun(run) || !run.triggerKey) return false
  const latest = runs
    .filter((candidate) => candidate.triggerKey === run.triggerKey)
    .sort(compareLatestAttemptFirst)[0]
  return latest?.id === run.id
}

export function isOperationalGitLabReviewRun(run: GitLabReviewRun) {
  return run.status !== 'rejected' || isRecoverableGitLabReviewConfigurationRun(run)
}

export function isIgnoredGitLabReviewRun(run: GitLabReviewRun) {
  return run.status === 'rejected' && !isRecoverableGitLabReviewConfigurationRun(run)
}

export function reviewRunStatusLabel(run: GitLabReviewRun) {
  if (isRecoverableGitLabReviewConfigurationRun(run)) return '配置待修复'
  const labels: Record<string, string> = {
    accepted: '已接受',
    rejected: '已拒绝',
    blocked: '已拦截',
    running: '运行中',
    succeeded: '成功',
    failed: '失败',
  }
  return labels[run.status] || run.status
}

function compareLatestAttemptFirst(left: GitLabReviewRun, right: GitLabReviewRun) {
  return right.attempt - left.attempt
    || right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id)
}
