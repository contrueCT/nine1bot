import { asRecord, parseGitLabUrl } from '../shared'
import type { PageContextPayload } from '../types'
import type { GitLabTarget } from './types'

export type ResolveGitLabTargetInput = {
  text?: string
  url?: string
  page?: PageContextPayload
}

export function resolveGitLabTarget(input: ResolveGitLabTargetInput): GitLabTarget | undefined {
  return resolveFromUrl(input.url)
    ?? resolveFromPage(input.page)
    ?? resolveFromText(input.text)
}

export function resolveGitLabTargets(input: ResolveGitLabTargetInput): GitLabTarget[] {
  const targets = [
    resolveFromUrl(input.url),
    resolveFromPage(input.page),
    ...resolveAllFromText(input.text),
  ].filter((target): target is GitLabTarget => Boolean(target))

  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = targetKey(target)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveFromPage(page: PageContextPayload | undefined): GitLabTarget | undefined {
  if (!page) return undefined
  const parsed = resolveFromUrl(page.url)
  if (parsed) return parsed

  const raw = asRecord(page.raw?.gitlab)
  const host = stringValue(raw?.host)
  const projectPath = stringValue(raw?.projectPath)
  if (!projectPath) return undefined
  const iid = stringValue(raw?.iid)
  const route = stringValue(raw?.route)

  if ((page.pageType === 'gitlab-mr' || route === 'merge_request') && iid) {
    return { kind: 'merge_request', host, projectPath, iid }
  }

  const sha = stringValue(raw?.sha) ?? stringValue(raw?.commitSha)
  if ((route === 'commit' || page.pageType === 'gitlab-commit') && sha) {
    return { kind: 'commit', host, projectPath, sha }
  }

  return { kind: 'project', host, projectPath }
}

function resolveFromText(text: string | undefined): GitLabTarget | undefined {
  return resolveAllFromText(text)[0]
}

function resolveAllFromText(text: string | undefined): GitLabTarget[] {
  if (!text) return []
  const targets: GitLabTarget[] = []

  for (const url of extractUrls(text)) {
    const target = resolveFromUrl(url)
    if (target) targets.push(target)
  }

  const shorthand = /(?<![\w.-])((?:[\w.-]+\/)+[\w.-]+)!(\d+)\b/g
  for (const match of text.matchAll(shorthand)) {
    const projectPath = match[1]
    const iid = match[2]
    if (projectPath && iid) targets.push({ kind: 'merge_request', projectPath, iid })
  }

  return targets
}

function resolveFromUrl(input: string | undefined): GitLabTarget | undefined {
  if (!input) return undefined
  const parsed = parseGitLabUrl(input)
  if (!parsed) return undefined
  if (parsed.route === 'merge_request' && parsed.iid) {
    return {
      kind: 'merge_request',
      host: parsed.host,
      projectPath: parsed.projectPath,
      iid: parsed.iid,
    }
  }
  if (parsed.route === 'commit' && parsed.sha) {
    return {
      kind: 'commit',
      host: parsed.host,
      projectPath: parsed.projectPath,
      sha: parsed.sha,
    }
  }
  return {
    kind: 'project',
    host: parsed.host,
    projectPath: parsed.projectPath,
  }
}

function extractUrls(text: string) {
  const matches = text.match(/https?:\/\/[^\s<>"'`，。；、]+/g) ?? []
  return matches.map((url) => url.replace(/[),.;]+$/, ''))
}

function targetKey(target: GitLabTarget) {
  if (target.kind === 'merge_request') return `${target.host ?? ''}:${target.projectPath}!${target.iid}`
  if (target.kind === 'commit') return `${target.host ?? ''}:${target.projectPath}@${target.sha}`
  return `${target.host ?? ''}:${target.projectPath}`
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}
