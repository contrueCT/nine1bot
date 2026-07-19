/**
 * Shared type definitions for browser-mcp-server
 */

export interface BrowserMcpConfig {
  /** Chrome CDP debugging port (default: 9222) */
  cdpPort?: number
  /** Auto-launch Chrome if not running (default: true) */
  autoLaunch?: boolean
  /** Run Chrome in headless mode (default: false) */
  headless?: boolean
  /** Chrome executable path (auto-detected if omitted) */
  chromePath?: string
}

export interface Tab {
  id: string
  title: string
  url: string
  sessionId?: string
  active?: boolean
  windowId?: number
}

export interface TabGroupDiagnostics {
  currentWindowId: number | null
  bindings: Record<string, {
    groupId: number
    windowId: number
    openNonce?: string
    updatedAt: number
  }>
  lastResolutionByWindow: Record<string, {
    windowId: number | null
    groupId: number | null
    binding: {
      groupId: number
      windowId: number
      openNonce?: string
      updatedAt: number
    } | null
    recoverySource: 'stored' | 'active-tab-match' | 'single-title-match' | 'none'
    issueCode?: string
    matchedGroupIds: number[]
    resolvedAt: number
  }>
  lastError: {
    code: string
    message: string
    at: number
  } | null
}

export interface PageContent {
  title: string
  url: string
  content: string
}

export interface ScreenshotOptions {
  fullPage?: boolean
  format?: 'png' | 'jpeg'
  quality?: number
  ref?: string
}

/** Result from Chrome extension tool execution */
export interface ExtensionToolResult {
  content: Array<{
    type: 'text' | 'image'
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

// ==================== Dual-mode types ====================

/** Target browser: user's browser (Extension) or bot's browser (CDP) */
export type BrowserTarget = 'user' | 'bot'

/** Status of both browser channels */
export interface BrowserStatus {
  user: {
    connected: boolean
    tabs: Tab[]
    tabListSource?: 'authoritative_group_scan' | 'relay_cache_fallback' | 'none'
  } | null
  bot: {
    running: boolean
    tabs: Tab[]
  } | null
  runtime?: BrowserRuntimeStatus
}

export interface BrowserStatusIssue {
  code: string
  severity: 'warning' | 'error'
  message: string
}

export interface BrowserRuntimeConflict {
  host: string
  port: number
  message: string
}

export interface BrowserRuntimeStatus {
  mode: 'embedded'
  serverOrigin: string
  instanceId: string
  extension: {
    connected: boolean
    helloAt: number | null
    version: string | null
    protocolVersion: string | null
    serverOrigin: string | null
    pairedInstanceId: string | null
    diagnostics?: {
      authoritativeTabs: Array<{
        tabId: number
        windowId: number
        title: string
        url: string
      }>
      activeSessions: Array<{
        tabId: number
        sessionId: string
      }>
      tabGroups: TabGroupDiagnostics
      lastResync: {
        reason: string
        windowId: number | null
        attachedTabIds: number[]
        detachedTabIds: number[]
        updatedTabIds: number[]
        authoritativeTabIds: number[]
        at: number
      } | null
    } | null
  }
  conflicts: BrowserRuntimeConflict[]
  issues: BrowserStatusIssue[]
}

/** Snapshot (a11y tree) result */
export interface SnapshotResult {
  title: string
  url: string
  snapshot: string
}

/** Click options */
export interface ClickOptions {
  ref?: string
  targetId?: string
  coordinate?: [number, number]
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

/** Key map for special keys */
export const KEY_MAP: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: ' ',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
}

/** Modifier key bitmask for CDP Input.dispatchKeyEvent */
export const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
}
