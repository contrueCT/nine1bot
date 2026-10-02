import { ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY } from '../shared/tab-group'

const NINE1_TAB_GROUP_TITLE = 'Nine1Bot'
const NINE1_TAB_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'blue'

let cleanupInstalled = false
let activeNine1GroupId: number | null = null
let activeGroupRevision = 0

/** Synchronous invalidation boundary for commands that outlive group changes. */
export function getNine1GroupRevision(): number { return activeGroupRevision }

function rememberActiveGroup(groupId: number | null): void {
  if (activeNine1GroupId !== groupId) {
    activeNine1GroupId = groupId
    activeGroupRevision += 1
  }
}

function formatGroupTitle(taskLabel?: string): string {
  if (!taskLabel) return NINE1_TAB_GROUP_TITLE
  const trimmed = taskLabel.trim()
  if (!trimmed) return NINE1_TAB_GROUP_TITLE
  return `${NINE1_TAB_GROUP_TITLE}: ${trimmed.slice(0, 32)}`
}

async function getGroupIdForTab(tabId: number): Promise<number | null> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return typeof tab.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : null
  } catch {
    return null
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

async function getGroupWindowId(groupId: number): Promise<number | null> {
  try {
    const group = await chrome.tabGroups.get(groupId)
    return typeof group.windowId === 'number' ? group.windowId : null
  } catch {
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

async function updateGroup(groupId: number, options: {
  collapsed?: boolean
  taskLabel?: string
}, shouldUpdate: () => boolean = () => true): Promise<void> {
  if (!shouldUpdate()) return
  await chrome.tabGroups.update(groupId, {
    title: formatGroupTitle(options.taskLabel),
    color: NINE1_TAB_GROUP_COLOR,
    collapsed: options.collapsed ?? false,
  })
}

async function persistActiveGroup(groupId: number | null): Promise<void> {
  rememberActiveGroup(groupId)
  try {
    if (groupId === null) {
      await chrome.storage.local.remove(ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY)
    } else {
      await chrome.storage.local.set({ [ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]: groupId })
    }
  } catch {
    // Storage is only a coordination convenience for side panel pages.
  }
}

export async function getActiveNine1GroupId(): Promise<number | null> {
  const revision = activeGroupRevision
  const candidate = activeNine1GroupId
  if (candidate !== null && await groupExists(candidate)) {
    if (revision !== activeGroupRevision) return getActiveNine1GroupId()
    return candidate
  }
  if (revision !== activeGroupRevision) return getActiveNine1GroupId()

  try {
    const stored = await chrome.storage.local.get({ [ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]: -1 })
    if (revision !== activeGroupRevision) return getActiveNine1GroupId()
    const groupId = stored[ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]
    const exists = typeof groupId === 'number' && groupId >= 0 && await groupExists(groupId)
    if (revision !== activeGroupRevision) return getActiveNine1GroupId()
    if (exists) {
      rememberActiveGroup(groupId)
      return groupId
    }
  } catch {
    if (revision !== activeGroupRevision) return getActiveNine1GroupId()
    // ignore storage failures
  }

  await persistActiveGroup(null)
  return null
}

/** Return the ID and its revision together, including across promise continuations. */
export async function getActiveNine1GroupSnapshot(): Promise<{ groupId: number | null; revision: number }> {
  while (true) {
    const groupId = await getActiveNine1GroupId()
    if (groupId === activeNine1GroupId) return { groupId, revision: activeGroupRevision }
  }
}

export async function createDedicatedNine1Group(tabId: number, taskLabel?: string): Promise<number | null> {
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] })
    await updateGroup(groupId, { collapsed: false, taskLabel })
    await persistActiveGroup(groupId)
    return groupId
  } catch {
    return null
  }
}

export async function addTabToNine1Group(tabId: number, taskLabel?: string): Promise<number | null> {
  try {
    const tab = await getTab(tabId)
    if (!tab) return null

    let groupId = await getActiveNine1GroupId()
    if (groupId === null) {
      return await createDedicatedNine1Group(tabId, taskLabel)
    }

    const groupWindowId = await getGroupWindowId(groupId)
    if (groupWindowId !== null && groupWindowId !== tab.windowId) {
      return await createDedicatedNine1Group(tabId, taskLabel)
    }

    const existingGroupId = await getGroupIdForTab(tabId)
    if (existingGroupId !== groupId) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], groupId })
      await persistActiveGroup(groupId)
    }

    await updateGroup(groupId, { collapsed: false, taskLabel })
    return groupId
  } catch {
    return null
  }
}

export async function isTabInActiveNine1Group(tabId: number): Promise<boolean> {
  const activeGroupId = await getActiveNine1GroupId()
  if (activeGroupId === null) return false
  return await getGroupIdForTab(tabId) === activeGroupId
}

export async function getTabsInActiveNine1Group(): Promise<chrome.tabs.Tab[]> {
  const groupId = await getActiveNine1GroupId()
  if (groupId === null) return []
  try {
    return await chrome.tabs.query({ groupId })
  } catch {
    return []
  }
}

export async function getTabsInGroupByTab(tabId: number): Promise<number[]> {
  try {
    if (!await isTabInActiveNine1Group(tabId)) return [tabId]
    const tabs = await getTabsInActiveNine1Group()
    const tabIds = tabs
      .map((tab) => tab.id)
      .filter((candidate): candidate is number => typeof candidate === 'number')
    return tabIds.length > 0 ? tabIds : [tabId]
  } catch {
    return [tabId]
  }
}

export async function getDefaultNine1Tab(windowId?: number): Promise<chrome.tabs.Tab | null> {
  const tabs = await getTabsInActiveNine1Group()
  if (tabs.length === 0) return null

  const activeInWindow = tabs.find((tab) => tab.active && (windowId === undefined || tab.windowId === windowId))
  if (activeInWindow) return activeInWindow

  const active = tabs.find((tab) => tab.active)
  return active ?? tabs[0] ?? null
}

export async function setNine1GroupActive(tabId: number, taskLabel?: string, shouldUpdate: () => boolean = () => true): Promise<void> {
  try {
    if (!await isTabInActiveNine1Group(tabId)) return
    const groupId = await getActiveNine1GroupId()
    if (groupId === null) return
    await updateGroup(groupId, { collapsed: false, taskLabel }, shouldUpdate)
  } catch {
    // ignore tab/group lifecycle races
  }
}

export async function setNine1GroupIdle(tabId: number, shouldUpdate: () => boolean = () => true): Promise<void> {
  try {
    if (!await isTabInActiveNine1Group(tabId)) return
    const groupId = await getActiveNine1GroupId()
    if (groupId === null) return
    await updateGroup(groupId, { collapsed: true }, shouldUpdate)
  } catch {
    // ignore tab/group lifecycle races
  }
}

async function cleanupMissingActiveGroup(): Promise<void> {
  const groupId = await getActiveNine1GroupId()
  if (groupId === null) return
  const tabs = await getTabsInActiveNine1Group()
  if (tabs.length === 0) {
    await persistActiveGroup(null)
  }
}

export function setupTabGroupCleanup(): void {
  if (cleanupInstalled) return
  cleanupInstalled = true

  chrome.tabs.onRemoved.addListener(() => {
    cleanupMissingActiveGroup().catch(() => {
      // Tab groups self-heal as tabs close; this keeps setup idempotent.
    })
  })
}
