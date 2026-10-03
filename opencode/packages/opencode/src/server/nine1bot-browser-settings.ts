import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import z from "zod"
import { ChromeExecutablePathPattern } from "../../../../../packages/nine1bot/src/config/schema"
import { loadConfig } from "../../../../../packages/nine1bot/src/config/loader"
import { detectChromeExecutable } from "../../../../../packages/browser-mcp-server/src/core/chrome"
import { JsonFile } from "../util/json-file"
import { getBridgeServer } from "../browser/bridge"

// Keep HTTP/OpenAPI schemas on the runtime's local Zod version. Business validation
// still runs through the startup loader before any source file is committed.
export const BrowserSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  cdpPort: z.number().int().min(1).max(65535).optional(),
  autoLaunch: z.boolean().optional(),
  headless: z.boolean().optional(),
  executablePath: z.string().trim().min(1).regex(ChromeExecutablePathPattern).nullable().optional(),
}).strict()

export async function readBrowserSettings() {
  const path = process.env.NINE1BOT_CONFIG_PATH
  const effective = await loadConfig(path)
  const { sidepanel: _, ...settings } = effective.browser
  return { settings, writable: Boolean(path), modelConfigured: typeof effective.model === "string" && /^[^/]+\/.+/.test(effective.model) }
}

export async function patchBrowserSettings(input: unknown) {
  const patch = BrowserSettingsPatch.parse(input)
  const path = process.env.NINE1BOT_CONFIG_PATH
  if (!path) throw new Error("No config path")
  // Browser settings are launcher-only and never copied into runtime OpenCode config.
  await JsonFile.update(path, async (draft) => {
    draft.browser ??= {}
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) draft.browser[key] = value
    }
    // Resolve env expressions only for validation; preserve source expressions verbatim.
    await loadConfig(path, draft)
  })
  return { ...(await readBrowserSettings()), restartRequired: true }
}

export async function inspectChromeExecutable(configured?: string) {
  const executablePath = configured || detectChromeExecutable()
  if (!executablePath) return { state: "missing" as const, message: "未找到 Chrome。请安装 Chrome，或填写服务器上的可执行文件绝对路径。" }
  try {
    if (!(await stat(executablePath)).isFile()) return { state: "invalid" as const, message: "所选路径不是文件，请选择 Chrome 可执行文件。" }
    await access(executablePath, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return { state: "available" as const, message: "可执行文件存在；尚未验证 Chrome 能否成功启动。" }
  } catch {
    return { state: "invalid" as const, message: "无法访问或执行所选文件。请检查服务器上的路径和执行权限。" }
  }
}

/** Read-only checks: no Chrome launch, inference request, or credential disclosure. */
export async function browserReadiness() {
  const saved = await readBrowserSettings()
  const bridge = getBridgeServer()
  let status: any = null
  let statusError = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (bridge) status = await Promise.race([
      bridge.getStatus(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Browser status timed out")), 3000) }),
    ])
  } catch { statusError = true } finally { clearTimeout(timer) }
  return {
    ...saved,
    chrome: await inspectChromeExecutable(saved.settings.executablePath),
    bridge: bridge ? "active" : "inactive",
    bot: statusError ? "unknown" : status?.bot?.running ? "running" : "stopped",
    extension: statusError ? "unknown" : status?.user?.connected ? "connected" : "disconnected",
    issues: status?.runtime?.issues ?? [],
    restartRequired: Boolean(bridge) !== saved.settings.enabled || (status?.runtime?.configuration
      ? ["cdpPort", "autoLaunch", "headless", "executablePath"].some(key => status.runtime.configuration[key] !== saved.settings[key as keyof typeof saved.settings])
      : false),
    modelVerification: "not-tested",
  }
}
