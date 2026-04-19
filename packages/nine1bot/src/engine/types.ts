import type { Nine1BotConfig } from '../config/schema'

export type EngineMode = 'in-process' | 'subprocess'

export interface EngineManifestEntry {
  command: string
  args: string[]
}

export interface EngineManifest {
  engineId: string
  engineVersion: string
  mode: 'local-source' | 'artifact'
  entry: EngineManifestEntry
  healthEndpoint: string
  defaultPortStrategy: 'ephemeral' | 'fixed'
  runtimeLayoutVersion: number
}

export interface EngineContext {
  configPath: string
  installDir: string
  projectDir: string
  browserServiceUrl?: string
}

export interface EngineArtifactPaths {
  configPath: string
  runtimeDir: string
}

export interface EngineStartSpec {
  type: EngineMode
  host: string
  port: number
  healthEndpoint: string
  command?: string[]
  cwd?: string
}

export interface PreparedRuntime {
  runtimeDir: string
  env: Record<string, string>
  artifactPaths: EngineArtifactPaths
  startSpec: EngineStartSpec
  runtimeConfig: Record<string, any>
  runtimeConfigText: string
  restartFingerprint: string
}

export interface EngineHandle {
  baseUrl: string
  health(): Promise<boolean>
  stop(): Promise<void>
}

export interface RuntimeRebuildResult {
  prepared: PreparedRuntime
  requiresRestart: boolean
}

export interface EngineAdapter {
  readonly name: string
  prepare(config: Nine1BotConfig, context: EngineContext): Promise<PreparedRuntime>
  start(prepared: PreparedRuntime): Promise<EngineHandle>
  rebuildRuntime(
    reason: string,
    config: Nine1BotConfig,
    context: EngineContext,
    currentPrepared?: PreparedRuntime,
  ): Promise<RuntimeRebuildResult>
}

export interface RuntimeApplyResult {
  state: 'applied' | 'pending-rebuild'
  effectiveAfterCurrentSession: boolean
}
