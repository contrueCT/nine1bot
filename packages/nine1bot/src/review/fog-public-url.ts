import { GitLabApiClient } from '@nine1bot/platform-gitlab/review'
import type { FogSeed } from './fog-report'

// Both ends are operator-controlled; never derive a credential destination from MR content.
export function fogPublicBase(seed: FogSeed, env: NodeJS.ProcessEnv = process.env) {
  const api = env.FOG_GITLAB_API_BASE_URL
  const publicBase = env.FOG_GITLAB_PUBLIC_BASE_URL
  if (!api && !publicBase) return undefined
  if (!api || !publicBase) throw new Error('fog_public_mapping_invalid')
  const source = new URL(api)
  const target = new URL(publicBase)
  for (const url of [source, target]) {
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('fog_public_mapping_invalid')
  }
  if (!['http:', 'https:'].includes(source.protocol) || target.protocol !== 'https:'
    || source.origin !== seed.baseUrl.replace(/\/$/, '')) throw new Error('fog_public_mapping_invalid')
  return target.origin
}

export async function verifyFogPublicBase(seed: FogSeed, token: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch) {
  const base = fogPublicBase(seed, env)
  if (!base) return undefined
  const client = new GitLabApiClient({ baseUrl: base, token, requestTimeoutMs: 10_000, fetch: fetcher })
  const project = await client.getProject(seed.projectId, { signal })
  const mr = await client.getMergeRequest(seed.projectId, seed.mrIid, { signal })
  if (!seed.projectPath || project.path_with_namespace !== seed.projectPath
    || String(project.id) !== String(seed.projectId) || String(mr.project_id) !== String(seed.projectId)
    || mr.iid !== seed.mrIid || mr.diff_refs?.head_sha !== seed.headSha) throw new Error('fog_public_identity_mismatch')
  return base
}
