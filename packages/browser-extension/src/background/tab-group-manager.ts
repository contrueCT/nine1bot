import {
  ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY,
  ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY,
  NINE1_TAB_GROUP_TITLE_PREFIX,
  type ActiveNine1TabGroupBinding,
  type ActiveNine1TabGroupBindings,
  type TabGroupDiagnostics,
  type TabGroupRecoverySource,
  type TabGroupResolution,
} from '../shared/tab-group'

const NINE1_TAB_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'blue'

let cleanupInstalled = false
let bindingsSyncInstalled = false
let bindingsLoaded = false
const activeNine1Groups = new Map<number, ActiveNine1TabGroupBinding>()
const lastResolutionByWindow = new Map<number, TabGroupResolution>()
let lastError: TabGroupDiagnostics['lastError'] = null

interface MatchingNine1Group {
  groupId: number
  windowId: number
  title: string
}

interface ResolveGroupOptions {
  windowId?: number
  persistRecovered?: boolean
}

interface AddTabOptions {
  onlyIfMissing?: boolean
  openNonce?: string
}

function formatGroupTitle(taskLabel?: string): string {
  if (!taskLabel) return NINE1_TAB_GROUP_TITLE_PREFIX
  const trimmed = taskLabel.trim()
  if (!trimmed) return NINE1_TAB_GROUP_TITLE_PREFIX
  return `${NINE1_TAB_GROUP_TITLE_PREFIX}: ${trimmed.slice(0, 32)}`
}

function isNine1GroupTitle(title?: string): boolean {
  return typeof title === 'string' && title.startsWith(NINE1_TAB_GROUP_TITLE_PREFIX)
}

function recordError(code: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  lastError = {
    code,
    message,
    at: Date.now(),
  }
  console.warn(`[TabGroupManager] ${code}:`, message)
}

function bindingToStorageRecord(): ActiveNine1TabGroupBindings {
  return Object.fromEntries(
    Array.from(activeNine1Groups.entries()).map(([windowId, binding]) => [String(windowId), { ...binding }]),
  )
}

function setLastResolution(resolution: TabGroupResolution): void {
  if (typeof resolution.windowId === 'number') {
    lastResolutionByWindow.set(resolution.windowId, resolution)
  }
}

function replaceBindings(nextBindings: ActiveNine1TabGroupBindings): void {
  activeNine1Groups.clear()
  for (const binding of Object.values(nextBindings)) {
    activeNine1Groups.set(binding.windowId, binding)
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId)
  } catch (error) {
    recordError('tab_lookup_failed', error)
    return null
  }
}

async function getWindowIdForTab(tabId: number): Promise<number | null> {
  const tab = await getTab(tabId)
  return typeof tab?.windowId === 'number' ? tab.windowId : null
}

async function getCurrentWindowId(): Promise<number | null> {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (typeof activeTab?.windowId === 'number') return activeTab.windowId
  } catch (error) {
    recordError('current_window_query_failed', error)
  }

  try {
    const lastFocused = await chrome.windows.getLastFocused()
    return typeof lastFocused?.id === 'number' ? lastFocused.id : null
  } catch (error) {
    recordError('last_focused_window_failed', error)
    return null
  }
}

async function resolveWindowId(windowId?: number): Promise<number | null> {
  if (typeof windowId === 'number') return windowId
  return await getCurrentWindowId()
}

async function getGroupIdForTab(tabId: number): Promise<number | null> {
  const tab = await getTab(tabId)
  return typeof tab?.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : null
}

async function getGroupWindowId(groupId: number): Promise<number | null> {
  try {
    const group = await chrome.tabGroups.get(groupId)
    return typeof group.windowId === 'number' ? group.windowId : null
  } catch (error) {
    recordError('group_window_lookup_failed', error)
    return null
  }
}

async function groupExists(groupId: number): Promise<boolean> {
  try {
    await chrome.tabGroups.get(groupId)
    return true
  } catch {
    return false
  }
}

