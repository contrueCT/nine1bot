const BLACKLISTED_PATH_PATTERNS = [
  /(^|\/)(package-lock|npm-shrinkwrap)\.json$/i,
  /(^|\/)(yarn|pnpm-lock|bun)\.lock$/i,
  /(^|\/)(dist|build|coverage|\.next|\.nuxt|vendor)\//i,
  /\.min\.(js|css)$/i,
  /\.(map|svg|png|jpe?g|gif|webp|avif|ico|pdf|zip|tar|gz|mp4|mov|mp3|wav|woff2?|ttf|otf)$/i,
  /(^|\/)generated\//i,
]

export type GitLabReviewPathAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'profile-excluded' | 'blacklisted' }

export function decideGitLabReviewPathAccess(
  path: string,
  options: { excludePathPatterns?: string[] } = {},
): GitLabReviewPathAccessDecision {
  if (matchesGitLabReviewPathGlob(path, options.excludePathPatterns ?? [])) {
    return { allowed: false, reason: 'profile-excluded' }
  }
  if (isBlacklistedReviewPath(path)) return { allowed: false, reason: 'blacklisted' }
  return { allowed: true }
}

export function matchesGitLabReviewPathGlob(path: string, patterns: string[]) {
  return patterns.some((pattern) => gitLabReviewGlobRegExp(pattern).test(path))
}

export function isBlacklistedReviewPath(path: string) {
  return BLACKLISTED_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

function gitLabReviewGlobRegExp(pattern: string) {
  const normalized = pattern.trim().replace(/\\/g, '/')
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}
