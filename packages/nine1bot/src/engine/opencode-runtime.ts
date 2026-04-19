import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, dirname, basename } from 'path'
import { createHash } from 'crypto'
import type { Nine1BotConfig, CustomProvider } from '../config/schema'
import { getAuthPath, getGlobalConfigDir, getGlobalSkillsDir, getInstallDir, getMcpAuthPath, getProjectEnvDir } from '../config/loader'
import { getGlobalPreferencesPath } from '../preferences'
import type { EngineArtifactPaths, EngineContext, EngineManifest, EngineMode, EngineStartSpec, PreparedRuntime } from './types'
import { createServer } from 'net'

const NINE1BOT_ONLY_FIELDS = ['server', 'auth', 'tunnel', 'isolation', 'skills', 'sandbox', 'browser', 'customProviders', 'feishu']
const LEGACY_BROWSER_MCP_MARKER = 'browser-mcp-server'
const LEGACY_BROWSER_BRIDGE_URL_MARKERS = ['127.0.0.1:18793', 'localhost:18793']
// These keys are either reloaded in-place or synced by the MCP watcher. Everything
// else stays restart-sensitive so cached opencode state does not drift silently.
const HOT_RELOAD_RUNTIME_CONFIG_KEYS = new Set([
  'default_agent',
  'disabled_providers',
  'enabled_providers',
  'mcp',
  'model',
  'provider',
  'small_model',
])

interface LegacyBrowserMcpEntry {
  name: string
  command: string[]
  bridgeUrl?: string
}

interface OpencodeConfigBuildResult {
  config: Record<string, any>
  ignoredLegacyBrowserMcp: LegacyBrowserMcpEntry[]
}

function isReleaseMode(): boolean {
  const dirName = basename(dirname(process.execPath))
  return dirName.startsWith('nine1bot-')
}

function getBuiltinSkillsDir(): string {
  const installDir = getInstallDir()
  return resolve(installDir, isReleaseMode() ? 'skills' : 'packages/nine1bot/skills')
}

function getWebDistDir(): string {
  const installDir = getInstallDir()
  return resolve(installDir, 'web/dist')
}

function protocolToNpm(protocol: CustomProvider['protocol']): string {
  return protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible'
}

export function mapCustomProvidersToOpencode(customProviders: Nine1BotConfig['customProviders']) {
  const mapped: Record<string, any> = {}
  for (const [providerId, provider] of Object.entries(customProviders || {})) {
    mapped[providerId] = {
      name: provider.name,
      npm: protocolToNpm(provider.protocol),
      api: provider.baseURL,
      options: {
        baseURL: provider.baseURL,
        ...(provider.options || {}),
      },
      models: Object.fromEntries(
        provider.models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name || model.id,
            provider: {
              npm: protocolToNpm(provider.protocol),
            },
          },
        ]),
      ),
    }
  }
  return mapped
}

function getCommandParts(entry: unknown): string[] {
  const command = (entry as { command?: unknown })?.command
  if (!Array.isArray(command)) return []
  return command.filter((part): part is string => typeof part === 'string')
}

function isLegacyBrowserMcpEntry(name: string, entry: unknown): LegacyBrowserMcpEntry | null {
  if (!entry || typeof entry !== 'object') return null
  if ((entry as { type?: unknown }).type !== 'local') return null

  const command = getCommandParts(entry)
  if (!command.some((part) => part.includes(LEGACY_BROWSER_MCP_MARKER))) {
    return null
  }

  const bridgeUrl = typeof (entry as { environment?: Record<string, unknown> }).environment?.BRIDGE_URL === 'string'
    ? (entry as { environment?: Record<string, string> }).environment?.BRIDGE_URL
    : undefined

  return { name, command, bridgeUrl }
}

function isDeprecatedBrowserBridgeUrl(url: string): boolean {
  return LEGACY_BROWSER_BRIDGE_URL_MARKERS.some((marker) => url.includes(marker))
}

function warnAboutLegacyBrowserConfig(
  browserConfig: Nine1BotConfig['browser'] | undefined,
  ignoredLegacyBrowserMcp: LegacyBrowserMcpEntry[],
): void {
  if (browserConfig?.bridgePort !== undefined) {
    console.warn(
      '[Nine1Bot] browser.bridgePort is deprecated and ignored. Browser control is now built in at /browser on the main server.',
    )
  }

  for (const entry of ignoredLegacyBrowserMcp) {
    console.warn(
      `[Nine1Bot] Ignoring legacy browser MCP "${entry.name}" because browser control is built in. Use the built-in browser_* tools instead of browser_browser_*.`,
    )
    if (entry.bridgeUrl && isDeprecatedBrowserBridgeUrl(entry.bridgeUrl)) {
      console.warn(
        `[Nine1Bot] Legacy browser MCP "${entry.name}" uses BRIDGE_URL=${entry.bridgeUrl}, which is deprecated. Browser control is now available through the built-in browser_* tools.`,
      )
    }
  }

  if (ignoredLegacyBrowserMcp.length > 0 && browserConfig?.enabled !== true) {
    console.warn('[Nine1Bot] To keep browser control enabled, set "browser.enabled": true in your Nine1Bot config.')
  }
}

