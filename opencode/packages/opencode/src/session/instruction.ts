import path from "path"
import os from "os"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Project } from "../project/project"
import { ProjectEnvironment } from "../project/environment"
import { ProjectSharedFiles } from "../project/shared-files"
import { Flag } from "@/flag/flag"
import { Log } from "../util/log"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "instruction" })

// Nine1Bot 偏好缓存
let cachedPreferencesPrompt: string = ''
let preferencesLastLoadTime: number = 0
const PREFERENCES_CACHE_TTL = 10000 // 10秒缓存

async function loadNine1BotPreferences(): Promise<string> {
  const now = Date.now()

  // 检查缓存是否有效
  if (cachedPreferencesPrompt !== '' && now - preferencesLastLoadTime < PREFERENCES_CACHE_TTL) {
    return cachedPreferencesPrompt
  }

  const preferencesPath = process.env.NINE1BOT_PREFERENCES_PATH
  if (!preferencesPath) {
    // 回退到旧的环境变量方式
    return process.env.NINE1BOT_PREFERENCES_PROMPT || ''
  }

  try {
    const file = Bun.file(preferencesPath)
    if (!await file.exists()) {
      cachedPreferencesPrompt = ''
      preferencesLastLoadTime = now
      return ''
    }

    const content = await file.text()
    const data = JSON.parse(content)
    if (!data.preferences?.length) {
      cachedPreferencesPrompt = ''
      preferencesLastLoadTime = now
      return ''
    }

    const items = data.preferences.map((p: any, i: number) => `${i + 1}. ${p.content}`).join('\n')
    cachedPreferencesPrompt = `<user-preferences>
以下是用户设置的偏好，请在回复中遵循这些偏好：

${items}

这些偏好由用户明确设置，优先级高于默认行为。
</user-preferences>`
    preferencesLastLoadTime = now
    return cachedPreferencesPrompt
  } catch (e) {
    log.warn("Failed to load Nine1Bot preferences", { error: e })
    // 返回旧缓存或空字符串
    return cachedPreferencesPrompt || process.env.NINE1BOT_PREFERENCES_PROMPT || ''
  }
}

const FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md", // deprecated
]

function globalFiles() {
  const files = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  if (Flag.OPENCODE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }
  return files
}

async function resolveRelative(instruction: string): Promise<string[]> {
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.OPENCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR).catch(() => [])
}

async function projectContextPrompt() {
  const liveProject = await Project.get(Instance.project.id).catch(() => Instance.project)
  const rootDirectory = liveProject.rootDirectory || liveProject.worktree
  const fileDirectory = ProjectSharedFiles.dir(rootDirectory)
  const envKeys = await ProjectEnvironment.listKeys(liveProject.id).catch(() => [] as string[])
  const sharedFiles = await ProjectSharedFiles.list(rootDirectory).catch(() => [] as Awaited<ReturnType<typeof ProjectSharedFiles.list>>)

  const lines: string[] = []
  lines.push("<project-context>")
  lines.push(`Project root directory: ${rootDirectory}`)

  if (liveProject.instructions?.trim()) {
    lines.push("")
    lines.push("Project instructions:")
    lines.push(liveProject.instructions.trim())
  }

  if (envKeys.length > 0) {
    lines.push("")
    lines.push("Project environment variables available by key (values are hidden):")
    for (const key of envKeys) {
      lines.push(`- ${key}`)
    }
  }

  lines.push("")
  lines.push(`Project shared files directory: ${fileDirectory}`)
  if (sharedFiles.length > 0) {
    lines.push("Shared files:")
    for (const item of sharedFiles.slice(0, 200)) {
      lines.push(`- ${item.relativePath}`)
    }
    if (sharedFiles.length > 200) {
      lines.push(`- ... and ${sharedFiles.length - 200} more`)
    }
  } else {
    lines.push("Shared files: (none)")
  }
  lines.push("Use the Read tool with file paths to load file contents when needed.")
  lines.push("</project-context>")

  return lines.join("\n")
}

export namespace InstructionPrompt {
  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((p) => paths.add(path.resolve(p)))
          break
        }
      }
    }

    for (const file of globalFiles()) {
      if (await Bun.file(file).exists()) {
        paths.add(path.resolve(file))
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await Array.fromAsync(
              new Bun.Glob(path.basename(instruction)).scan({
                cwd: path.dirname(instruction),
                absolute: true,
                onlyFiles: true,
              }),
            ).catch(() => [])
          : await resolveRelative(instruction)
        matches.forEach((p) => paths.add(path.resolve(p)))
      }
    }

    return paths
  }

  export async function system() {
    const config = await Config.get()
    const paths = await systemPaths()

    const files = Array.from(paths).map(async (p) => {
      const content = await Bun.file(p)
        .text()
        .catch(() => "")
      return content ? "Instructions from: " + p + "\n" + content : ""
    })

    const urls: string[] = []
    if (config.instructions) {
      for (const instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
        }
      }
    }
    const fetches = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )

    const result = await Promise.all([...files, ...fetches]).then((result) => result.filter(Boolean))

    // 注入 Nine1Bot 用户偏好（使用定时缓存）
    const preferencesPrompt = await loadNine1BotPreferences()
    if (preferencesPrompt) {
      result.push(preferencesPrompt)
    }

    const projectPrompt = await projectContextPrompt()
    if (projectPrompt) {
      result.push(projectPrompt)
    }

    return result
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Bun.file(filepath).exists()) return filepath
    }
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string) {
    const system = await systemPaths()
    const already = loaded(messages)
    const results: { filepath: string; content: string }[] = []

    let current = path.dirname(path.resolve(filepath))
    const root = path.resolve(Instance.directory)

    while (current.startsWith(root)) {
      const found = await find(current)
      if (found && !system.has(found) && !already.has(found)) {
        const content = await Bun.file(found)
          .text()
          .catch(() => undefined)
        if (content) {
          results.push({ filepath: found, content: "Instructions from: " + found + "\n" + content })
        }
      }
      if (current === root) break
      current = path.dirname(current)
    }

    return results
  }
}
