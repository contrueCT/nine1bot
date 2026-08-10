import { readFile, writeFile } from "fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import z from "zod"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"

export const BrowserExtensionModel = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
})
export type BrowserExtensionModel = z.infer<typeof BrowserExtensionModel>

export const BrowserExtensionConfigPatch = z.object({
  model: BrowserExtensionModel.nullable().optional(),
  prompt: z.string().nullable().optional(),
  mcpServers: z.array(z.string()).nullable().optional(),
  skills: z.array(z.string()).nullable().optional(),
  registeredTools: z.array(z.string()).nullable().optional(),
})
export type BrowserExtensionConfigPatch = z.infer<typeof BrowserExtensionConfigPatch>

export interface BrowserExtensionConfig {
  model?: BrowserExtensionModel
  prompt?: string
  mcpServers?: string[]
  skills?: string[]
  registeredTools?: string[]
}

export function isBrowserExtensionEntry(entry?: RuntimeControllerProtocol.Entry): boolean {
  return entry?.source === "browser-extension" || entry?.mode === "browser-sidepanel"
}

function configPath() {
  return process.env.NINE1BOT_CONFIG_PATH || ""
}

async function readNine1botConfig(pathname: string): Promise<Record<string, any>> {
  const text = await readFile(pathname, "utf-8")
  return (parseJsonc(text) || {}) as Record<string, any>
}

async function writeNine1botConfig(pathname: string, nextConfig: Record<string, any>) {
  await writeFile(pathname, JSON.stringify(nextConfig, null, 2))
}

function parseModelString(value: unknown): BrowserExtensionModel | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed.includes("/")) return undefined
  const [providerID, ...modelParts] = trimmed.split("/")
  const modelID = modelParts.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function formatModelString(model: BrowserExtensionModel) {
  return `${model.providerID}/${model.modelID}`
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
}

function normalizeBrowserExtensionConfig(config: Record<string, any>): BrowserExtensionConfig {
  const sidepanel = config.browser?.sidepanel
  if (!sidepanel || typeof sidepanel !== "object" || Array.isArray(sidepanel)) return {}

  const model = parseModelString(sidepanel.model)
  const prompt = typeof sidepanel.prompt === "string" && sidepanel.prompt.trim()
    ? sidepanel.prompt
    : undefined
  const mcpServers = normalizeStringList(sidepanel.mcpServers)
  const skills = normalizeStringList(sidepanel.skills)
  const registeredTools = normalizeStringList(sidepanel.registeredTools)

  return {
    ...(model ? { model } : {}),
    ...(prompt ? { prompt } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(registeredTools.length > 0 ? { registeredTools } : {}),
  }
}

export async function readBrowserExtensionConfig(): Promise<BrowserExtensionConfig> {
  const pathname = configPath()
  if (!pathname) return {}
  const config = (await readNine1botConfig(pathname).catch(() => ({}))) as Record<string, any>
  return normalizeBrowserExtensionConfig(config)
}

export async function patchBrowserExtensionConfig(patch: BrowserExtensionConfigPatch): Promise<BrowserExtensionConfig> {
  const pathname = configPath()
  if (!pathname) {
    throw new Error("No config path")
  }

  const existing = (await readNine1botConfig(pathname).catch(() => ({}))) as Record<string, any>
  const browser = existing.browser && typeof existing.browser === "object" && !Array.isArray(existing.browser)
    ? { ...existing.browser }
    : {}
  const sidepanel = browser.sidepanel && typeof browser.sidepanel === "object" && !Array.isArray(browser.sidepanel)
    ? { ...browser.sidepanel }
    : {}

  if ("model" in patch) {
    if (patch.model === null) delete sidepanel.model
    else if (patch.model) sidepanel.model = formatModelString(patch.model)
  }

  if ("prompt" in patch) {
    const prompt = patch.prompt?.trim()
    if (prompt) sidepanel.prompt = prompt
    else delete sidepanel.prompt
  }

  if ("mcpServers" in patch) {
    const mcpServers = normalizeStringList(patch.mcpServers)
    if (mcpServers.length > 0) sidepanel.mcpServers = mcpServers
    else delete sidepanel.mcpServers
  }

  if ("skills" in patch) {
    const skills = normalizeStringList(patch.skills)
    if (skills.length > 0) sidepanel.skills = skills
    else delete sidepanel.skills
  }

  if ("registeredTools" in patch) {
    const registeredTools = normalizeStringList(patch.registeredTools)
    if (registeredTools.length > 0) sidepanel.registeredTools = registeredTools
    else delete sidepanel.registeredTools
  }

  browser.sidepanel = sidepanel
  const nextConfig = {
    ...existing,
    browser,
  }

  await writeNine1botConfig(pathname, nextConfig)
  return normalizeBrowserExtensionConfig(nextConfig)
}
