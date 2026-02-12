// Core layer - CDP, Chrome, types
export * from './core/cdp'
export * from './core/chrome'
export * from './core/types'

// Page scripts - injectable browser-side scripts for a11y tree, find, form fill
export * from './core/page-scripts'

// Bridge layer - server with direct method API + Hono routes
export { BridgeServer } from './bridge/server'
export type { BridgeServerOptions } from './bridge/server'

// Relay routes - Bun-native WebSocket relay for extension communication
export { createRelayRoutes, getExtensionRelay } from './bridge/relay-routes'
export type { ExtensionRelay, ConnectedTarget, TargetInfo } from './bridge/relay-routes'
