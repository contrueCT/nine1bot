import type { BrowserTarget } from "browser-mcp-server"

function toUrl(baseUrl: string, path: string, browser?: BrowserTarget) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`)
  if (browser) {
    url.searchParams.set("browser", browser)
  }
  return url
}

export class BrowserServiceClient {
  constructor(public readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit, browser?: BrowserTarget): Promise<T> {
    const response = await fetch(toUrl(this.baseUrl, path, browser), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    })
    const data = (await response.json().catch(() => ({}))) as Record<string, any>
    if (!response.ok || data.ok === false) {
      throw new Error(String(data.error || response.statusText || `Browser service error (${response.status})`))
    }
    return data as T
  }

  async getStatus() {
    const data = await this.request<{ user: any; bot: any }>("/status")
    return {
      user: data.user,
      bot: data.bot,
    }
  }

  async launchBotBrowser(options?: { headless?: boolean; url?: string }) {
    const data = await this.request<{ success: boolean; message: string }>(
      "/launch",
      {
        method: "POST",
        body: JSON.stringify(options || {}),
      },
    )
    return {
      success: !!data.success,
      message: data.message,
    }
  }

  async snapshot(
    tabId: string,
    options?: { depth?: number; filter?: "all" | "interactive" | "visible"; refId?: string },
    browser?: BrowserTarget,
  ) {
    const data = await this.request<any>(
      `/tabs/${encodeURIComponent(tabId)}/snapshot`,
      {
        method: "POST",
        body: JSON.stringify(options || {}),
      },
      browser,
    )
    return {
      title: data.title,
      url: data.url,
      snapshot: data.snapshot,
    }
  }

  async screenshot(tabId: string, options?: { fullPage?: boolean; format?: "png" | "jpeg" }, browser?: BrowserTarget) {
    const data = await this.request<any>(
      `/tabs/${encodeURIComponent(tabId)}/screenshot`,
      {
        method: "POST",
        body: JSON.stringify(options || {}),
      },
      browser,
    )
    return {
      data: data.data,
      mimeType: data.mimeType,
    }
  }

  async navigate(tabId: string, options: { url?: string; action?: string }, browser?: BrowserTarget) {
    const data = await this.request<any>(
      `/tabs/${encodeURIComponent(tabId)}/navigate`,
      {
        method: "POST",
        body: JSON.stringify(options),
      },
      browser,
    )
    return {
      tabId: data.tabId,
    }
  }

  async clickElement(tabId: string, options: Record<string, unknown>, browser?: BrowserTarget) {
    await this.request(
      `/tabs/${encodeURIComponent(tabId)}/click`,
      {
        method: "POST",
        body: JSON.stringify(options),
      },
      browser,
    )
  }

  async fillForm(tabId: string, ref: string, value: unknown, browser?: BrowserTarget) {
    const data = await this.request<any>(
      `/tabs/${encodeURIComponent(tabId)}/fill`,
      {
        method: "POST",
        body: JSON.stringify({ ref, value }),
      },
      browser,
    )
    return {
      success: !!data.success,
      elementType: data.elementType,
      error: data.error,
    }
  }

  async pressKey(tabId: string, key: string, browser?: BrowserTarget) {
    await this.request(
      `/tabs/${encodeURIComponent(tabId)}/press-key`,
      {
        method: "POST",
        body: JSON.stringify({ key }),
      },
      browser,
    )
  }

  async scroll(
    tabId: string,
    direction: "up" | "down" | "left" | "right",
    amount?: number,
    ref?: string,
    browser?: BrowserTarget,
  ) {
    await this.request(
      `/tabs/${encodeURIComponent(tabId)}/scroll`,
      {
        method: "POST",
        body: JSON.stringify({ direction, amount, ref }),
      },
      browser,
    )
  }

  async waitForText(tabId: string, text: string, timeout?: number, browser?: BrowserTarget) {
    const data = await this.request<{ found: boolean }>(
      `/tabs/${encodeURIComponent(tabId)}/wait`,
      {
        method: "POST",
        body: JSON.stringify({ text, timeout }),
      },
      browser,
    )
    return !!data.found
  }

  async handleDialog(action: "accept" | "dismiss", promptText?: string, browser?: BrowserTarget) {
    await this.request(
      "/dialog",
      {
        method: "POST",
        body: JSON.stringify({ action, promptText }),
      },
      browser,
    )
  }

  async findElements(tabId: string, query: string, browser?: BrowserTarget) {
    const data = await this.request<{ matches: any[] }>(
      `/tabs/${encodeURIComponent(tabId)}/find`,
      {
        method: "POST",
        body: JSON.stringify({ query }),
      },
      browser,
    )
    return data.matches || []
  }

  async uploadFile(tabId: string, ref: string, filePath: string, browser?: BrowserTarget) {
    await this.request(
      `/tabs/${encodeURIComponent(tabId)}/upload`,
      {
        method: "POST",
        body: JSON.stringify({ ref, filePath }),
      },
      browser,
    )
  }

  async evaluate(tabId: string, expression: string, browser?: BrowserTarget) {
    const data = await this.request<{ result: unknown }>(
      `/tabs/${encodeURIComponent(tabId)}/evaluate`,
      {
        method: "POST",
        body: JSON.stringify({ expression }),
      },
      browser,
    )
    return data.result
  }

  async readConsoleMessages(
    tabId: string,
    options?: { sampleMs?: number; max?: number; sinceMs?: number; level?: string },
    browser?: BrowserTarget,
  ) {
    const data = await this.request<{ entries: any[] }>(
      `/tabs/${encodeURIComponent(tabId)}/diagnostics/console`,
      {
        method: "POST",
        body: JSON.stringify(options || {}),
      },
      browser,
    )
    return data.entries || []
  }

  async readNetworkRequests(
    tabId: string,
    options?: { sampleMs?: number; max?: number; sinceMs?: number; resourceType?: string },
    browser?: BrowserTarget,
  ) {
    const data = await this.request<{ entries: any[] }>(
      `/tabs/${encodeURIComponent(tabId)}/diagnostics/network`,
      {
        method: "POST",
        body: JSON.stringify(options || {}),
      },
      browser,
    )
    return data.entries || []
  }
}