async function updateGroup(
  groupId: number,
  options: {
    collapsed?: boolean
    taskLabel?: string
  },
): Promise<void> {
  await chrome.tabGroups.update(groupId, {
    title: formatGroupTitle(options.taskLabel),
    color: NINE1_TAB_GROUP_COLOR,
    collapsed: options.collapsed ?? false,
  })
}

async function persistBindings(): Promise<void> {
  try {
    await chrome.storage.local.set({
      [ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]: bindingToStorageRecord(),
    })
    await chrome.storage.local.remove(ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY)
  } catch (error) {
    recordError('persist_bindings_failed', error)
  }
}

function installBindingsSyncListener(): void {
  if (bindingsSyncInstalled) return
  bindingsSyncInstalled = true

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return

    const bindingsChange = changes[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]
    if (bindingsChange) {
      replaceBindings(normalizeStoredBindings(bindingsChange.newValue))
      return
    }

    const legacyChange = changes[ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]
    if (!legacyChange) return

    const nextLegacyValue = legacyChange.newValue
    if (typeof nextLegacyValue !== 'number' || nextLegacyValue < 0) return

    getGroupWindowId(nextLegacyValue).then((windowId) => {
      if (windowId === null) return
      activeNine1Groups.set(windowId, {
        groupId: nextLegacyValue,
        windowId,
        updatedAt: Date.now(),
      })
    }).catch((error) => {
      recordError('legacy_binding_sync_failed', error)
    })
  })
}

function setBinding(binding: ActiveNine1TabGroupBinding | null): void {
  if (!binding) return
  activeNine1Groups.set(binding.windowId, binding)
}

async function persistBinding(
  windowId: number,
  groupId: number | null,
  options: { openNonce?: string } = {},
): Promise<void> {
  if (groupId === null) {
    activeNine1Groups.delete(windowId)
    await persistBindings()
    return
  }

  setBinding({
    groupId,
    windowId,
    openNonce: options.openNonce,
    updatedAt: Date.now(),
  })
  await persistBindings()
}

