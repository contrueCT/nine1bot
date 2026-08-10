import type { PlatformToolSummary } from '../api/client'
import { isSafePlatformId } from './settings-deeplink'

export type PlatformToolRow = PlatformToolSummary & {
  selectable: boolean
  canOpenSettings: boolean
}

export function platformToolRows(tools: PlatformToolSummary[]): PlatformToolRow[] {
  return tools
    .filter((tool) => tool.catalogVisibility === 'user-selectable')
    .map((tool) => ({
      ...tool,
      selectable: tool.status === 'registered' || tool.status === 'error',
      canOpenSettings:
        isSafePlatformId(tool.ownerId)
        && (tool.status === 'auth-required' || tool.status === 'unavailable' || tool.status === 'error'),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function stalePlatformToolIDs(
  selectedToolIDs: string[],
  rows: PlatformToolRow[],
  catalogLoaded: boolean,
): string[] {
  if (!catalogLoaded) return []
  const known = new Set(rows.map((tool) => tool.id))
  return selectedToolIDs.filter((toolID) => !known.has(toolID)).sort()
}
