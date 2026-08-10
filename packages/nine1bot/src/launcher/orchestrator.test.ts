import { afterEach, expect, test } from 'bun:test'
import { RuntimePlatformAdapterRegistry } from '../../../../opencode/packages/opencode/src/runtime/platform/adapter'
import { RuntimeSourceRegistry } from '../../../../opencode/packages/opencode/src/runtime/source/registry'
import { RuntimeToolRegistry } from '../../../../opencode/packages/opencode/src/runtime/tool/registry'
import {
  registerBuiltinPlatformAdapters,
  resetBuiltinPlatformManagerForTesting,
} from '../platform/builtin'
import { shutdown } from './orchestrator'

afterEach(() => {
  resetBuiltinPlatformManagerForTesting()
  RuntimeToolRegistry.clearForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
  RuntimeSourceRegistry.clearForTesting()
})

test('shutdown invalidates platform runtime state before stopping the server', async () => {
  registerBuiltinPlatformAdapters({
    config: {
      gitlab: { enabled: true },
      feishu: { enabled: false },
    },
  })
  RuntimeToolRegistry.registerOwner({
    owner: { id: 'gitlab', kind: 'platform', enabled: true },
    tools: [{
      id: 'gitlab_lookup',
      description: 'Look up a GitLab item',
      catalogVisibility: 'declared-only',
      inputSchema: { type: 'object' },
      parse(input) {
        return input
      },
      async execute() {
        return { status: 'ok', title: 'GitLab', output: 'ok' }
      },
    }],
  })
  let serverStops = 0

  await shutdown({
    server: {
      url: 'http://127.0.0.1:4096',
      hostname: '127.0.0.1',
      port: 4096,
      async stop() {
        serverStops += 1
        expect(RuntimeToolRegistry.get('gitlab_lookup')).toBeUndefined()
        expect(RuntimePlatformAdapterRegistry.list().some((item) => item.id === 'gitlab')).toBe(false)
        expect(RuntimeSourceRegistry.listOwner('gitlab').owner).toBeUndefined()
      },
    },
    localUrl: 'http://127.0.0.1:4096',
    configPath: 'nine1bot.config.jsonc',
  })

  expect(serverStops).toBe(1)
})