function normalizeStoredBindings(value: unknown): ActiveNine1TabGroupBindings {
  if (!value || typeof value !== 'object') return {}
  const normalized: ActiveNine1TabGroupBindings = {}

  for (const [windowKey, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Partial<ActiveNine1TabGroupBinding>
    if (
      typeof record.groupId !== 'number'
      || record.groupId < 0
      || typeof record.windowId !== 'number'
      || record.windowId < 0
    ) {
      continue
    }
    normalized[windowKey] = {
      groupId: record.groupId,
      windowId: record.windowId,
      openNonce: typeof record.openNonce === 'string' && record.openNonce.trim() ? record.openNonce : undefined,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    }
  }

  return normalized
}

async function loadBindings(): Promise<void> {
  if (bindingsLoaded) return
  bindingsLoaded = true
  installBindingsSyncListener()

  try {
    const stored = await chrome.storage.local.get({
      [ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]: {},
      [ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]: -1,
    })

    const nextBindings = normalizeStoredBindings(stored[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY])
    replaceBindings(nextBindings)

    if (activeNine1Groups.size > 0) return

    const legacyGroupId = stored[ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]
    if (typeof legacyGroupId !== 'number' || legacyGroupId < 0) return
    if (!(await groupExists(legacyGroupId))) return

    const groupWindowId = await getGroupWindowId(legacyGroupId)
    if (groupWindowId === null) return

    setBinding({
      groupId: legacyGroupId,
      windowId: groupWindowId,
      updatedAt: Date.now(),
    })
    await persistBindings()
  } catch (error) {
    recordError('load_bindings_failed', error)
  }
}

export async function refreshBindingsFromStorage(): Promise<void> {
  try {
    installBindingsSyncListener()
    const stored = await chrome.storage.local.get({
      [ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]: {},
    })
    replaceBindings(normalizeStoredBindings(stored[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]))
  } catch (error) {
    recordError('refresh_bindings_from_storage_failed', error)
  }
}

async function findMatchingNine1Groups(windowId: number): Promise<MatchingNine1Group[]> {
  try {
    const tabs = await chrome.tabs.query({ windowId })
    const groupIds = Array.from(
      new Set(
        tabs
          .map((tab) => tab.groupId)
          .filter((groupId): groupId is number => typeof groupId === 'number' && groupId >= 0),
      ),
    )

    const groups = await Promise.all(
      groupIds.map(async (groupId) => {
        try {
          const group = await chrome.tabGroups.get(groupId)
          if (!isNine1GroupTitle(group.title)) return null
          return {
            groupId,
            windowId: group.windowId,
            title: group.title ?? '',
          } satisfies MatchingNine1Group
        } catch {
          return null
        }
      }),
    )

    return groups.filter((group): group is MatchingNine1Group => group !== null)
  } catch (error) {
    recordError('matching_group_scan_failed', error)
    return []
  }
}

export function pickRecoverableNine1Group(options: {
  activeTabGroupId: number | null
  matchingGroupIds: number[]
  hadStoredBinding: boolean
}): {
  groupId: number | null
  recoverySource: TabGroupRecoverySource
  issueCode?: string
} {
  const { activeTabGroupId, matchingGroupIds, hadStoredBinding } = options

  if (
    typeof activeTabGroupId === 'number'
    && matchingGroupIds.includes(activeTabGroupId)
  ) {
    return {
      groupId: activeTabGroupId,
      recoverySource: 'active-tab-match',
    }
  }

  if (matchingGroupIds.length === 1) {
    return {
      groupId: matchingGroupIds[0] ?? null,
      recoverySource: 'single-title-match',
    }
  }

  if (matchingGroupIds.length > 1) {
    return {
      groupId: null,
      recoverySource: 'none',
      issueCode: 'ambiguous_matching_groups',
    }
  }

  return {
    groupId: null,
    recoverySource: 'none',
    issueCode: hadStoredBinding ? 'group_binding_stale' : 'no_active_group',
  }
}

async function resolveActiveGroup(options: ResolveGroupOptions = {}): Promise<TabGroupResolution> {
  await loadBindings()

  const effectiveWindowId = await resolveWindowId(options.windowId)
  if (effectiveWindowId === null) {
    const resolution: TabGroupResolution = {
      windowId: null,
      groupId: null,
      binding: null,
      recoverySource: 'none',
      issueCode: 'window_unavailable',
      matchedGroupIds: [],
      resolvedAt: Date.now(),
    }
    return resolution
  }

  const storedBinding = activeNine1Groups.get(effectiveWindowId) ?? null
  const storedBindingWindowId = storedBinding
    ? await getGroupWindowId(storedBinding.groupId)
    : null
  if (storedBinding && storedBindingWindowId === effectiveWindowId) {
    const resolution: TabGroupResolution = {
      windowId: effectiveWindowId,
      groupId: storedBinding.groupId,
      binding: { ...storedBinding },
      recoverySource: 'stored',
      matchedGroupIds: [storedBinding.groupId],
      resolvedAt: Date.now(),
    }
    setLastResolution(resolution)
    return resolution
  }

  if (storedBinding) {
    activeNine1Groups.delete(effectiveWindowId)
    await persistBindings()
  }

  const matchingGroups = await findMatchingNine1Groups(effectiveWindowId)
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: effectiveWindowId }).catch(() => [])
  const selection = pickRecoverableNine1Group({
    activeTabGroupId:
      typeof activeTab?.groupId === 'number' && activeTab.groupId >= 0
        ? activeTab.groupId
        : null,
    matchingGroupIds: matchingGroups.map((group) => group.groupId),
    hadStoredBinding: Boolean(storedBinding),
  })

  if (selection.groupId !== null && options.persistRecovered !== false) {
    await persistBinding(effectiveWindowId, selection.groupId)
  }

  const binding = selection.groupId === null
    ? null
    : activeNine1Groups.get(effectiveWindowId) ?? {
      groupId: selection.groupId,
      windowId: effectiveWindowId,
      updatedAt: Date.now(),
    }

  const resolution: TabGroupResolution = {
    windowId: effectiveWindowId,
    groupId: selection.groupId,
    binding,
    recoverySource: selection.recoverySource,
    issueCode: selection.issueCode,
    matchedGroupIds: matchingGroups.map((group) => group.groupId),
    resolvedAt: Date.now(),
  }
  setLastResolution(resolution)
  return resolution
}

