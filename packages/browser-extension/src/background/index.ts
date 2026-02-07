/**
 * Nine1Bot Browser Control Extension - Service Worker
 *
 * This is the main entry point for the Chrome extension's background service worker.
 * It initializes both the MCP server (for direct connections) and the Relay Client
 * (for connecting to Nine1Bot Bridge Server).
 */

import { setupMcpServer } from './mcp-server'
import { initRelayClient, isRelayConnected, connectToRelay, disconnectFromRelay } from './relay-client'

console.log('[Nine1Bot Browser Control] Service Worker starting...')

// Initialize MCP server (for backward compatibility)
setupMcpServer()

// Initialize Relay Client (connects to Bridge Server)
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

  // Show connection status
  const connected = isRelayConnected()
  console.log('[Nine1Bot Browser Control] Relay connection status:', connected ? 'Connected' : 'Disconnected')

  if (tab.id) {
    chrome.tabs.get(tab.id, (tabInfo) => {
      console.log('[Nine1Bot Browser Control] Current tab info:', {
        url: tabInfo.url,
        title: tabInfo.title,
        relayConnected: connected,
      })
    })
  }
})

// Keep service worker alive periodically
const KEEP_ALIVE_INTERVAL = 20 * 1000 // 20 seconds

setInterval(() => {
  // Ping to keep service worker alive
  const connected = isRelayConnected()
  console.log('[Nine1Bot Browser Control] Keep-alive ping, relay:', connected ? 'connected' : 'disconnected')
}, KEEP_ALIVE_INTERVAL)

console.log('[Nine1Bot Browser Control] Service Worker initialized')
console.log('[Nine1Bot Browser Control] Relay Client will connect to ws://127.0.0.1:18793/extension')
