import { readFile } from 'fs/promises'
import { join } from 'path'
import { getInstallDir } from '../config/loader'
import type { EngineManifest } from './types'

const DEFAULT_MANIFEST: EngineManifest = {
  engineId: 'opencode',
  engineVersion: 'local',
  mode: 'local-source',
  entry: {
    command: 'bun',
    args: [
      'run',
      '--cwd',
      '{installDir}/opencode/packages/opencode',
      'src/index.ts',
      '--',
      'serve',
      '--port',
      '{port}',
      '--hostname',
      '{host}',
    ],
  },
  healthEndpoint: '/global/health',
  defaultPortStrategy: 'ephemeral',
  runtimeLayoutVersion: 1,
}

export async function loadEngineManifest(): Promise<EngineManifest> {
  const installDir = getInstallDir()
  const manifestPath = join(installDir, 'engine.manifest.json')

  try {
    const content = await readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<EngineManifest>
    return {
      ...DEFAULT_MANIFEST,
      ...parsed,
      entry: {
        ...DEFAULT_MANIFEST.entry,
        ...(parsed.entry || {}),
      },
    }
  } catch {
    return DEFAULT_MANIFEST
  }
}