export async function getActiveNine1GroupId(windowId?: number): Promise<number | null> {
  const resolution = await resolveActiveGroup({ windowId })
  return resolution.groupId
}

export async function createDedicatedNine1Group(
  tabId: number,
  taskLabel?: string,
  options: { openNonce?: string } = {},
): Promise<number | null> {
  const tab = await getTab(tabId)
  if (!tab?.id || typeof tab.windowId !== 'number') return null

  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] })
    await updateGroup(groupId, { collapsed: false, taskLabel })
    await persistBinding(tab.windowId, groupId, { openNonce: options.openNonce })
    setLastResolution({
      windowId: tab.windowId,
      groupId,
      binding: activeNine1Groups.get(tab.windowId) ?? null,
      recoverySource: 'stored',
      matchedGroupIds: [groupId],
      resolvedAt: Date.now(),
    })
    return groupId
  } catch (error) {
    recordError('create_dedicated_group_failed', error)
    return null
  }
}

export async function addTabToNine1Group(
  tabId: number,
  taskLabel?: string,
  options: AddTabOptions = {},
): Promise<number | null> {
  const tab = await getTab(tabId)
  if (!tab?.id || typeof tab.windowId !== 'number') return null

  try {
    const resolution = await resolveActiveGroup({ windowId: tab.windowId })
    let groupId = resolution.groupId

    if (options.onlyIfMissing && groupId !== null) {
      await updateGroup(groupId, { collapsed: false, taskLabel })
      return groupId
    }

    if (groupId === null) {
      return await createDedicatedNine1Group(tabId, taskLabel, { openNonce: options.openNonce })
    }

    const existingGroupId = await getGroupIdForTab(tabId)
    if (existingGroupId !== groupId) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], groupId })
      await persistBinding(tab.windowId, groupId, { openNonce: options.openNonce })
    }

    await updateGroup(groupId, { collapsed: false, taskLabel })
    return groupId
  } catch (error) {
    recordError('add_tab_to_group_failed', error)
    return null
  }
}

export async function isTabInActiveNine1Group(tabId: number, windowId?: number): Promise<boolean> {
  const tab = await getTab(tabId)
  if (!tab) return false
  const activeGroupId = await getActiveNine1GroupId(windowId ?? tab.windowId)
  if (activeGroupId === null) return false
  return tab.groupId === activeGroupId
}

export async function getTabsInActiveNine1Group(windowId?: number): Promise<chrome.tabs.Tab[]> {
  const resolution = await resolveActiveGroup({ windowId })
  if (resolution.groupId === null) return []
  try {
    return await chrome.tabs.query({ groupId: resolution.groupId, windowId: resolution.windowId ?? undefined })
  } catch (error) {
    recordError('active_group_tabs_query_failed', error)
    return []
  }
}

export async function getTabsInAllActiveNine1Groups(): Promise<chrome.tabs.Tab[]> {
  try {
    const windows = await chrome.windows.getAll({ populate: false })
    const tabs = await Promise.all(
      windows
        .map((window) => window.id)
        .filter((windowId): windowId is number => typeof windowId === 'number')
        .map((windowId) => getTabsInActiveNine1Group(windowId)),
    )
    return tabs.flat()
  } catch (error) {
    recordError('all_active_group_tabs_query_failed', error)
    return []
  }
}

