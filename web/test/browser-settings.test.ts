import { expect, test } from 'bun:test'
import { browserSettingsChanges } from '../src/utils/browser-settings'
const effective = { enabled: true, cdpPort: 9444, autoLaunch: true, headless: false, executablePath: '/opt/Environment Chrome/chrome' }

test('saving unrelated changes does not materialize inherited values or resolved environment expressions', () => {
  expect(browserSettingsChanges(effective, { ...effective, headless: true })).toEqual({ headless: true })
  expect(browserSettingsChanges(effective, { ...effective })).toEqual({})
})
test('clearing inherited path sends explicit auto; unchanged auto is omitted', () => {
  expect(browserSettingsChanges(effective, { ...effective, executablePath: '' })).toEqual({ executablePath: null })
  expect(browserSettingsChanges({ ...effective, executablePath: undefined }, { ...effective, executablePath: '' })).toEqual({})
})
