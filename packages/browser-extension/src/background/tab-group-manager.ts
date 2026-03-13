const GROUP_COLOR: chrome.tabGroups.ColorEnum = 'orange'
const ACTIVE_TITLE_PREFIX = 'Nine1Bot'
const IDLE_SUFFIX = '(idle)'

const windowToGroupId = new Map<number, number>()
const tabToGroupId = new Map<number, number>()

function buildTitle(taskLabel?: string, active = true): string {
  const base = taskLabel ? `${ACTIVE_TITLE_PREFIX} - ${taskLabel}` : ACTIVE_TITLE_PREFIX
  return active ? base : `${base} ${IDLE_SUFFIX}`
}

async function ensureWindowGroup(windowId: number, seedTabId: number, taskLabel?: string): Promise<number> {
  const existingGroupId = windowToGroupId.get(windowId)
  if (existingGroupId !== undefined) {
    await chrome.tabs.group({ groupId: existingGroupId, tabIds: [seedTabId] })
    tabToGroupId.set(seedTabId, existingGroupId)
    await chrome.tabGroups.update(existingGroupId, {
      title: buildTitle(taskLabel, true),
      color: GROUP_COLOR,
      collapsed: false,
    })
    return existingGroupId
  }

  const groupId = await chrome.tabs.group({ tabIds: [seedTabId] })
  windowToGroupId.set(windowId, groupId)
  tabToGroupId.set(seedTabId, groupId)
  await chrome.tabGroups.update(groupId, {
    title: buildTitle(taskLabel, true),
    color: GROUP_COLOR,
    collapsed: false,
  })
  return groupId
}

export async function addTabToNine1Group(tabId: number, taskLabel?: string): Promise<number | null> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const groupId = await ensureWindowGroup(tab.windowId, tabId, taskLabel)
    return groupId
  } catch (error) {
    console.warn('[TabGroup] Failed to add tab to group:', tabId, error)
    return null
  }
}

export async function setNine1GroupActive(tabId: number, taskLabel?: string): Promise<void> {
  const groupId = tabToGroupId.get(tabId)
  if (groupId === undefined) {
    await addTabToNine1Group(tabId, taskLabel)
    return
  }
  try {
    await chrome.tabGroups.update(groupId, {
      title: buildTitle(taskLabel, true),
      color: GROUP_COLOR,
      collapsed: false,
    })
  } catch (error) {
    console.warn('[TabGroup] Failed to set group active:', groupId, error)
  }
}

export async function setNine1GroupIdle(tabId: number): Promise<void> {
  const groupId = tabToGroupId.get(tabId)
  if (groupId === undefined) return
  try {
    await chrome.tabGroups.update(groupId, {
      title: buildTitle(undefined, false),
      color: GROUP_COLOR,
    })
  } catch (error) {
    console.warn('[TabGroup] Failed to set group idle:', groupId, error)
  }
}

export async function getTabsInGroupByTab(tabId: number): Promise<number[]> {
  const groupId = tabToGroupId.get(tabId)
  if (groupId === undefined) return [tabId]
  const tabs = await chrome.tabs.query({ groupId })
  return tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
}

export function setupTabGroupCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabToGroupId.delete(tabId)
  })

  chrome.tabGroups.onRemoved.addListener((group) => {
    for (const [windowId, gid] of windowToGroupId) {
      if (gid === group.id) {
        windowToGroupId.delete(windowId)
      }
    }
    for (const [tabId, gid] of tabToGroupId) {
      if (gid === group.id) {
        tabToGroupId.delete(tabId)
      }
    }
  })
}