export async function getTabsInGroupByTab(tabId: number): Promise<number[]> {
  const tab = await getTab(tabId)
  if (!tab?.id) return [tabId]

  try {
    if (!await isTabInActiveNine1Group(tabId, tab.windowId)) return [tabId]
    const tabs = await getTabsInActiveNine1Group(tab.windowId)
    const tabIds = tabs
      .map((candidate) => candidate.id)
      .filter((candidate): candidate is number => typeof candidate === 'number')
    return tabIds.length > 0 ? tabIds : [tabId]
  } catch (error) {
    recordError('group_tabs_by_tab_failed', error)
    return [tabId]
  }
}

export async function getDefaultNine1Tab(windowId?: number): Promise<chrome.tabs.Tab | null> {
  const effectiveWindowId = await resolveWindowId(windowId)
  const tabs = await getTabsInActiveNine1Group(effectiveWindowId ?? undefined)
  if (tabs.length === 0) return null

  const activeInWindow = tabs.find((tab) => tab.active && (effectiveWindowId === null || tab.windowId === effectiveWindowId))
  if (activeInWindow) return activeInWindow

  const active = tabs.find((tab) => tab.active)
  return active ?? tabs[0] ?? null
}

export async function setNine1GroupActive(tabId: number, taskLabel?: string): Promise<void> {
  try {
    const tab = await getTab(tabId)
    if (!tab?.id || typeof tab.windowId !== 'number') return
    if (!await isTabInActiveNine1Group(tabId, tab.windowId)) return
    const groupId = await getActiveNine1GroupId(tab.windowId)
    if (groupId === null) return
    await updateGroup(groupId, { collapsed: false, taskLabel })
  } catch (error) {
    recordError('set_group_active_failed', error)
  }
}

export async function setNine1GroupIdle(tabId: number): Promise<void> {
  try {
    const tab = await getTab(tabId)
    if (!tab?.id || typeof tab.windowId !== 'number') return
    if (!await isTabInActiveNine1Group(tabId, tab.windowId)) return
    const groupId = await getActiveNine1GroupId(tab.windowId)
    if (groupId === null) return
    await updateGroup(groupId, { collapsed: true })
  } catch (error) {
    recordError('set_group_idle_failed', error)
  }
}

async function cleanupMissingActiveGroups(): Promise<void> {
  await loadBindings()
  const windowIds = Array.from(activeNine1Groups.keys())

  for (const windowId of windowIds) {
    const binding = activeNine1Groups.get(windowId)
    if (!binding) continue
    if (await groupExists(binding.groupId)) continue
    await persistBinding(windowId, null)
  }
}

export async function getTabGroupDiagnostics(windowId?: number): Promise<TabGroupDiagnostics> {
  await loadBindings()
  const currentWindowId = await resolveWindowId(windowId)
  if (currentWindowId !== null && !lastResolutionByWindow.has(currentWindowId)) {
    await resolveActiveGroup({ windowId: currentWindowId, persistRecovered: false })
  }

  return {
    currentWindowId,
    bindings: bindingToStorageRecord(),
    lastResolutionByWindow: Object.fromEntries(
      Array.from(lastResolutionByWindow.entries()).map(([resolvedWindowId, resolution]) => [
        String(resolvedWindowId),
        { ...resolution },
      ]),
    ),
    lastError: lastError ? { ...lastError } : null,
  }
}

export function setupTabGroupCleanup(): void {
  if (cleanupInstalled) return
  cleanupInstalled = true

  chrome.tabs.onRemoved.addListener(() => {
    cleanupMissingActiveGroups().catch((error) => {
      recordError('cleanup_missing_active_group_failed', error)
    })
  })
}

export function __resetTabGroupManagerStateForTests(): void {
  cleanupInstalled = false
  bindingsLoaded = false
  activeNine1Groups.clear()
  lastResolutionByWindow.clear()
  lastError = null
}
