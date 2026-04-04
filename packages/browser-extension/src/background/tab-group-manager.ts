const NINE1_TAB_GROUP_TITLE = 'Nine1Bot'
const NINE1_TAB_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'blue'

let cleanupInstalled = false

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

async function updateGroup(groupId: number, options: {
  collapsed?: boolean
  taskLabel?: string
}): Promise<void> {
  await chrome.tabGroups.update(groupId, {
    title: formatGroupTitle(options.taskLabel),
    color: NINE1_TAB_GROUP_COLOR,
    collapsed: options.collapsed ?? false,
  })
}

export async function addTabToNine1Group(tabId: number, taskLabel?: string): Promise<number | null> {
  try {
    const existingGroupId = await getGroupIdForTab(tabId)
    if (existingGroupId !== null) {
      await updateGroup(existingGroupId, { collapsed: false, taskLabel })
      return existingGroupId
    }

    const groupId = await chrome.tabs.group({ tabIds: [tabId] })
    await updateGroup(groupId, { collapsed: false, taskLabel })
    return groupId
  } catch {
    return null
  }
}

export async function getTabsInGroupByTab(tabId: number): Promise<number[]> {
  try {
    const groupId = await getGroupIdForTab(tabId)
    if (groupId === null) return [tabId]
    const tabs = await chrome.tabs.query({ groupId })
    const tabIds = tabs
      .map((tab) => tab.id)
      .filter((candidate): candidate is number => typeof candidate === 'number')
    return tabIds.length > 0 ? tabIds : [tabId]
  } catch {
    return [tabId]
  }
}

export async function setNine1GroupActive(tabId: number, taskLabel?: string): Promise<void> {
  try {
    const groupId = await addTabToNine1Group(tabId, taskLabel)
    if (groupId === null) return
    await updateGroup(groupId, { collapsed: false, taskLabel })
  } catch {
    // ignore tab/group lifecycle races
  }
}

export async function setNine1GroupIdle(tabId: number): Promise<void> {
  try {
    const groupId = await getGroupIdForTab(tabId)
    if (groupId === null) return
    await updateGroup(groupId, { collapsed: true })
  } catch {
    // ignore tab/group lifecycle races
  }
}

export function setupTabGroupCleanup(): void {
  if (cleanupInstalled) return
  cleanupInstalled = true

  chrome.tabs.onRemoved.addListener(() => {
    // Tab groups self-heal as tabs close; this keeps setup idempotent.
  })
}
