/**
 * Nine1Bot Browser Control Extension - Service Worker
 *
 * This is the main entry point for the Chrome extension's background service worker.
 * It initializes the Relay Client that connects to Nine1Bot's built-in /browser relay.
 */

import { initRelayClient, isRelayConnected, connectToRelay, activateDedicatedNine1TabGroup } from './relay-client'
import { SIDE_PANEL_OPEN_NONCE_STORAGE_KEY } from '../shared/server-config'

console.log('[Nine1Bot Browser Control] Service Worker starting...')

// Initialize Relay Client (connects to the built-in browser relay)
initRelayClient()

// Extension installation/update handler
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Nine1Bot Browser Control] Extension installed/updated:', details.reason)

  if (details.reason === 'install') {
    console.log('[Nine1Bot Browser Control] First-time installation')
    // Could open welcome page or show notification here
  } else if (details.reason === 'update') {
    console.log('[Nine1Bot Browser Control] Extension updated from version:', details.previousVersion)
  }
})

// Handle extension startup
chrome.runtime.onStartup.addListener(() => {
  console.log('[Nine1Bot Browser Control] Browser startup - extension loaded')
  // Reconnect to relay on browser startup
  connectToRelay()
})

// Handle browser action click (extension icon)
function createOpenNonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function markSidePanelOpened(openNonce: string): Promise<void> {
  await chrome.storage.sync.set({ [SIDE_PANEL_OPEN_NONCE_STORAGE_KEY]: openNonce })
}

async function openSidePanel(windowId: number): Promise<void> {
  const openNonce = createOpenNonce()
  await activateDedicatedNine1TabGroup(windowId, { openNonce }).catch((error) => {
    console.warn('[Nine1Bot Browser Control] Failed to activate dedicated tab group:', error)
  })
  await markSidePanelOpened(openNonce).catch((error) => {
    console.warn('[Nine1Bot Browser Control] Failed to persist side panel open nonce:', error)
  })
  await chrome.sidePanel.open({ windowId })
}

chrome.action.onClicked.addListener((tab) => {
  console.log('[Nine1Bot Browser Control] Extension icon clicked, tab:', tab.id)

  // Prefer opening side panel on icon click
  const windowId = tab.windowId
  openSidePanel(windowId)
    .catch((error) => {
      console.warn('[Nine1Bot Browser Control] Failed to open side panel:', error)
    })
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-side-panel') return
  const windowId = tab?.windowId
  if (windowId === undefined) return
  openSidePanel(windowId).catch((error) => {
    console.warn('[Nine1Bot Browser Control] Failed to open side panel via command:', error)
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nine1bot-sidepanel-health-check') {
    sendResponse({ connected: isRelayConnected() })
    return true
  }
  if (message?.type === 'nine1bot-sidepanel-ensure-tab-group') {
    activateDedicatedNine1TabGroup(undefined, {
      onlyIfMissing: Boolean(message.onlyIfMissing),
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    return true
  }
  return false
})

// Keep service worker alive periodically
const KEEP_ALIVE_INTERVAL = 20 * 1000 // 20 seconds

setInterval(() => {
  // Ping to keep service worker alive
  const connected = isRelayConnected()
  console.log('[Nine1Bot Browser Control] Keep-alive ping, relay:', connected ? 'connected' : 'disconnected')
}, KEEP_ALIVE_INTERVAL)

console.log('[Nine1Bot Browser Control] Service Worker initialized')
console.log('[Nine1Bot Browser Control] Relay Client will connect to the configured Nine1Bot /browser/extension endpoint')
