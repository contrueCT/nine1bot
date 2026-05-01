import type { CustomProvider, Nine1BotConfig } from '../config/schema'

/**
 * Nine1Bot-only fields must not be forwarded into the generated opencode config.
 * Keeping this list centralized makes old-config compatibility tests less brittle.
 */
export const NINE1BOT_ONLY_FIELDS = [
  'server',
  'auth',
  'tunnel',
  'isolation',
  'skills',
  'sandbox',
  'browser',
  'platforms',
  'feishu',
  'customProviders',
] as const

function protocolToNpm(protocol: CustomProvider['protocol']): string {
  return protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible'
}

function mapCustomProvidersToOpencode(customProviders: Nine1BotConfig['customProviders']) {
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

export function sanitizeOpencodeConfig(config: Nine1BotConfig): { config: Record<string, any> } {
  const opencodeConfig: Record<string, any> = {}
  const customProviders = mapCustomProvidersToOpencode(config.customProviders || {})

  for (const [key, value] of Object.entries(config)) {
    if (NINE1BOT_ONLY_FIELDS.includes(key as typeof NINE1BOT_ONLY_FIELDS[number])) {
      continue
    }

    if (key === 'mcp' && typeof value === 'object' && value !== null) {
      const { inheritOpencode, inheritClaudeCode, ...mcpServers } = value as any
      if (Object.keys(mcpServers).length > 0) {
        opencodeConfig[key] = mcpServers
      }
    } else if (key === 'provider' && typeof value === 'object' && value !== null) {
      const { inheritOpencode, ...providers } = value as any
      const sanitizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerId, providerConfig]) => {
          if (!providerConfig || typeof providerConfig !== 'object') {
            return [providerId, providerConfig]
          }

          const { inheritOpencode: _ignored, ...rest } = providerConfig as Record<string, any>
          return [providerId, rest]
        }),
      )

      opencodeConfig[key] = { ...sanitizedProviders, ...customProviders }
    } else {
      opencodeConfig[key] = value
    }
  }

  if (!opencodeConfig.provider && Object.keys(customProviders).length > 0) {
    opencodeConfig.provider = customProviders
  }

  return { config: opencodeConfig }
}