function sanitizeOpencodeConfig(config: Nine1BotConfig): OpencodeConfigBuildResult {
  const opencodeConfig: Record<string, any> = {}
  const customProviders = mapCustomProvidersToOpencode(config.customProviders || {})
  const ignoredLegacyBrowserMcp: LegacyBrowserMcpEntry[] = []

  for (const [key, value] of Object.entries(config)) {
    if (NINE1BOT_ONLY_FIELDS.includes(key)) continue

    if (key === 'server' && typeof value === 'object' && value !== null) {
      const { openBrowser, ...rest } = value as Record<string, unknown>
      if (Object.keys(rest).length > 0) {
        opencodeConfig[key] = rest
      }
      continue
    }

    if (key === 'mcp' && typeof value === 'object' && value !== null) {
      const { inheritOpencode, inheritClaudeCode, ...mcpServers } = value as Record<string, unknown>
      const filteredMcpServers = Object.fromEntries(
        Object.entries(mcpServers).filter(([name, entry]) => {
          const legacyEntry = isLegacyBrowserMcpEntry(name, entry)
          if (!legacyEntry) return true
          ignoredLegacyBrowserMcp.push(legacyEntry)
          return false
        }),
      )
      if (Object.keys(filteredMcpServers).length > 0) {
        opencodeConfig[key] = filteredMcpServers
      }
      continue
    }

    if (key === 'provider' && typeof value === 'object' && value !== null) {
      const { inheritOpencode, ...providers } = value as Record<string, unknown>
      const sanitizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerId, providerConfig]) => {
          if (!providerConfig || typeof providerConfig !== 'object') {
            return [providerId, providerConfig]
          }
          const { inheritOpencode: _ignored, ...rest } = providerConfig as Record<string, unknown>
          return [providerId, rest]
        }),
      )
      opencodeConfig[key] = { ...sanitizedProviders, ...customProviders }
      continue
    }

    opencodeConfig[key] = value
  }

  if (!opencodeConfig.provider && Object.keys(customProviders).length > 0) {
    opencodeConfig.provider = customProviders
  }

  return {
    config: opencodeConfig,
    ignoredLegacyBrowserMcp,
  }
}

async function createRuntimeDir(): Promise<string> {
  const root = resolve(tmpdir(), 'nine1bot-engine-')
  return mkdtemp(root)
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(port)
      })
    })
  })
}

function buildEnv(config: Nine1BotConfig, context: EngineContext, artifactPaths: EngineArtifactPaths): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_CONFIG: artifactPaths.configPath,
    NINE1BOT_CONFIG_PATH: context.configPath,
    NINE1BOT_AUTH_PATH: getAuthPath(),
    NINE1BOT_MCP_AUTH_PATH: getMcpAuthPath(),
    NINE1BOT_PROJECT_ENV_DIR: getProjectEnvDir(),
    NINE1BOT_PREFERENCES_MODULE: 'nine1bot',
    NINE1BOT_PREFERENCES_PATH: getGlobalPreferencesPath(),
    NINE1BOT_PROJECT_DIR: context.projectDir,
    NINE1BOT_WEB_DIR: getWebDistDir(),
    NINE1BOT_SKILLS_DIR: getGlobalSkillsDir(),
    NINE1BOT_BUILTIN_SKILLS_DIR: getBuiltinSkillsDir(),
  }

  if (context.browserServiceUrl) {
    env.BROWSER_SERVICE_URL = context.browserServiceUrl
  }

  const installDir = getInstallDir()
  const rgPath = resolve(installDir, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
  env.OPENCODE_RIPGREP_PATH = rgPath

  const isolation = config.isolation || {}
  if (isolation.disableGlobalConfig || isolation.inheritOpencode === false) {
    env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
  }
  if (isolation.disableProjectConfig || isolation.inheritOpencode === false) {
    env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
  }

  const skills = config.skills || {}
  if (skills.inheritClaudeCode === false) {
    env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'true'
  }
  if (skills.inheritOpencode === false) {
    env.OPENCODE_DISABLE_OPENCODE_SKILLS = 'true'
  }

  const mcpConfig = (config.mcp as Record<string, unknown> | undefined) || {}
  if (mcpConfig.inheritOpencode === false) {
    env.OPENCODE_DISABLE_OPENCODE_MCP = 'true'
  }
  if (mcpConfig.inheritClaudeCode === false) {
    env.OPENCODE_DISABLE_CLAUDE_CODE_MCP = 'true'
  }

  const providerConfig = (config.provider as Record<string, unknown> | undefined) || {}
  if (providerConfig.inheritOpencode === false) {
    env.OPENCODE_DISABLE_OPENCODE_AUTH = 'true'
  }

  return env
}

