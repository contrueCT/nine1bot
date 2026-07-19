import { beforeEach, describe, expect, test } from 'bun:test'
import {
  ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY,
  ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY,
  NINE1_TAB_GROUP_TITLE_PREFIX,
} from '../src/shared/tab-group'
import {
  __resetTabGroupManagerStateForTests,
  getActiveNine1GroupId,
  getTabGroupDiagnostics,
  refreshBindingsFromStorage,
} from '../src/background/tab-group-manager'

interface MockTab {
  id: number
  windowId: number
  groupId: number
  active?: boolean
  url?: string
  title?: string
}

interface MockGroup {
  id: number
  windowId: number
  title?: string
  color?: chrome.tabGroups.ColorEnum
  collapsed?: boolean
}

const state: {
  tabs: Map<number, MockTab>
  groups: Map<number, MockGroup>
  storage: Record<string, unknown>
  currentWindowId: number
  storageListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void>
} = {
  tabs: new Map(),
  groups: new Map(),
  storage: {},
  currentWindowId: 1,
  storageListeners: [],
}

function resetChromeState(): void {
  state.tabs.clear()
  state.groups.clear()
  state.storage = {}
  state.currentWindowId = 1
  state.storageListeners = []
  __resetTabGroupManagerStateForTests()
}

function setTabs(tabs: MockTab[]): void {
  state.tabs = new Map(tabs.map((tab) => [tab.id, { ...tab }]))
}

function setGroups(groups: MockGroup[]): void {
  state.groups = new Map(groups.map((group) => [group.id, { ...group }]))
}

beforeEach(() => {
  resetChromeState()

  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(defaults: Record<string, unknown>) {
          return {
            ...defaults,
            ...state.storage,
          }
        },
        async set(values: Record<string, unknown>) {
          const changes = Object.fromEntries(
            Object.entries(values).map(([key, newValue]) => [
              key,
              { oldValue: state.storage[key], newValue },
            ]),
          )
          state.storage = {
            ...state.storage,
            ...values,
          }
          for (const listener of state.storageListeners) {
            listener(changes, 'local')
          }
        },
        async remove(key: string) {
          const oldValue = state.storage[key]
          delete state.storage[key]
          for (const listener of state.storageListeners) {
            listener({ [key]: { oldValue, newValue: undefined } }, 'local')
          }
        },
      },
      onChanged: {
        addListener(listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) {
          state.storageListeners.push(listener)
        },
      },
    },
    tabs: {
      async get(tabId: number) {
        const tab = state.tabs.get(tabId)
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return { ...tab }
      },
      async query(queryInfo: {
        active?: boolean
        currentWindow?: boolean
        windowId?: number
        groupId?: number
      }) {
        return Array.from(state.tabs.values()).filter((tab) => {
          if (typeof queryInfo.groupId === 'number' && tab.groupId !== queryInfo.groupId) return false
          if (typeof queryInfo.windowId === 'number' && tab.windowId !== queryInfo.windowId) return false
          if (queryInfo.currentWindow && tab.windowId !== state.currentWindowId) return false
          if (queryInfo.active && !tab.active) return false
          return true
        }).map((tab) => ({ ...tab }))
      },
      async group(options: { tabIds: number[]; groupId?: number }) {
        const nextGroupId = options.groupId ?? Math.max(0, ...state.groups.keys()) + 1
        if (!state.groups.has(nextGroupId)) {
          const firstTab = state.tabs.get(options.tabIds[0]!)
          state.groups.set(nextGroupId, {
            id: nextGroupId,
            windowId: firstTab?.windowId ?? state.currentWindowId,
            title: NINE1_TAB_GROUP_TITLE_PREFIX,
          })
        }
        for (const tabId of options.tabIds) {
          const tab = state.tabs.get(tabId)
          if (!tab) continue
          state.tabs.set(tabId, { ...tab, groupId: nextGroupId })
        }
        return nextGroupId
      },
      onRemoved: {
        addListener() {
          return undefined
        },
      },
    },
    tabGroups: {
      async get(groupId: number) {
        const group = state.groups.get(groupId)
        if (!group) throw new Error(`Missing group ${groupId}`)
        return { ...group }
      },
      async update(groupId: number, updateInfo: Partial<MockGroup>) {
        const group = state.groups.get(groupId)
        if (!group) throw new Error(`Missing group ${groupId}`)
        const next = { ...group, ...updateInfo }
        state.groups.set(groupId, next)
        return { ...next }
      },
    },
    windows: {
      async getLastFocused() {
        return { id: state.currentWindowId }
      },
      async getAll() {
        return Array.from(
          new Set(Array.from(state.tabs.values()).map((tab) => tab.windowId)),
        ).map((id) => ({ id }))
      },
    },
  }
})

