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
  if (bridge && "getRoutes" in bridge) {
    return bridge.getRoutes()
  }

  const serviceUrl = process.env.BROWSER_SERVICE_URL
  if (serviceUrl) {
    return new Hono().all("/*", async (c) => {
      const url = new URL(c.req.url)
      const pathname = url.pathname.replace(/^\/browser/, "") || "/"
      const target = new URL(pathname + url.search, `${serviceUrl.replace(/\/$/, "")}/`)
      const headers = new Headers(c.req.raw.headers)
      headers.delete("host")
      return fetch(target, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        // @ts-expect-error Bun accepts duplex for streaming request bodies.
        duplex: "half",
      })
    })
  }

  // Fallback: browser control not enabled
  return new Hono().all("/*", (c) => {
    return c.json({ ok: false, error: "Browser control not enabled" }, 503)
  })
})
