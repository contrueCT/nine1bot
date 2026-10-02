import { describe, expect, test } from 'bun:test'
import { loadSetupModelChoices, setupModelChoices } from './setup-models'

const model = (id: string, options: Record<string, unknown> = {}) => ({ id, name: id, tool_call: true, ...options })

describe('setup model choices', () => {
  test('uses the selected provider catalog and excludes retired or non-tool models', () => {
    expect(setupModelChoices({
      anthropic: { models: {
        current: model('current'),
        retired: model('retired', { status: 'deprecated' }),
        alpha: model('alpha', { status: 'alpha' }),
        experimental: model('experimental', { experimental: true }),
        textOnly: model('textOnly', { tool_call: false }),
      } },
      other: { models: { separate: model('separate') } },
    }, 'anthropic')).toEqual([{ value: 'anthropic/current', label: 'current', hint: 'current' }])
  })

  test('preserves nested model IDs instead of inventing a fixed default', () => {
    expect(setupModelChoices({ openrouter: { models: { 'vendor/current': model('vendor/current') } } }, 'openrouter')[0]?.value)
      .toBe('openrouter/vendor/current')
    expect(setupModelChoices({}, 'anthropic')).toEqual([])
  })

  test('catalog failures and slow responses do not block the wizard', async () => {
    expect(await loadSetupModelChoices('anthropic', async () => { throw new Error('offline') })).toEqual([])
    expect(await loadSetupModelChoices('anthropic', () => new Promise(() => {}), 1)).toEqual([])
  })
})
