import type { GitLabReviewProjectProfile, GitLabReviewSettings, GitLabReviewProjectSnapshot } from './settings'
import { normalizeGitLabAuthority } from './host'

export type GitLabReviewProjectTarget = {
  host: string
  projectId: string | number
  projectPath?: string
}

export type GitLabReviewProjectResolution =
  | { status: 'matched'; project: GitLabReviewProjectSnapshot }
  | { status: 'missing'; project: GitLabReviewProjectSnapshot; warning: 'project_profile_missing' }
  | { status: 'disabled'; project: GitLabReviewProjectSnapshot }
  | { status: 'unbound'; project: GitLabReviewProjectSnapshot }
  | { status: 'duplicate'; project: GitLabReviewProjectSnapshot }

export function resolveGitLabReviewProjectProfile(
  settings: Pick<GitLabReviewSettings, 'projects'>,
  target: GitLabReviewProjectTarget,
  now = Date.now(),
): GitLabReviewProjectResolution {
  const targetHost = normalizeGitLabAuthority(target.host)
  const profiles = settings.projects.filter((candidate) =>
    String(candidate.projectId) === String(target.projectId) &&
    Boolean(candidate.host) &&
    normalizeGitLabAuthority(candidate.host) === targetHost,
  )
  if (profiles.length > 1) {
    return { status: 'duplicate', project: snapshot(unconfiguredProfile(target), 'unconfigured', now) }
  }
  const profile = profiles[0]
  if (!profile) {
    return {
      status: 'missing',
      warning: 'project_profile_missing',
      project: snapshot(unconfiguredProfile(target), 'unconfigured', now),
    }
  }
  const project = snapshot(profile, 'configured', now)
  if (!profile.enabled) return { status: 'disabled', project }
  if (!profile.nine1botProjectID) return { status: 'unbound', project }
  return { status: 'matched', project }
}

function snapshot(
  profile: GitLabReviewProjectProfile,
  source: GitLabReviewProjectSnapshot['source'],
  matchedAt: number,
): GitLabReviewProjectSnapshot {
  return { ...profile, source, matchedAt }
}

function unconfiguredProfile(target: GitLabReviewProjectTarget): GitLabReviewProjectProfile {
  return {
    id: `unconfigured:${target.host}:${target.projectId}`,
    host: target.host,
    projectId: target.projectId,
    nine1botProjectID: '',
    pathWithNamespace: target.projectPath,
    displayName: target.projectPath ?? String(target.projectId),
    enabled: true,
    reviewFocus: [],
    includePathPrefixes: [],
    excludePathPatterns: [],
    ci: {
      maxJobLogs: 3,
      maxJobLogBytes: 8_000,
    },
  }
}
