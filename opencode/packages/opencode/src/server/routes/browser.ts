/**
 * Browser control routes.
 *
 * Delegates to BridgeServer.getRoutes() which provides:
 * - WebSocket endpoints: /extension, /cdp
 * - HTTP API: /tabs, /tabs/:id/screenshot, etc.
 *
 * If BridgeServer is not configured, all routes return 503.
 */

import { Hono } from "hono"
import { getBridgeServer } from "../../browser/bridge"
import { lazy } from "../../util/lazy"

export const BrowserRoutes = lazy(() => {
  const bridge = getBridgeServer()
  if (bridge) {
    return bridge.getRoutes()
  }

  // Fallback: browser control not enabled
  return new Hono().all("/*", (c) => {
    return c.json({ ok: false, error: "Browser control not enabled" }, 503)
  })
})