describe('tab group manager recovery', () => {
  test('reuses a valid stored binding without rebuilding the group', async () => {
    setGroups([{ id: 10, windowId: 1, title: NINE1_TAB_GROUP_TITLE_PREFIX }])
    setTabs([{ id: 1, windowId: 1, groupId: 10, active: true }])
    state.storage[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY] = {
      '1': { groupId: 10, windowId: 1, updatedAt: 1 },
    }

    await expect(getActiveNine1GroupId(1)).resolves.toBe(10)

    const diagnostics = await getTabGroupDiagnostics(1)
    expect(diagnostics.lastResolutionByWindow['1']?.recoverySource).toBe('stored')
  })

  test('recovers from a stale binding using the active tab matching group', async () => {
    setGroups([{ id: 11, windowId: 1, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: task` }])
    setTabs([{ id: 2, windowId: 1, groupId: 11, active: true }])
    state.storage[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY] = {
      '1': { groupId: 999, windowId: 1, updatedAt: 1 },
    }

    await expect(getActiveNine1GroupId(1)).resolves.toBe(11)

    const diagnostics = await getTabGroupDiagnostics(1)
    expect(diagnostics.lastResolutionByWindow['1']?.recoverySource).toBe('active-tab-match')
  })

  test('rejects stored bindings when the group moved to another window', async () => {
    setGroups([
      { id: 12, windowId: 2, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: moved` },
      { id: 13, windowId: 1, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: local` },
    ])
    setTabs([
      { id: 6, windowId: 1, groupId: 13, active: true },
      { id: 7, windowId: 2, groupId: 12, active: false },
    ])
    state.storage[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY] = {
      '1': { groupId: 12, windowId: 1, updatedAt: 1 },
    }

    await expect(getActiveNine1GroupId(1)).resolves.toBe(13)

    const diagnostics = await getTabGroupDiagnostics(1)
    expect(diagnostics.lastResolutionByWindow['1']?.recoverySource).toBe('active-tab-match')
    expect(diagnostics.bindings['1']?.groupId).toBe(13)
  })

  test('prefers the active tab group when multiple matching groups exist', async () => {
    setGroups([
      { id: 21, windowId: 1, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: first` },
      { id: 22, windowId: 1, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: second` },
    ])
    setTabs([
      { id: 3, windowId: 1, groupId: 21, active: false },
      { id: 4, windowId: 1, groupId: 22, active: true },
    ])

    await expect(getActiveNine1GroupId(1)).resolves.toBe(22)

    const diagnostics = await getTabGroupDiagnostics(1)
    expect(diagnostics.lastResolutionByWindow['1']?.matchedGroupIds).toEqual([21, 22])
    expect(diagnostics.lastResolutionByWindow['1']?.recoverySource).toBe('active-tab-match')
  })

  test('migrates the legacy single-value storage key to window-scoped bindings', async () => {
    setGroups([{ id: 30, windowId: 5, title: NINE1_TAB_GROUP_TITLE_PREFIX }])
    setTabs([{ id: 5, windowId: 5, groupId: 30, active: true }])
    state.storage[ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY] = 30
    state.currentWindowId = 5

    await expect(getActiveNine1GroupId(5)).resolves.toBe(30)

    const diagnostics = await getTabGroupDiagnostics(5)
    expect(diagnostics.bindings['5']?.groupId).toBe(30)
    expect(state.storage[ACTIVE_NINE1_TAB_GROUP_STORAGE_KEY]).toBeUndefined()
  })

  test('refreshes cached bindings when another extension context updates storage', async () => {
    setGroups([
      { id: 40, windowId: 1, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: first` },
      { id: 41, windowId: 1, title: `${NINE1_TAB_GROUP_TITLE_PREFIX}: second` },
    ])
    setTabs([
      { id: 8, windowId: 1, groupId: 40, active: true },
      { id: 9, windowId: 1, groupId: 41, active: false },
    ])
    state.storage[ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY] = {
      '1': { groupId: 40, windowId: 1, updatedAt: 1 },
    }

    await expect(getActiveNine1GroupId(1)).resolves.toBe(40)

    await (globalThis.chrome as typeof chrome).storage.local.set({
      [ACTIVE_NINE1_TAB_GROUPS_STORAGE_KEY]: {
        '1': { groupId: 41, windowId: 1, updatedAt: 2 },
      },
    })

    await refreshBindingsFromStorage()
    await expect(getActiveNine1GroupId(1)).resolves.toBe(41)
  })
})
