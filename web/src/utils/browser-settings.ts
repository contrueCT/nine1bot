import type { BrowserSettings } from '../api/client'

/** Only explicit edits become project overrides. Null means auto, omission means unchanged. */
export function browserSettingsChanges(previous: BrowserSettings, draft: BrowserSettings) {
  const current = { ...draft, executablePath: draft.executablePath?.trim() || null }
  const changes: Partial<typeof current> = {}
  for (const key of Object.keys(current) as Array<keyof typeof current>) {
    const before = key === 'executablePath' ? previous[key] ?? null : previous[key]
    if (current[key] !== before) Object.assign(changes, { [key]: current[key] })
  }
  return changes
}
