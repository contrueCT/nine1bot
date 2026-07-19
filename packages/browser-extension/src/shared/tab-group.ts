export const ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY = 'activeNine1TabGroupId'
export const ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY = 'activeNine1TabGroups'
export const NINE1_TAB_GROUP_TITLE_PREFIX = 'Nine1Bot'

export interface ActiveNine1TabGroupBinding {
  groupId: number
  windowId: number
  openNonce?: string
  updatedAt: number
}

export type ActiveNine1TabGroupBindings = Record<string, ActiveNine1TabGroupBinding>

export type TabGroupRecoverySource =
  | 'stored'
  | 'active-tab-match'
  | 'single-title-match'
  | 'none'

export interface TabGroupResolution {
  windowId: number | null
  groupId: number | null
  binding: ActiveNine1TabGroupBinding | null
  recoverySource: TabGroupRecoverySource
  issueCode?: string
  matchedGroupIds: number[]
  resolvedAt: number
}

export interface TabGroupDiagnostics {
  currentWindowId: number | null
  bindings: ActiveNine1TabGroupBindings
  lastResolutionByWindow: Record<string, TabGroupResolution>
  lastError: {
    code: string
    message: string
    at: number
  } | null
}