function interpolateCommand(command: string[], values: Record<string, string>): string[] {
  return command.map((part) =>
    Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), part),
  )
}

function buildRestartFingerprintInput(
  runtimeConfig: Record<string, any>,
  env: Record<string, string>,
  context: EngineContext,
  manifest: EngineManifest,
  mode: EngineMode,
) {
  const restartSensitiveConfig = Object.fromEntries(
    Object.entries(runtimeConfig).filter(([key]) => !HOT_RELOAD_RUNTIME_CONFIG_KEYS.has(key)),
  )

  return {
    config: restartSensitiveConfig,
    browserServiceUrl: context.browserServiceUrl ?? '',
    flags: {
      OPENCODE_DISABLE_GLOBAL_CONFIG: env.OPENCODE_DISABLE_GLOBAL_CONFIG ?? '',
      OPENCODE_DISABLE_PROJECT_CONFIG: env.OPENCODE_DISABLE_PROJECT_CONFIG ?? '',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS ?? '',
      OPENCODE_DISABLE_OPENCODE_SKILLS: env.OPENCODE_DISABLE_OPENCODE_SKILLS ?? '',
      OPENCODE_DISABLE_OPENCODE_MCP: env.OPENCODE_DISABLE_OPENCODE_MCP ?? '',
      OPENCODE_DISABLE_CLAUDE_CODE_MCP: env.OPENCODE_DISABLE_CLAUDE_CODE_MCP ?? '',
      OPENCODE_DISABLE_OPENCODE_AUTH: env.OPENCODE_DISABLE_OPENCODE_AUTH ?? '',
    },
    mode,
    runtimeLayoutVersion: manifest.runtimeLayoutVersion,
  }
}

export async function cleanupPreparedRuntime(prepared?: Pick<PreparedRuntime, 'runtimeDir'>): Promise<void> {
  if (!prepared?.runtimeDir) return
  await rm(prepared.runtimeDir, { recursive: true, force: true }).catch(() => {})
}

export async function prepareOpencodeRuntime(
  config: Nine1BotConfig,
  context: EngineContext,
  manifest: EngineManifest,
  mode: EngineMode,
): Promise<PreparedRuntime> {
  await mkdir(getGlobalConfigDir(), { recursive: true })
  await mkdir(getProjectEnvDir(), { recursive: true })

  let runtimeDir: string | undefined
  try {
    runtimeDir = await createRuntimeDir()
    const configPath = join(runtimeDir, 'opencode.config.json')
    const configBuild = sanitizeOpencodeConfig(config)
    const runtimeConfig = configBuild.config
    const runtimeConfigText = JSON.stringify(runtimeConfig, null, 2)
    warnAboutLegacyBrowserConfig(config.browser, configBuild.ignoredLegacyBrowserMcp)
    await writeFile(configPath, runtimeConfigText, { mode: 0o600 })

    const artifactPaths: EngineArtifactPaths = {
      configPath,
      runtimeDir,
    }

    const env = buildEnv(config, context, artifactPaths)
    const port = await findAvailablePort()
    const host = '127.0.0.1'
    const command =
      mode === 'subprocess'
        ? interpolateCommand([manifest.entry.command, ...manifest.entry.args], {
            installDir: context.installDir,
            port: String(port),
            host,
            runtimeDir,
          })
        : undefined

    const startSpec: EngineStartSpec = {
      type: mode,
      host,
      port,
      healthEndpoint: manifest.healthEndpoint,
      command,
      cwd: context.installDir,
    }

    const restartFingerprint = createHash('sha256')
      .update(JSON.stringify(buildRestartFingerprintInput(runtimeConfig, env, context, manifest, mode)))
      .digest('hex')

    return {
      runtimeDir,
      env,
      artifactPaths,
      startSpec,
      runtimeConfig,
      runtimeConfigText,
      restartFingerprint,
    }
  } catch (error) {
    if (runtimeDir) {
      await cleanupPreparedRuntime({ runtimeDir })
    }
    throw error
  }
}
