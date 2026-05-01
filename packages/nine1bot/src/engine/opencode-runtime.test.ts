import { describe, expect, it } from 'bun:test'
import { sanitizeOpencodeConfig } from './opencode-runtime'
import { Nine1BotConfigSchema } from '../config/schema'

describe('sanitizeOpencodeConfig', () => {
  it('omits Nine1Bot-only fields such as feishu', () => {
    const config = Nine1BotConfigSchema.parse({
      server: {
        port: 4106,
        hostname: '127.0.0.1',
        openBrowser: true,
      },
      browser: {
        enabled: true,
        cdpPort: 9222,
        autoLaunch: true,
        headless: false,
      },
      feishu: {
        enabled: true,
        mode: 'websocket',
        appId: 'cli_xxx',
        appSecret: 'secret',
      },
      platforms: {
        gitlab: {
          enabled: false,
          settings: {
            allowedHosts: ['gitlab.com'],
          },
        },
      },
      customProviders: {
        demo: {
          name: 'Demo',
          protocol: 'openai',
          baseURL: 'https://example.com/v1',
          models: [
            {
              id: 'demo-model',
            },
          ],
        },
      },
      model: 'demo/demo-model',
    })

    const { config: opencodeConfig } = sanitizeOpencodeConfig(config)

    expect(opencodeConfig).not.toHaveProperty('feishu')
    expect(opencodeConfig).not.toHaveProperty('platforms')
    expect(opencodeConfig).not.toHaveProperty('browser')
    expect(opencodeConfig).not.toHaveProperty('server')
    expect(opencodeConfig.provider.demo).toEqual({
      name: 'Demo',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://example.com/v1',
      options: {
        baseURL: 'https://example.com/v1',
      },
      models: {
        'demo-model': {
          id: 'demo-model',
          name: 'demo-model',
          provider: {
            npm: '@ai-sdk/openai-compatible',
          },
        },
      },
    })
  })
})
