/**
 * Nine1Bot Browser Control Extension - Service Worker
 *
 * This is the main entry point for the Chrome extension's background service worker.
 * It initializes the Relay Client that connects to Nine1Bot's built-in /browser relay.
 */

import { initRelayClient, isRelayConnected, connectToRelay } from './relay-client'

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
chrome.action.onClicked.addListener((tab) => {
  console.log('[Nine1Bot Browser Control] Extension icon clicked, tab:', tab.id)

  // Prefer opening side panel on icon click
  const windowId = tab.windowId
  chrome.sidePanel
    .open({ windowId })
    .catch((error) => {
      console.warn('[Nine1Bot Browser Control] Failed to open side panel:', error)
    })
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-side-panel') return
  const windowId = tab?.windowId
  if (windowId === undefined) return
  chrome.sidePanel.open({ windowId }).catch((error) => {
    console.warn('[Nine1Bot Browser Control] Failed to open side panel via command:', error)
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nine1bot-sidepanel-health-check') {
    sendResponse({ connected: isRelayConnected() })
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
